// Minimal reusable I2 wire recorder. CLI uses the real installed local provider.
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEvaluationArgs, runEvaluation } from './evaluate-agent.mjs';
import { assessEfficiencySample } from '../src/agent/efficiency.ts';
import { OllamaProvider } from '../src/agent/provider.ts';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

export function screenGate(record) {
  const samples = record.runs.map(assessEfficiencySample);
  const planned = record.plannedCases * record.repetitions;
  return {
    passed:
      record.runs.length === planned &&
      samples.length === planned &&
      record.runs.every((r) => r.assessment?.passed === true) &&
      samples.every((s) => s.status === 'passed'),
    planned,
    executed: record.runs.filter((r) => r.assessment !== null).length,
    correct: record.runs.filter((r) => r.assessment?.passed).length,
    samples,
  };
}

export async function runAgentScreen(options, dependencies = {}) {
  if (options.provider && options.provider !== 'ollama')
    throw new Error('SCREEN_OLLAMA_ONLY：DeepSeek 请使用 scripts/evaluate-agent.mjs。');
  // All sidecars belong to this new output; refuse reuse before any network IO.
  for (const path of [options.output, `${options.output}.runner.json`]) {
    try {
      await lstat(path);
      throw new Error(`OUTPUT_EXISTS: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(options.output), { recursive: true });
  const directory = `${options.output}.http`;
  await mkdir(directory); // exclusive namespace; old raw receipts are never replaced
  const controller = dependencies.controller ?? new AbortController();
  const originalFetch = globalThis.fetch;
  const fetcher = dependencies.fetch ?? originalFetch;
  let phase = 'probe',
    activeCase = null,
    started = null,
    probeStarted = null;
  let business = 0,
    probes = 0,
    timer,
    record,
    exitCode = 1;
  const receipts = [];
  async function residency(name) {
    const path = `${options.output}.${name}`;
    const receipt = { at: new Date().toISOString(), scope: 'metadata', httpStatus: null };
    try {
      const response = await fetcher(`${options.address}/api/ps`, {
        signal: AbortSignal.timeout(5000),
      });
      receipt.httpStatus = response.status;
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(`${path}.body.bin`, bytes, { flag: 'wx' });
      receipt.bytes = bytes.length;
      receipt.sha256 = sha(bytes);
      receipt.responseText = bytes.toString('utf8');
    } catch (error) {
      receipt.error = String(error);
    }
    await save(`${path}.json`, receipt);
  }
  const limits = { requests: options.budget?.requests ?? 40, ms: options.budget?.ms ?? 600000 };
  const stop = (reason) => {
    controller.abort(reason);
    throw new Error(reason);
  };
  globalThis.fetch = async (url, init = {}) => {
    if (!['/api/chat', '/api/generate'].includes(new URL(String(url)).pathname))
      return fetcher(url, init);
    const scope = phase === 'probe' ? 'probe' : 'business';
    if (scope === 'probe') {
      probeStarted ??= performance.now();
      if (probes >= 3 || performance.now() - probeStarted >= 60000) stop('PROBE_BUDGET');
      probes++;
    } else {
      started ??= performance.now();
      timer ??= setTimeout(() => controller.abort('BUSINESS_TIME_BUDGET'), limits.ms);
      if (business >= limits.requests || performance.now() - started >= limits.ms)
        stop('BUSINESS_BUDGET');
      business++;
    }
    const id = receipts.length + 1;
    const prefix = resolve(directory, `http-${String(id).padStart(3, '0')}`);
    const bytes =
      typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : Buffer.from(init.body ?? []);
    const receipt = {
      id,
      scope,
      caseId: scope === 'business' ? activeCase : null,
      url: String(url),
      method: init.method ?? 'GET',
      startedAt: new Date().toISOString(),
      requestBytes: bytes.length,
      requestSha256: sha(bytes),
      httpStatus: null,
      completeResponse: false,
      inputTokens: null,
      outputTokens: null,
    };
    receipts.push(receipt);
    await writeFile(`${prefix}.request.body.bin`, bytes, { flag: 'wx' });
    await save(`${prefix}.request.json`, receipt);
    const begin = performance.now();
    const chunks = [];
    try {
      const remaining =
        scope === 'probe'
          ? 60000 - (performance.now() - probeStarted)
          : limits.ms - (performance.now() - started);
      const response = await fetcher(url, {
        ...init,
        signal: AbortSignal.any([
          ...[init.signal, controller.signal].filter(Boolean),
          AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
        ]),
      });
      receipt.httpStatus = response.status;
      receipt.responseHeaders = Object.fromEntries(response.headers);
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks.push(Buffer.from(chunk.value));
          }
        } finally {
          reader.releaseLock();
        }
      }
      receipt.completeResponse = true;
      const responseBytes = Buffer.concat(chunks);
      try {
        const data = JSON.parse(responseBytes.toString('utf8'));
        receipt.inputTokens = data.prompt_eval_count ?? null;
        receipt.outputTokens = data.eval_count ?? null;
      } catch {
        /* Invalid JSON remains raw evidence with unknown usage. */
      }
      return new Response(responseBytes.length ? responseBytes : null, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      receipt.error = String(error);
      throw error;
    } finally {
      const responseBytes = Buffer.concat(chunks);
      receipt.responseBytes = responseBytes.length;
      receipt.responseSha256 = sha(responseBytes);
      receipt.elapsedMs = performance.now() - begin;
      receipt.completedAt = new Date().toISOString();
      await writeFile(`${prefix}.response.body.bin`, responseBytes, { flag: 'wx' });
      await save(`${prefix}.receipt.json`, receipt);
      dependencies.log?.(
        JSON.stringify({
          id,
          scope,
          caseId: receipt.caseId,
          status: receipt.httpStatus,
          ms: receipt.elapsedMs,
          error: receipt.error,
        }),
      );
    }
  };
  try {
    ({ record, exitCode } = await runEvaluation(
      { ...options, budget: limits },
      {
        controller,
        log: dependencies.log,
        ...(dependencies.fetch
          ? { provider: new OllamaProvider(options.address, options.model, globalThis.fetch) }
          : {}),
        async onCheckpoint(snapshot) {
          record = snapshot;
          if (snapshot.checkpoint.reason === 'probe_completed') {
            phase = 'business';
            await residency('residency-after-probe');
          }
          if (snapshot.checkpoint.reason === 'case_started')
            activeCase = snapshot.runs.at(-1).caseId;
          await dependencies.onCheckpoint?.(snapshot);
          if (
            snapshot.checkpoint.reason === 'case_completed' &&
            snapshot.runs.filter((r) => r.assessment !== null).length ===
              snapshot.plannedCases * snapshot.repetitions &&
            !screenGate(snapshot).passed
          )
            throw new Error('SCREEN_GATE_FAILED_STOP');
        },
      },
    ));
    return { record, exitCode, gate: screenGate(record), receipts };
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    if (!options.skipReal && options.model) await residency('residency-after');
    const costs = (scope) => {
      const rows = receipts.filter((r) => r.scope === scope);
      const tokens = (key) =>
        rows.every((r) => r[key] !== null) ? rows.reduce((n, r) => n + r[key], 0) : null;
      return {
        requests: rows.length,
        elapsedMs: rows.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
        inputTokens: tokens('inputTokens'),
        outputTokens: tokens('outputTokens'),
        knownInputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
        knownOutputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      };
    };
    await save(`${options.output}.runner.json`, {
      at: new Date().toISOString(),
      exitCode,
      status: record?.status ?? 'failed',
      error: record?.error ?? null,
      limits,
      probeLimits: { requests: 3, ms: 60000 },
      costs: { probe: costs('probe'), business: costs('business') },
      wallSinceFirstBusinessMs: started === null ? null : performance.now() - started,
      gate: record ? screenGate(record) : null,
      receipts,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseEvaluationArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        'node scripts/run-agent-screen.mjs --model <installed> --case compare,multi_turn,quality,export --repeat 1 --max-business-requests 40 --max-business-ms 600000 [--conditions measured.json] --output NEW.json',
      );
    else {
      const result = await runAgentScreen(options, { log: console.log });
      console.log(JSON.stringify({ status: result.record.status, gate: result.gate }));
      process.exitCode = result.exitCode || (result.gate.passed ? 0 : 1);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
