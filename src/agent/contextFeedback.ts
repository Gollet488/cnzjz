import type { ModelMessage } from './provider.ts';
import type { CallRecord } from './runtime.ts';
import { modelCatalog } from './evidenceCatalog.ts';
import { AGENT_PROTOCOL_VERSION } from './controlProtocol.ts';
import { CONTEXT_LIMITS, jsonBytes } from './taskContext.ts';

// Deterministic, visibly incomplete projection. Values are copied, never
// generated or recomputed. Full output and the full catalog stay in the audit.
function project(value: unknown, depth = 0): unknown {
  if (depth > 12) return { omitted: true };
  if (typeof value === 'string') return value.length > 512 ? { omitted: true } : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((v) => project(v, depth + 1));
    return value.length > 8 ? { items, omittedItems: value.length - 8 } : items;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, project(v, depth + 1)]));
  return value;
}
export function compactFeedback(record: CallRecord, completion?: unknown): ModelMessage {
  let output: unknown = project(record.output);
  if (jsonBytes(output) > CONTEXT_LIMITS.feedbackBytes)
    output = record.output.ok
      ? { ok: true, tool: record.name, result: { omitted: true } }
      : {
          ok: false,
          tool: record.name,
          error: { code: record.output.error.code, message: 'ERROR_DETAILS_OMITTED' },
        };
  return {
    role: 'tool',
    toolName: record.name,
    content: JSON.stringify({
      callId: record.id,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      ...(output as object),
      projection: 'bounded_local_copy',
      ...(record.evidenceCatalog ? { evidenceCatalog: modelCatalog(record.evidenceCatalog) } : {}),
      ...(completion ? { completion } : {}),
    }),
  };
}

// Keep the latest successful result for each tool plus the last two failures.
// Every tool message keeps its matching assistant call. This is current-run
// feedback only; no messages or evidence bindings cross user turns.
export function selectFeedback(calls: CallRecord[], completion?: unknown): ModelMessage[] {
  const latest = new Map<string, CallRecord>();
  const errors: CallRecord[] = [];
  for (const call of calls) {
    if (call.output.ok) latest.set(call.name, call);
    else errors.push(call);
  }
  const selected = new Set([...latest.values(), ...errors.slice(-CONTEXT_LIMITS.recentErrors)]);
  return calls
    .filter((c) => selected.has(c))
    .flatMap((call) => [
      {
        role: 'assistant' as const,
        content: '',
        calls: [{ name: call.name, arguments: call.arguments }],
      },
      compactFeedback(call, call.name === 'finish_analysis' ? completion : undefined),
    ]);
}
