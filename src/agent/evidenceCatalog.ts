import type { AgentRun, Citation } from './runtime.ts';
import type { SessionReference } from '../analysis/session.ts';

export const EVIDENCE_CATALOG_VERSION = '1.2.0';
export const MAX_CATALOG_ENTRIES = 128;
export const MAX_CATALOG_ARRAY_ITEMS = 8;
export const MAX_CATALOG_STRING_LENGTH = 512;
export interface CatalogEntry {
  evidenceId: string;
  kind: 'fact' | 'artifact_handle';
  label: string;
  value: Citation['value'];
  // Audit-only. Never required in model arguments or sent as a pointer recipe.
  path: string;
}
export interface EvidenceCatalog {
  version: typeof EVIDENCE_CATALOG_VERSION;
  entries: CatalogEntry[];
  truncated: boolean;
}

// Own scalar properties only; never evaluate a model-supplied expression.
export function resolveCitation(value: unknown, pointer: string): Citation['value'] {
  if (!pointer.startsWith('/') || pointer.length > 200) throw new Error('INVALID_CITATION_PATH');
  let current: any = value;
  for (const token of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(token)) throw new Error('INVALID_CITATION_PATH');
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    )
      throw new Error('INVALID_CITATION_PATH');
    current = current[key];
  }
  if (current !== null && !['string', 'number', 'boolean'].includes(typeof current))
    throw new Error('CITATION_MUST_BE_SCALAR');
  if (typeof current === 'number' && !Number.isFinite(current))
    throw new Error('CITATION_MUST_BE_FINITE');
  return current;
}

// Reserve the existing bounded directory for the selected sides before long
// metadata or interval lists. These are paths to real output scalars, not facts
// synthesized for the model. Full traversal still follows within the same cap.
function localQualityPaths(result: any): string[] {
  const paths: string[] = [];
  if (typeof result?.handle === 'string') paths.push('/handle');
  for (const prefix of ['', '/quality', '/comparisonQuality']) {
    const value = prefix ? result?.[prefix.slice(1)] : result;
    const selected = value?.selection;
    if (!Array.isArray(selected?.channels)) continue;
    paths.push(`${prefix}/selection/joint`, `${prefix}/selection/basis`);
    for (const field of [
      'channel',
      'validSamples',
      'coverage',
      'invalidSamples',
      'notDetectedSamples',
      'unusableSamples',
      'longestMissingInterval/interval/0',
      'longestMissingInterval/interval/1',
      'longestMissingInterval/samples',
      'validIntervals/0/interval/0',
      'validIntervals/0/interval/1',
      'validIntervalCount',
      'missingIntervalCount',
      'omittedValidIntervals',
      'omittedMissingIntervals',
    ])
      for (let i = 0; i < Math.min(selected.channels.length, 2); i++)
        paths.push(`${prefix}/selection/channels/${i}/${field}`);
  }
  // Source-time events are deeper than aggregate statistics. Keep their real
  // values discoverable even when a two-interval result fills the directory.
  for (const [prefix, value] of [
    ['', result],
    ['/first', result?.first],
    ['/second', result?.second],
    ['/facts', result?.facts],
    ['/comparison/first', result?.comparison?.first],
    ['/comparison/second', result?.comparison?.second],
  ] as const)
    if (Array.isArray(value?.channels)) {
      paths.push(`${prefix}/units/angle`, `${prefix}/evidence/limitations/0`);
      for (let i = 0; i < Math.min(value.channels.length, 2); i++) {
        paths.push(`${prefix}/channels/${i}/angle/sampleCount`);
        for (const event of ['minimum', 'maximum'])
          for (const field of ['time', 'value'])
            paths.push(`${prefix}/channels/${i}/events/${event}/${field}`);
      }
    }
  return paths;
}

// A fresh directory is created for each run, including same-session turns.
// Historical feedback is data only: no bindings are imported from it.
export class RunEvidenceDirectory {
  private readonly bindings = new Map<
    string,
    { callId: string; path: string; value: Citation['value'] }
  >();
  private readonly runId: string;
  private readonly reference: SessionReference;
  constructor(runId: string, reference: SessionReference) {
    this.runId = runId;
    this.reference = { sessionId: reference.sessionId, revision: reference.revision };
  }

  add(callId: string, result: unknown): EvidenceCatalog {
    const catalog: EvidenceCatalog = {
      version: EVIDENCE_CATALOG_VERSION,
      entries: [],
      truncated: false,
    };
    // Breadth first keeps top-level facts ahead of long lists. Each array has a
    // visible prefix; the full successful result remains in the audit record.
    const queue: { value: unknown; path: string }[] = [];
    for (const path of localQualityPaths(result)) {
      try {
        queue.push({ value: resolveCitation(result, path), path });
      } catch {
        // Nullable/empty intervals have no endpoints to register.
      }
    }
    queue.push({ value: result, path: '' });
    const visited = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const { value, path } = queue[i];
      if (visited.has(path)) continue;
      visited.add(path);
      if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        if (Array.isArray(value) && keys.length > MAX_CATALOG_ARRAY_ITEMS) catalog.truncated = true;
        for (const key of Array.isArray(value) ? keys.slice(0, MAX_CATALOG_ARRAY_ITEMS) : keys) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
          const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
          if (childPath.length > 200) {
            catalog.truncated = true;
            continue;
          }
          queue.push({ value: (value as Record<string, unknown>)[key], path: childPath });
        }
      } else if (
        path &&
        (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      ) {
        if (typeof value === 'number' && !Number.isFinite(value)) continue;
        if (typeof value === 'string' && value.length > MAX_CATALOG_STRING_LENGTH) {
          catalog.truncated = true;
          continue;
        }
        if (catalog.entries.length >= MAX_CATALOG_ENTRIES) {
          catalog.truncated = true;
          break;
        }
        const evidenceId = `evidence:${crypto.randomUUID()}`;
        this.bindings.set(evidenceId, { callId, path, value: value as Citation['value'] });
        catalog.entries.push({
          evidenceId,
          kind: path === '/handle' ? 'artifact_handle' : 'fact',
          path,
          label: path.slice(1).replaceAll('/', '.'),
          value: value as Citation['value'],
        });
      }
    }
    return catalog;
  }

  resolve(evidenceId: string, run: AgentRun): Citation {
    const binding = this.bindings.get(evidenceId);
    if (
      run.id !== this.runId ||
      !binding ||
      run.reference.sessionId !== this.reference.sessionId ||
      run.reference.revision !== this.reference.revision
    )
      throw new Error(
        'INVALID_EVIDENCE_ID：请选择本轮成功工具反馈 evidenceCatalog 中的 evidenceId；handle 或目录 value 是成果句柄/事实值，不能作为 evidenceId。',
      );
    const call = run.calls.find((c) => c.id === binding.callId);
    if (!call?.output.ok) throw new Error('INVALID_CITATION_CALL');
    const value = resolveCitation(call.output.result, binding.path);
    if (!Object.is(value, binding.value)) throw new Error('EVIDENCE_VALUE_CHANGED');
    return { evidenceId, ...binding, value };
  }
}

export function modelCatalog(catalog: EvidenceCatalog) {
  return { ...catalog, entries: catalog.entries.map(({ path: _, ...entry }) => entry) };
}
