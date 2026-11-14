// Optional real-model smoke check. No mock, credentials, model installation or
// application backend. Browser CORS still needs a separate UI verification.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { evaluationSession, FIXED_EVALUATIONS } from '../src/agent/evaluation.ts';
import { AgentRuntime } from '../src/agent/runtime.ts';
import { OllamaProvider, localOllamaURL } from '../src/agent/provider.ts';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    model: { type: 'string' },
    address: { type: 'string', default: 'http://127.0.0.1:11434' },
    output: { type: 'string', default: `.qa/agent-smoke-${Date.now()}-${randomUUID()}.json` },
  },
});

if (values.help || !values.model) {
  console.log(
    'Usage: pnpm test:agent:real --model <installed-local-model> [--address http://127.0.0.1:11434] [--output .qa/task3-real-agent.json]',
  );
  console.log(
    'Runs real Ollama structured calls over explicitly synthetic pose data. No browser CORS proof. No model is downloaded.',
  );
  if (!values.help) process.exitCode = 2;
} else {
  const record = {
    checkedAt: new Date().toISOString(),
    provider: 'ollama-local',
    model: values.model,
    address: 'not_validated',
    synthetic: true,
    browserCORS: 'not_checked',
    status: 'failed',
    runs: [],
    auditFiles: [],
    error: null,
  };
  let agent;
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const cancel = () => {
    controller.abort('cancelled');
    agent?.cancel();
  };
  const controller = new AbortController();
  process.once('SIGINT', cancel);
  const timer = setTimeout(() => controller.abort('timeout'), 60_000);
  try {
    const provider = OllamaProvider.forAgent(values.address, values.model);
    record.address = localOllamaURL(values.address);
    await provider.probe(controller.signal);
    clearTimeout(timer);
    const session = evaluationSession();
    let chart = null;
    let time = null;
    agent = new AgentRuntime({
      session,
      registry: createToolRegistry(session, {
        readWorkspace: () => ({ chart, time }),
        setChartView(view) {
          chart = structuredClone(view);
          return chart;
        },
        seekToTime(target) {
          const frame = session.frames.reduce((nearest, candidate) =>
            Math.abs(candidate.time - target) < Math.abs(nearest.time - target)
              ? candidate
              : nearest,
          );
          time = frame.time;
          return { appliedTime: time };
        },
      }),
      provider,
      async onAudit(audit) {
        const path = `${output}.run-${audit.run.id}.audit.json`;
        await writeFile(path, JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
        record.auditFiles.push({ runId: audit.run.id, path });
      },
      onChange: (run) => {
        if (run.status !== 'running')
          console.log(`${run.status}: ${run.rounds} rounds, ${run.calls.length} calls`);
      },
    });
    for (const scenarioId of ['multi_turn', 'quality']) {
      agent.clear();
      const scenario = FIXED_EVALUATIONS.find(({ id }) => id === scenarioId);
      for (const goal of scenario.goals) {
        if (controller.signal.aborted) throw new Error('cancelled');
        const run = await agent.run(goal);
        record.runs.push(run);
        if (run.status !== 'completed')
          throw new Error(`${scenarioId} did not complete: ${run.status} (${run.message})`);
      }
    }
    const [comparison, modified, quality] = record.runs;
    const argsOf = (run, name) =>
      run.calls.findLast((call) => call.name === name && call.output.ok)?.arguments;
    const first = argsOf(comparison, 'compare_intervals'),
      second = argsOf(modified, 'compare_intervals');
    const last = argsOf(quality, 'get_quality_summary');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (
      !first ||
      !same(first.first, [0, 5]) ||
      !same(first.second, [15, 20]) ||
      !same([...first.channels].sort(), ['left', 'right']) ||
      first.joint !== 'knee' ||
      first.basis !== 'filtered' ||
      !second ||
      !same(second.first, [0, 5]) ||
      !same(second.second, [12, 17]) ||
      !same(second.channels, ['right']) ||
      second.joint !== 'knee' ||
      second.basis !== 'filtered' ||
      !same(chart?.interval, [0, 17]) ||
      !same(chart?.channels, ['right']) ||
      chart.joint !== 'knee' ||
      chart.basis !== 'filtered' ||
      !last ||
      !same(last.interval, [0, 20])
    )
      throw new Error(
        'Structured tool selection or intervals did not meet the requested goals. Inspect recorded calls.',
      );
    record.status = 'passed_real_model_smoke';
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    await writeFile(output, JSON.stringify(record, null, 2) + '\n');
    console.log(`${record.status}: ${output}`);
    if (record.error) console.error(record.error);
  }
}
