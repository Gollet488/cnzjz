import {
  array,
  boolean,
  enumeration,
  nullable,
  number,
  object,
  string,
  validate,
} from '../analysis/schema.ts';
import type { ChartView } from '../analysis/tools.ts';
import type { Channel, Joint } from '../types.ts';
import { channels, JOINT_KEYS } from '../utils/poseMath.ts';

export type Interval = [number, number];
export type GoalType = 'metrics' | 'comparison' | 'quality' | 'seek' | 'view' | 'report' | 'export';
export type Metric =
  | 'rom'
  | 'meanAngle'
  | 'peakAbsoluteVelocity'
  | 'coverage'
  | 'minAngle'
  | 'maxAngle'
  | 'angleVariance'
  | 'meanVelocity'
  | 'velocityVariance'
  | 'coordinateVariance';
export interface TaskSpec {
  goalTypes: GoalType[];
  joint: Joint | null;
  channels: Channel[] | null;
  basis: 'raw' | 'filtered' | null;
  interval: Interval | null;
  comparison: { second: Interval; direction: 'second_minus_first' } | null;
  metrics: Metric[];
  time: number | null;
  deliveries: {
    view: ChartView | null;
    report: boolean;
    export: { interval: Interval; format: 'csv' } | null;
  };
  sources: {
    field: string;
    origin: 'explicit' | 'inherited' | 'derived';
    text: string;
    fromRunId: string | null;
  }[];
  unresolved: string[];
}
export interface TaskUnderstanding {
  runId: string;
  goal: string;
  spec: TaskSpec;
  validation: 'structure_and_provenance_only';
}
const fields = [
  'goalTypes',
  'joint',
  'channels',
  'basis',
  'interval',
  'comparison',
  'metrics',
  'time',
  'deliveries',
] as const;
const sourceFieldNames = [
  ...fields,
  'comparison.second',
  'comparison.direction',
  'deliveries.view',
  'deliveries.report',
  'deliveries.export',
  'deliveries.view.joint',
  'deliveries.view.channels',
  'deliveries.view.basis',
  'deliveries.view.interval',
  'deliveries.export.interval',
  'deliveries.export.format',
];
const sourceFields = new Set<string>(sourceFieldNames);
// Only exact protocol paths are reserved. Prose questions remain user data,
// and must never be interpreted as aliases for business or protocol fields.
const protocolFields = new Set([
  'sources',
  'unresolved',
  'sourceId',
  'fromRunId',
  'taskRef',
  'sessionId',
  'revision',
  'source',
  'runId',
  'callId',
  'evidenceId',
  'citations',
  'bindings',
  'userSources',
  'availableEvidence',
]);
function isProtocolPath(path: string): boolean {
  const match = /^(?:\$\.)?([A-Za-z]\w*)(?:\.[A-Za-z]\w*|\[\d+\])*$/.exec(path);
  return !!match && protocolFields.has(match[1]!);
}
const interval = array({ type: 'number', minimum: 0 }, 2, 2);
const selection = {
  joint: enumeration(...JOINT_KEYS),
  channels: array(enumeration('left', 'right', 'midline'), 1, 2),
  basis: enumeration('raw', 'filtered'),
};
export const taskSpecSchema = object({
  goalTypes: array(
    enumeration('metrics', 'comparison', 'quality', 'seek', 'view', 'report', 'export'),
    0,
    7,
  ),
  joint: nullable(selection.joint),
  channels: nullable(selection.channels),
  basis: nullable(selection.basis),
  interval: nullable(interval),
  comparison: nullable(object({ second: interval, direction: enumeration('second_minus_first') })),
  metrics: array(
    enumeration(
      'rom',
      'meanAngle',
      'peakAbsoluteVelocity',
      'coverage',
      'minAngle',
      'maxAngle',
      'angleVariance',
      'meanVelocity',
      'velocityVariance',
      'coordinateVariance',
    ),
    0,
    10,
  ),
  time: nullable({ ...number, minimum: 0 }),
  deliveries: object({
    view: nullable(object({ ...selection, interval })),
    report: boolean,
    export: nullable(object({ interval, format: enumeration('csv') })),
  }),
  sources: array(
    object({
      field: enumeration(...sourceFieldNames),
      origin: enumeration('explicit', 'inherited', 'derived'),
      text: string,
      fromRunId: nullable(string),
    }),
    0,
    30,
  ),
  unresolved: array(string, 0, 20),
});
export const taskUnderstandingSchema = object({
  runId: string,
  goal: string,
  spec: taskSpecSchema,
  validation: enumeration('structure_and_provenance_only'),
});
const covers = (source: string, field: string) =>
  source === field || field.startsWith(`${source}.`);
function fieldValue(spec: TaskSpec, path: string): unknown {
  return path.split('.').reduce<any>((value, key) => value?.[key], spec);
}
function sourceLeaves(value: unknown, path: string): [string, unknown][] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => sourceLeaves(child, `${path}.${key}`))
    : [[path, value]];
}
// JSON object member order is not meaningful across provider wire formats.
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const first = a as Record<string, unknown>,
    second = b as Record<string, unknown>;
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(second).length &&
    keys.every((key) => Object.hasOwn(second, key) && same(first[key], second[key]))
  );
}
export const sameChannels = (a: Channel[], b: Channel[]) => same([...a].sort(), [...b].sort());
// This is a relation between declared fields, not an interpretation of prose.
// Never widen a view or replace either comparison interval on the model's behalf.
function comparisonViewCovered(spec: TaskSpec): boolean {
  const view = spec.deliveries.view;
  return (
    !view ||
    !spec.interval ||
    !spec.comparison ||
    [spec.interval, spec.comparison.second].every(
      ([start, end]) => view.interval[0] <= start && view.interval[1] >= end,
    )
  );
}
export class TaskSpecSourceError extends Error {
  readonly missingSources: string[];
  constructor(missingSources: string[]) {
    super(
      `TASK_SPEC_SOURCE_REQUIRED:${missingSources[0]}：缺少来源的全部字段 ${JSON.stringify(missingSources)}；为这些字段声明用户来源，同源可用父字段覆盖，false 也需来源。保留业务要求，不猜来源。`,
    );
    this.missingSources = missingSources;
  }
}
export function validateTaskSpec(
  value: unknown,
  goal: string,
  previous?: TaskUnderstanding,
  pending: readonly { runId: string; goal: string }[] = [],
): TaskSpec {
  validate(taskSpecSchema, value);
  const spec = structuredClone(value) as TaskSpec;
  for (const list of [spec.goalTypes, spec.metrics, spec.channels ?? []])
    if (new Set(list).size !== list.length) throw new Error('TASK_SPEC_DUPLICATE');
  const checkInterval = (v: Interval | null) => {
    if (v && v[0] > v[1]) throw new Error('TASK_SPEC_INTERVAL_ORDER');
  };
  checkInterval(spec.interval);
  checkInterval(spec.comparison?.second ?? null);
  checkInterval(spec.deliveries.view?.interval ?? null);
  checkInterval(spec.deliveries.export?.interval ?? null);
  if (spec.joint && spec.channels?.some((c) => !channels(spec.joint!).includes(c)))
    throw new Error('TASK_SPEC_CHANNEL');
  const view = spec.deliveries.view;
  if (
    view &&
    (new Set(view.channels).size !== view.channels.length ||
      view.channels.some((c) => !channels(view.joint).includes(c)))
  )
    throw new Error('TASK_SPEC_VIEW_CHANNEL');
  if (new Set(spec.sources.map((s) => s.field)).size !== spec.sources.length)
    throw new Error(
      'TASK_SPEC_SOURCE_DUPLICATE：sources 的每个 field 只提交一次；同源子字段可用一个顶层来源覆盖，混合来源拆分为互不重叠的子字段。',
    );
  for (const source of spec.sources) {
    if (!sourceFields.has(source.field)) throw new Error('TASK_SPEC_SOURCE_FIELD');
    const field = source.field;
    const overlap = spec.sources.find(
      (other) => other !== source && (covers(other.field, field) || covers(field, other.field)),
    );
    if (overlap)
      throw new Error(
        `TASK_SPEC_SOURCE_OVERLAP:${field}:${overlap.field}：sources 不得同时包含父字段和子字段；同源选父字段，混合来源只选互不重叠的子字段。保留业务要求，重新声明来源。`,
      );
    if (source.origin === 'inherited') {
      const prior = previous?.spec.sources.find((s) => covers(s.field, field));
      const userIntent = pending.find((p) => p.runId === source.fromRunId);
      if (userIntent && source.text.trim() && userIntent.goal.includes(source.text)) continue;
      if (
        !previous ||
        source.fromRunId !== previous.runId ||
        !same(fieldValue(spec, field), fieldValue(previous.spec, field)) ||
        !prior ||
        source.text !== prior.text
      )
        throw new Error(
          `TASK_SPEC_INHERITANCE:${field}：inherited 只能引用 previousTask 中相同值及来源和有效 runId，或 pendingUserIntents 的原文及 runId；currentSession 不是 previousTask。根据当前采样范围解释用户相对区间时用 derived，text 逐字引用用户原文，不写计算出的区间。`,
        );
    } else if (source.fromRunId !== null || !source.text.trim() || !goal.includes(source.text)) {
      throw new Error(
        `TASK_SPEC_SOURCE_TEXT:${field}：explicit/derived 的 text 必须从本轮用户原文逐字复制（保留空格和标点），fromRunId 必须为 null。text 是参数来源，不是参数值、翻译、JSON 或解释；derived 也不能编写新原文。`,
      );
    }
  }
  const missingSources = fields
    .flatMap((field) => sourceLeaves(spec[field], field))
    .filter(
      ([field, v]) =>
        v !== null &&
        (!Array.isArray(v) || v.length > 0) &&
        !spec.sources.some((s) => covers(s.field, field)),
    )
    .map(([field]) => field);
  if (missingSources.length) throw new TaskSpecSourceError(missingSources);
  if (!comparisonViewCovered(spec))
    throw new Error(
      'TASK_SPEC_COMPARISON_VIEW_INTERVAL：deliveries.view.interval 必须覆盖 interval 与 comparison.second；保留两段统计区间，按用户要求重新声明视图范围，不用视图或 CSV 范围覆盖统计前段。',
    );
  return spec;
}

// Only conditions implied by the structured task are checked here. This is not
// a natural-language parser or a proof that the model interpreted the user well.
export function validateTaskAnalysis(spec: TaskSpec): void {
  const protocolQuestions = spec.unresolved.filter(isProtocolPath);
  if (protocolQuestions.length)
    throw new Error(
      `TASK_SPEC_UNRESOLVED_PROTOCOL:${JSON.stringify(protocolQuestions)}：这些是内部协议字段，不是用户业务缺参。尚未接受或锁定；从当前 schema、userSources、bindings 或 availableEvidence 核对调用并重新声明。保留真实业务要求与问题，不把协议错误转成用户澄清；本地不会自动清除 unresolved。`,
    );
  if (spec.comparison && !spec.goalTypes.includes('comparison') && !spec.deliveries.report)
    throw new Error(
      'TASK_SPEC_ANALYSIS_CONFLICT：comparison 非空，但 goalTypes 未声明 comparison 且 deliveries.report=false。尚未接受或锁定；请依据用户原意重新声明一致的分析目标与参数。单纯质量/缺失/限制查询不需要比较；用户确实要求的混合比较或比较报告须保留。unresolved 不能解除内部矛盾，也不代表用户缺参。',
    );
  const required = missingTaskFields({ ...spec, unresolved: [] });
  const contradictory = spec.unresolved.filter(
    (field) =>
      sourceFields.has(field) &&
      !required.some((missing) => covers(missing, field) || covers(field, missing)),
  );
  if (contradictory.length)
    throw new Error(
      `TASK_SPEC_UNRESOLVED_CONFLICT:${JSON.stringify(contradictory)}：这些结构化路径不是当前声明任务的必要缺项（未要求或已有值）。尚未接受或锁定；依据用户原意重新声明目标、参数与 unresolved，不把无关字段当用户缺参。真实缺项及自由文本问题仍可声明；本地不会自动清除。`,
    );
}

// A known child question can explain a required nullable parent, e.g. a missing
// comparison.second with comparison=null. Arbitrary prose is not a field alias.
export function declaresTaskMissingField(spec: TaskSpec, field: string): boolean {
  return spec.unresolved.some(
    (question) => question === field || (sourceFields.has(question) && covers(field, question)),
  );
}

export function missingTaskFields(spec: TaskSpec): string[] {
  const missing = [...spec.unresolved];
  if (!comparisonViewCovered(spec)) missing.push('deliveries.view.interval:comparison_coverage');
  if (
    !spec.goalTypes.length &&
    spec.time === null &&
    !spec.deliveries.view &&
    !spec.deliveries.report &&
    !spec.deliveries.export
  )
    missing.push('goalTypes');
  const require = (field: keyof TaskSpec) => {
    if (spec[field] === null || (Array.isArray(spec[field]) && !spec[field].length))
      missing.push(field);
  };
  if (
    spec.goalTypes.some((t) => ['metrics', 'comparison', 'report'].includes(t)) ||
    spec.comparison ||
    spec.deliveries.report
  ) {
    for (const field of ['joint', 'channels', 'basis', 'interval'] as const) require(field);
  }
  if (spec.goalTypes.some((t) => ['metrics', 'comparison'].includes(t)) || spec.comparison)
    require('metrics');
  if (spec.goalTypes.includes('comparison')) require('comparison');
  if (spec.goalTypes.includes('quality')) require('interval');
  if (spec.goalTypes.includes('seek')) require('time');
  if (spec.goalTypes.includes('view') && !spec.deliveries.view) missing.push('deliveries.view');
  if (spec.goalTypes.includes('report') && !spec.deliveries.report)
    missing.push('deliveries.report');
  if (spec.goalTypes.includes('export') && !spec.deliveries.export)
    missing.push('deliveries.export');
  if (
    spec.comparison &&
    spec.metrics.some((m) => !['rom', 'meanAngle', 'peakAbsoluteVelocity'].includes(m))
  )
    missing.push('comparison.metrics:unsupported');
  return [...new Set(missing)];
}
