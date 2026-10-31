// CLI runs the selected real provider. Injected transports are protocol tests only.
import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, release } from 'node:os';
import {
  FIXED_EVALUATIONS,
  assessRun,
  assessScenario,
  observeEvaluation,
  totalCosts,
  evaluationSession,
  EVAL_PARAMETERS,
  EVALUATION_VERSION,
} from '../src/agent/evaluation.ts';
import {
  AgentRuntime,
  AGENT_SYSTEM_PROMPT,
  AGENT_INSTRUCTION_VERSION,
} from '../src/agent/runtime.ts';
import { AGENT_PROTOCOL_VERSION } from '../src/agent/controlProtocol.ts';
import {
  MODEL_PROTOCOL_VERSION,
  MODEL_INSTRUCTION_VERSION,
  MODEL_SYSTEM_PROMPT,
} from '../src/agent/modelProtocol.ts';
import { TASK_CONTEXT_VERSION, CONTEXT_LIMITS } from '../src/agent/taskContext.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { OllamaProvider, localOllamaURL } from '../src/agent/provider.ts';
import {
  DeepSeekProvider,
  DEEPSEEK_ADDRESS,
  DEEPSEEK_MODEL,
  DEEPSEEK_INFERENCE,
} from '../src/agent/providers/deepseek.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function parseEvaluationArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      'skip-real': { type: 'boolean' },
      provider: { type: 'string', default: 'ollama' },
      address: { type: 'string' },
      model: { type: 'string' },
      repeat: { type: 'string', default: '2' },
      case: { type: 'string', multiple: true },
      output: { type: 'string' },
      conditions: { type: 'string' },
      'max-business-requests': { type: 'string' },
      'max-business-ms': { type: 'string' },
    },
  });
  if (!['ollama', 'deepseek'].includes(values.provider))
    throw new Error('provider must be ollama or deepseek');
  if (
    values.provider === 'deepseek' &&
    values.address !== undefined &&
    values.address !== DEEPSEEK_ADDRESS
  )
    throw new Error('DeepSeek evaluation uses the official https://api.deepseek.com only');
  const repetitions = Number(values.repeat);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('repeat must be 1–5');
  const caseIds = [
    ...new Set(values.case?.flatMap((v) => v.split(',')) ?? FIXED_EVALUATIONS.map((c) => c.id)),
  ];
  if (!caseIds.length || caseIds.some((id) => !FIXED_EVALUATIONS.some((c) => c.id === id)))
    throw new Error(`Unknown --case; choose: ${FIXED_EVALUATIONS.map((c) => c.id).join(',')}`);
  const budget = {};
  for (const [flag, key] of [
    ['max-business-requests', 'requests'],
    ['max-business-ms', 'ms'],
  ]) {
    if (values[flag] !== undefined) {
      const value = Number(values[flag]);
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${flag} must be a positive integer`);
      budget[key] = value;
    }
  }
  return {
    help: values.help ?? false,
    skipReal: values['skip-real'] ?? false,
    provider: values.provider,
    address:
      values.provider === 'deepseek'
        ? DEEPSEEK_ADDRESS
        : localOllamaURL(values.address ?? 'http://127.0.0.1:11434'),
    model: values.model ?? (values.provider === 'deepseek' ? DEEPSEEK_MODEL : null),
    conditions: values.conditions ? resolve(values.conditions) : null,
    repetitions,
    budget,
    caseIds,
    output: resolve(
      values.output ??
        `.qa/agent-evaluation-v${EVALUATION_VERSION}-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
    ),
  };
}

export async function evaluationFingerprints(config) {
  async function sources(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? sources(resolve(path, e.name))
            : /\.(ts|vue|mjs)$/.test(e.name)
              ? [resolve(path, e.name)]
              : [],
        ),
      )
    ).flat();
  }
  const paths = [
    ...(await sources(resolve(root, 'src'))),
    ...(await sources(resolve(root, 'scripts'))),
    resolve(root, 'package.json'),
    resolve(root, 'pnpm-lock.yaml'),
  ].sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: hash(await readFile(path)),
    })),
  );
  return {
    algorithm: 'sha256',
    config: hash(JSON.stringify(config)),
    code: hash(JSON.stringify(files)),
    material: hash(JSON.stringify(evaluationSession().frames.map((f) => [f.time, f.rawPoints]))),
    files,
  };
}

export function summarizeEvaluation(record, scenarios) {
  function counts(rows, planned) {
    const completed = rows.filter((r) => r.assessment !== null);
    const passed = completed.filter((r) => r.assessment.passed).length;
    return {
      planned,
      started: rows.length,
      executed: completed.length,
      passed,
      failed: completed.length - passed,
      incomplete: rows.length - completed.length,
      unexecuted: planned - completed.length,
      successRate: completed.length ? passed / completed.length : null,
      ...totalCosts(rows.flatMap((r) => r.turns.map((t) => t.run))),
    };
  }
  return {
    ...counts(record.runs, scenarios.length * record.repetitions),
    groups: Object.fromEntries(
      ['business', 'boundary', 'protection'].map((group) => [
        group,
        counts(
          record.runs.filter((r) => r.group === group),
          scenarios.filter((s) => s.group === group).length * record.repetitions,
        ),
      ]),
    ),
  };
}

export async function runEvaluation(options, dependencies = {}) {
  const scenarios = FIXED_EVALUATIONS.filter((c) => options.caseIds.includes(c.id));
  const deepseek = options.provider === 'deepseek';
  const scripted = !!(dependencies.provider || dependencies.fetch || dependencies.apiKey);
  const legacy = dependencies.modelProtocol === 'legacy-v2';
  const prompt = legacy ? AGENT_SYSTEM_PROMPT : MODEL_SYSTEM_PROMPT;
  const config = {
    evaluationVersion: EVALUATION_VERSION,
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
    modelProtocolVersion: legacy ? '2.0.0' : MODEL_PROTOCOL_VERSION,
    instructionVersion: legacy ? AGENT_INSTRUCTION_VERSION : MODEL_INSTRUCTION_VERSION,
    systemPrompt: { content: prompt, sha256: hash(prompt) },
    parameters: EVAL_PARAMETERS,
    cases: scenarios,
    repetitions: options.repetitions,
    address: options.address,
    provider: options.provider ?? 'ollama',
    model: options.model,
    skipReal: options.skipReal,
    inference: deepseek
      ? DEEPSEEK_INFERENCE
      : { temperature: 0, num_ctx: 16384, num_predict: 2048, stream: false, think: false },
    limits: { rounds: 12, calls: 24, recoveries: 3, timeoutMs: 240000, requestMs: 60000 },
    taskContextVersion: TASK_CONTEXT_VERSION,
    contextLimits: CONTEXT_LIMITS,
    measurementConditions: {
      thermalState: 'unknown',
      powerMode: null,
      modelResidency: null,
      backgroundLoad: null,
      serviceVersion: null,
      modelFingerprint: null,
      ...(options.conditions ? JSON.parse(await readFile(options.conditions, 'utf8')) : {}),
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? null,
      logicalCPUs: cpus().length,
      totalMemoryBytes: totalmem(),
      pnpm: process.env.npm_config_user_agent?.match(/pnpm\/([^ ]+)/)?.[1] ?? null,
    },
  };
  config.businessBudget = options.budget ?? {};
  const record = {
    id: randomUUID(),
    evaluationVersion: EVALUATION_VERSION,
    agentProtocolVersion: AGENT_PROTOCOL_VERSION,
    checkedAt: new Date().toISOString(),
    provider: dependencies.provider?.id ?? (deepseek ? 'deepseek-api' : 'ollama-local'),
    model: options.model,
    address: options.address,
    evidenceKind: scripted ? 'scripted-protocol-only' : 'real-model',
    synthetic: true,
    status: 'not_run',
    plannedCases: scenarios.length,
    repetitions: options.repetitions,
    config,
    fingerprints: await evaluationFingerprints(config),
    headlessViewPorts:
      'actual state application; chart rendering/browser CORS require separate browser evidence',
    runs: [],
    auditFiles: [],
    baseline: null,
    baselinePolicy: {
      status: 'skipped',
      reason: 'fixed_snapshot_summary_unrelated_to_agent_evaluation',
      requests: 0,
    },
    summary: null,
    error: null,
    connectionProbe: { status: 'not_run', scope: 'connection_only_excluded_from_business' },
    checkpoint: null,
    businessBudget: {
      ...config.businessBudget,
      startedAt: null,
      elapsedMs: 0,
      requests: 0,
      stoppedBy: null,
    },
    costs:
      'elapsedMs in milliseconds; rounds count returned model replies; requests include failed attempts; request inputBytes are UTF-8 normalized messages+tools, wireBytes are exact adapter JSON bytes when available, neither is tokens; token totals require every request reported, otherwise null with known subtotal; probe excluded; baseline separate; no estimated fees',
    remoteCI: 'not_run',
  };
  record.summary = summarizeEvaluation(record, scenarios);
  // Reserve a NEW file before any model request. Never overwrite historical records.
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  let sequence = 0;
  async function checkpoint(reason) {
    record.summary = summarizeEvaluation(record, scenarios);
    if (record.baseline)
      record.baseline.costs = totalCosts(
        record.baseline.turns.map((t) => ({
          calls: [],
          elapsedMs: t.elapsedMs,
          usage: {
            ...t.usage,
            reportedRequests: t.usage.inputTokens !== null || t.usage.outputTokens !== null ? 1 : 0,
          },
        })),
      );
    const path = `${options.output}.checkpoint-${String(++sequence).padStart(4, '0')}.json`;
    record.checkpoint = { sequence, reason, path, at: new Date().toISOString() };
    const contents = JSON.stringify(record, null, 2) + '\n';
    await writeFile(path, contents, { flag: 'wx' });
    const temporary = `${options.output}.${record.id}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    try {
      // Windows scanners/watchers can briefly hold the destination open.
      // Retry only sharing/permission errors, with a bounded wait; preserve
      // atomic replacement and never truncate the previous checkpoint.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temporary, options.output);
          break;
        } catch (error) {
          if (
            process.platform !== 'win32' ||
            !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
            attempt >= 5
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } finally {
      // A failed replace must not leave a temp file that masks the original
      // failure with EEXIST when the final checkpoint records the error.
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await dependencies.onCheckpoint?.(structuredClone(record));
  }
  let active;
  let budgetTimer;
  let businessStarted;
  let exitCode = 0;
  const controller = dependencies.controller ?? new AbortController();
  const stopBudget = (reason) => {
    record.businessBudget.stoppedBy ??= reason;
    controller.abort(reason);
    active?.cancel();
  };
  const stop = () => {
    controller.abort('cancelled');
    active?.cancel();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
  try {
    await checkpoint('initialized');
    if (options.skipReal) record.status = 'skipped_model_unavailable';
    else {
      if (!options.model)
        throw new Error(
          'Supply an installed local tools model with --model. No model is assumed or downloaded.',
        );
      const provider =
        dependencies.provider ??
        (deepseek
          ? new DeepSeekProvider(
              dependencies.apiKey ?? process.env.DEEPSEEK_API_KEY,
              options.model,
              dependencies.fetch,
            )
          : new OllamaProvider(options.address, options.model, dependencies.fetch));
      record.status = 'running';
      await checkpoint('before_probe');
      const probeStarted = performance.now();
      record.connectionProbe.status = 'running';
      if (deepseek) record.connectionProbe.requests = 1;
      try {
        const probe = await provider.probe(signal());
        record.connectionProbe.status = 'passed';
        record.connectionProbe.usage = {
          inputTokens: probe?.usage?.inputTokens ?? null,
          outputTokens: probe?.usage?.outputTokens ?? null,
        };
        record.connectionProbe.requests = probe?.requests ?? null;
        if (probe?.response) record.connectionProbe.response = probe.response;
      } catch (error) {
        record.connectionProbe.status = 'failed';
        record.connectionProbe.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        record.connectionProbe.elapsedMs = performance.now() - probeStarted;
      }
      await checkpoint('probe_completed');
      businessStarted = performance.now();
      record.businessBudget.startedAt = new Date().toISOString();
      if (options.budget?.ms)
        budgetTimer = setTimeout(() => stopBudget('business_time_budget'), options.budget.ms);
      for (let repeat = 1; repeat <= options.repetitions; repeat++) {
        for (const scenario of scenarios) {
          controller.signal.throwIfAborted();
          if (
            options.budget?.requests &&
            record.businessBudget.requests >= options.budget.requests
          ) {
            stopBudget('business_request_budget');
            throw new Error('BUSINESS_REQUEST_BUDGET');
          }
          const session = evaluationSession(scenario.id === 'empty');
          const viewState = { time: null, chart: null, applications: 0 };
          const base = createToolRegistry(session, {
            readWorkspace() {
              return { chart: viewState.chart, time: viewState.time };
            },
            seekToTime(time) {
              viewState.time = session.frames.reduce(
                (best, f) => (Math.abs(f.time - time) < Math.abs(best - time) ? f.time : best),
                session.frames[0].time,
              );
              viewState.applications++;
              return { appliedTime: viewState.time };
            },
            setChartView(view) {
              viewState.chart = structuredClone(view);
              viewState.applications++;
              return structuredClone(view);
            },
          });
          const interventions = { injectedFailure: false, intervened: false };
          const registry = {
            ...base,
            execute(name, input) {
              if (
                scenario.id === 'tool_error' &&
                name === 'query_metrics' &&
                !interventions.injectedFailure
              ) {
                interventions.injectedFailure = true;
                return {
                  ok: false,
                  tool: name,
                  error: {
                    code: 'EVAL_INJECTED_FAILURE',
                    message: '固定评测注入的可恢复工具失败，请重新读取。',
                  },
                };
              }
              return base.execute(name, input);
            },
          };
          let turnIndex = 0;
          const instrumented = {
            id: provider.id,
            model: provider.model,
            requestBytes: provider.requestBytes?.bind(provider),
            async complete(request) {
              if (scenario.id === 'failure_recovery' && turnIndex === 0) {
                interventions.injectedFailure = true;
                throw new Error('EVAL_INJECTED_FAILURE');
              }
              const pending = provider.complete(request);
              if (!interventions.intervened && ['cancel', 'recalculate'].includes(scenario.id)) {
                interventions.intervened = true;
                queueMicrotask(() =>
                  scenario.id === 'cancel'
                    ? active.cancel()
                    : session.recalculate({ ...EVAL_PARAMETERS, window: 3 }),
                );
              }
              return pending;
            },
          };
          active = new AgentRuntime({
            limits: scenario.id === 'multi_turn_delivery' ? { timeoutMs: 120000 } : undefined,
            beforeRequest() {
              if (
                options.budget?.requests &&
                record.businessBudget.requests >= options.budget.requests
              ) {
                stopBudget('business_request_budget');
                throw new Error('BUSINESS_REQUEST_BUDGET');
              }
              controller.signal.throwIfAborted();
              record.businessBudget.requests++;
            },
            modelProtocol: dependencies.modelProtocol,
            session,
            registry,
            provider: instrumented,
            onReady() {
              // Headless state application, not browser paint evidence.
              base.readWorkspace();
            },
            async onAudit(audit) {
              const path = `${options.output}.run-${audit.run.id}.audit.json`;
              const contents = JSON.stringify(audit, null, 2) + '\n';
              await writeFile(path, contents, { flag: 'wx' });
              record.auditFiles.push({
                runId: audit.run.id,
                path,
                sha256: createHash('sha256').update(contents).digest('hex'),
              });
            },
          });
          const entry = {
            caseId: scenario.id,
            group: scenario.group,
            repeat,
            turns: [],
            assessment: null,
            interventions,
            viewState,
          };
          record.runs.push(entry);
          await checkpoint('case_started');
          for (const turn of scenario.turns) {
            controller.signal.throwIfAborted();
            const submission = { submittedAt: Date.now(), monotonicAt: performance.now() };
            const run = await active.run(turn.goal, submission);
            const observation = observeEvaluation(
              run,
              { chart: viewState.chart, time: viewState.time },
              base,
            );
            const assessment = assessRun(run, scenario, session, observation, turnIndex);
            entry.turns.push({ run, observation, assessment });
            turnIndex++;
            await checkpoint('turn_completed');
            // The acceptance chain never retries a failed target or proceeds
            // with a different intent after its first failure.
            if (scenario.id === 'multi_turn_delivery' && !assessment.passed) break;
          }
          entry.assessment = assessScenario(entry.turns, scenario, session);
          if (
            (['tool_error', 'failure_recovery'].includes(scenario.id) &&
              !interventions.injectedFailure) ||
            (scenario.group === 'protection' && !interventions.intervened)
          ) {
            entry.assessment.passed = false;
            entry.assessment.failures.push('failure_path_not_exercised');
          }
          await checkpoint('case_completed');
          dependencies.log?.(
            `${scenario.id} #${repeat}: ${entry.assessment.passed ? 'pass' : 'fail'} / ${entry.assessment.calls} calls / ${entry.assessment.elapsedMs} ms`,
          );
        }
      }
      clearTimeout(budgetTimer);
      record.businessBudget.elapsedMs = performance.now() - businessStarted;
      controller.signal.throwIfAborted();
      record.status = scripted ? 'executed_protocol_only' : 'executed_real_model';
    }
  } catch (error) {
    record.status = controller.signal.aborted ? 'cancelled' : 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    exitCode = 1;
  } finally {
    clearTimeout(budgetTimer);
    if (businessStarted !== undefined && !record.businessBudget.elapsedMs)
      record.businessBudget.elapsedMs = performance.now() - businessStarted;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (record.runs.some((r) => !r.assessment?.passed)) exitCode = 1;
    await checkpoint('finished');
  }
  return { record, exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseEvaluationArgs(process.argv.slice(2));
    if (options.help) {
      console.log(
        'pnpm eval:agent:real [--provider ollama|deepseek] [--model <model>] [--case compare|quality] [--repeat 1] [--max-business-requests 12] [--max-business-ms 120000] [--output NEW.json] [--conditions measured-conditions.json] [--skip-real]',
      );
      console.log(
        `Evaluation ${EVALUATION_VERSION}; immutable checkpoints after each turn. --skip-real records zero executed cases. Existing outputs are refused. No model installation/downloads.`,
      );
      console.log(
        'DeepSeek: official endpoint, model defaults to deepseek-flash; Node reads DEEPSEEK_API_KEY from its environment. Never pass keys as CLI arguments. The browser remains local Ollama only.',
      );
    } else {
      const { record, exitCode } = await runEvaluation(options, { log: console.log });
      process.exitCode = exitCode;
      console.log(
        `${record.status}: ${options.output} (${record.summary.passed}/${record.summary.executed}; unexecuted is not a zero success rate)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
