import type { AgentRun, Citation } from './runtime.ts';
import type { SessionReference } from '../analysis/session.ts';

export const EVIDENCE_CATALOG_VERSION = '1.1.0';
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
    const queue = [{ value: result, path: '' }];
    for (let i = 0; i < queue.length; i++) {
      const { value, path } = queue[i];
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
