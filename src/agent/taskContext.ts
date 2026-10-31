import { enumeration, object, array, string, nullable, validate } from '../analysis/schema.ts';
import type { Schema } from '../analysis/schema.ts';
import type { SessionInfo } from '../analysis/session.ts';
import { same, taskSpecSchema, validateTaskSpec } from './taskSpec.ts';
import type { TaskSpec, TaskUnderstanding } from './taskSpec.ts';

export const TASK_CONTEXT_VERSION = '1.1.0';
export const CONTEXT_LIMITS = {
  turns: 64,
  pendingGoals: 8,
  intentBytes: 32_000,
  requestBytes: 180_000,
  feedbackBytes: 12_000,
  recentErrors: 2,
} as const;
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const leafSchemas: Record<string, Schema> = {};
function collect(schema: Schema, prefix = '') {
  const nested = schema.properties;
  if (nested) {
    for (const [key, child] of Object.entries(nested)) {
      if (['sources', 'unresolved'].includes(key)) continue;
      collect(child, prefix ? `${prefix}.${key}` : key);
    }
  } else {
    // Nullable objects may be replaced or patched one child at a time.
    leafSchemas[prefix] = schema;
    const branch = schema.anyOf?.find((s) => s.type === 'object');
    if (branch) collect(branch, prefix);
  }
}
collect(taskSpecSchema);
export const taskPatchSchema = object({
  changes: array(
    object({
      field: enumeration(...Object.keys(leafSchemas)),
      value: { anyOf: Object.values(leafSchemas) },
      text: string,
      origin: enumeration('explicit', 'derived'),
      fromRunId: nullable(string),
    }),
    0,
    24,
  ),
});
export interface TaskPatch {
  changes: {
    field: string;
    value: unknown;
    text: string;
    origin: 'explicit' | 'derived';
    fromRunId: string | null;
  }[];
}
const covers = (a: string, b: string) => a === b || b.startsWith(`${a}.`);
const read = (spec: TaskSpec, path: string): unknown =>
  path.split('.').reduce<any>((value, key) => value?.[key], spec);
function leaves(value: unknown, path = ''): [string, unknown][] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) =>
        ['sources', 'unresolved'].includes(key) ? [] : leaves(child, path ? `${path}.${key}` : key),
      )
    : [[path, value]];
}

// Merge declared changes locally. Omitted fields, including unresolved questions,
// never disappear as a side effect of a follow-up. No prose summary is involved.
export function applyTaskPatch(
  value: unknown,
  goal: string,
  previous?: TaskUnderstanding,
  pending: readonly { runId: string; goal: string }[] = [],
): TaskSpec {
  validate(taskPatchSchema, value);
  if (!previous) throw new Error('TASK_CONTEXT_REQUIRED：没有可继承规格，请提交 set_task_spec。');
  const patch = value as TaskPatch;
  const spec = structuredClone(previous.spec);
  for (const [index, change] of patch.changes.entries()) {
    if (
      patch.changes.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (covers(other.field, change.field) || covers(change.field, other.field)),
      )
    )
      throw new Error('TASK_PATCH_OVERLAP');
    validate(leafSchemas[change.field], change.value);
    const sourceGoal =
      change.fromRunId === null ? goal : pending.find((p) => p.runId === change.fromRunId)?.goal;
    if (!change.text.trim() || !sourceGoal?.includes(change.text))
      throw new Error('TASK_PATCH_SOURCE_TEXT');
    const keys = change.field.split('.');
    const last = keys.pop()!;
    const target = keys.reduce<any>((node, key) => {
      if (!node[key]) node[key] = {};
      return node[key];
    }, spec);
    target[last] = structuredClone(change.value);
  }
  spec.sources = leaves(spec).flatMap<TaskSpec['sources'][number]>(([field]) => {
    const change = patch.changes.find((c) => covers(c.field, field));
    if (change)
      return [
        {
          field,
          origin: change.fromRunId ? 'inherited' : change.origin,
          text: change.text,
          fromRunId: change.fromRunId,
        },
      ];
    const source = previous.spec.sources.find((s) => covers(s.field, field));
    return source
      ? [{ field, origin: 'inherited' as const, text: source.text, fromRunId: previous.runId }]
      : [];
  });
  // Resolved field questions are removed only by a declared change to that field.
  spec.unresolved = spec.unresolved.filter(
    (field) => !patch.changes.some((c) => covers(c.field, field)),
  );
  return validateTaskSpec(spec, goal, previous, pending);
}

// Full declarations remain supported, but cannot silently drop a prior field.
export function checkTaskRetention(
  spec: TaskSpec,
  previous?: TaskUnderstanding,
  pending: readonly { runId: string }[] = [],
) {
  if (!previous) return;
  for (const [field, value] of leaves(previous.spec)) {
    if (same(value, read(spec, field))) continue;
    if (value === null) continue;
    if (
      !spec.sources.some(
        (s) =>
          covers(s.field, field) &&
          (s.origin !== 'inherited' || pending.some((p) => p.runId === s.fromRunId)),
      )
    )
      throw new Error(`TASK_CHANGE_SOURCE_REQUIRED:${field}`);
  }
}

export function unavailableTaskFields(spec: TaskSpec, session: SessionInfo): string[] {
  const range = session.range;
  const outside = (v: [number, number] | null | undefined) =>
    !!v && (!range || v[0] < range[0] || v[1] > range[1]);
  return [
    ...(outside(spec.interval) ? ['interval'] : []),
    ...(outside(spec.comparison?.second) ? ['comparison.second'] : []),
    ...(outside(spec.deliveries.view?.interval) ? ['deliveries.view.interval'] : []),
    ...(outside(spec.deliveries.export?.interval) ? ['deliveries.export.interval'] : []),
    ...(spec.time !== null && (!range || spec.time < range[0] || spec.time > range[1])
      ? ['time']
      : []),
  ];
}

export class TaskContext {
  private task?: TaskUnderstanding;
  private pending: {
    runId: string;
    goal: string;
    reference: { sessionId: string; revision: number };
  }[] = [];
  private feedback?: { status: string; missing: string[]; omittedMissing: number };
  private reference?: { sessionId: string; revision: number };
  private turns = 0;

  get previousTask() {
    return this.task ? structuredClone(this.task) : undefined;
  }
  snapshot(session: SessionInfo) {
    return structuredClone({
      version: TASK_CONTEXT_VERSION,
      previousTask: this.task ?? null,
      pendingUserIntents: this.pending,
      recentFeedback: this.feedback ?? null,
      evidencePolicy: 'current_run_only',
      referenceChanged:
        !!this.reference &&
        (this.reference.sessionId !== session.sessionId ||
          this.reference.revision !== session.revision),
      unavailableFields: this.task ? unavailableTaskFields(this.task.spec, session) : [],
      turns: this.turns,
    });
  }
  begin(runId: string, goal: string, session: SessionInfo) {
    if (this.turns >= CONTEXT_LIMITS.turns || this.pending.length >= CONTEXT_LIMITS.pendingGoals)
      throw new Error('TASK_CONTEXT_LIMIT：意图保留已达上限；请清空上下文后继续，本地审计仍保留。');
    const next = this.snapshot(session);
    const intent = {
      runId,
      goal,
      reference: { sessionId: session.sessionId, revision: session.revision },
    };
    next.pendingUserIntents.push(intent);
    if (jsonBytes(next) > CONTEXT_LIMITS.intentBytes - 1000)
      throw new Error('TASK_CONTEXT_LIMIT：意图大小已达上限；请清空上下文后继续。');
    this.pending.push(intent);
    this.turns++;
  }
  accept(task: TaskUnderstanding, session: SessionInfo) {
    checkTaskRetention(task.spec, this.task, this.pending);
    const consumed = new Set(task.spec.sources.map((source) => source.fromRunId));
    const pending = this.pending.filter(
      (intent) => intent.runId !== task.runId && !consumed.has(intent.runId),
    );
    if (jsonBytes({ task, feedback: this.feedback, pending }) > CONTEXT_LIMITS.intentBytes - 1000)
      throw new Error('TASK_CONTEXT_LIMIT：规格过大；请缩小本轮要求或清空上下文。');
    this.task = structuredClone(task);
    this.pending = pending;
    this.reference = { sessionId: session.sessionId, revision: session.revision };
  }
  finish(status: string, missing: string[]) {
    this.feedback = {
      status,
      missing: missing.slice(0, 30).map((s) => s.slice(0, 200)),
      omittedMissing: Math.max(0, missing.length - 30),
    };
    while (jsonBytes(this.feedback) > 800 && this.feedback.missing.length) {
      this.feedback.missing.pop();
      this.feedback.omittedMissing++;
    }
  }
}
