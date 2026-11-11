import type { SessionInfo, SessionReference } from '../analysis/session.ts';
import type { PoseFrame } from '../types.ts';
import { reviewRomCard } from './romTaskCard.ts';
import type { RomCardInput, RomInterval } from './romTaskCard.ts';
import { missingTaskFields, same, sameChannels, validateTaskSpec } from './taskSpec.ts';
import type { Interval, TaskSpec } from './taskSpec.ts';

export const isRomComparison = (spec: TaskSpec) =>
  !!spec.comparison && spec.metrics.includes('rom');

export interface FreeRomInput extends RomCardInput {
  showChart: boolean;
  linkChart: boolean;
  exportRange: RomInterval;
  separateMetrics: boolean;
  quality: boolean;
  time: number | null;
}

export interface FreeRomReview {
  goal: string;
  parameterSource?: 'local';
  reference: SessionReference;
  proposed: TaskSpec;
  input: FreeRomInput;
}
export interface FreeRomConfirmation {
  input: FreeRomInput;
  reviewed: SessionReference;
  confirmedAt: number;
}

type RangeChoice = RomInterval | { mode: 'cover' };
type DraftRange =
  | Interval
  | 'sampled'
  | 'comparison'
  | { anchor: 'start' | 'end'; seconds: number };
type ConstrainedRanges = {
  interval?: DraftRange;
  first?: DraftRange;
  second?: DraftRange;
  comparison?: { second: DraftRange };
  view?: DraftRange | { interval: DraftRange };
  viewInterval?: DraftRange;
  export?: DraftRange;
};
function rangeChoice(declared: DraftRange | undefined, expanded: Interval): RangeChoice {
  if (declared === 'comparison') return { mode: 'cover' };
  if (declared === 'sampled') return { mode: 'sampled' };
  if (declared && !Array.isArray(declared))
    return { mode: declared.anchor, seconds: declared.seconds };
  return { mode: 'absolute', start: expanded[0], end: expanded[1] };
}

export function freeRomReview(
  goal: string,
  info: SessionInfo,
  spec: TaskSpec,
  modelArguments: unknown,
): FreeRomReview | undefined {
  if (!isRomComparison(spec) || missingTaskFields(spec).length || !info.range) return;
  const { joint, channels, basis, interval, comparison, deliveries } = spec;
  const { view, report, export: csv } = deliveries;
  const raw = modelArguments as ConstrainedRanges & {
    actions?: string[];
    deliveries?: { view?: { interval: DraftRange }; export?: { interval: DraftRange } };
    changes?: { field: string; value: unknown }[] | ConstrainedRanges;
  };
  const changes = Array.isArray(raw.changes) ? raw.changes : undefined;
  const compact = Array.isArray(raw.changes)
    ? undefined
    : (raw.changes ?? (raw.actions ? raw : undefined));
  const declared = (
    path:
      | 'interval'
      | 'comparison.second'
      | 'deliveries.view.interval'
      | 'deliveries.export.interval',
  ): DraftRange | undefined => {
    if (compact) {
      const viewRange =
        compact.view && typeof compact.view === 'object' && 'interval' in compact.view
          ? compact.view.interval
          : compact.view;
      return {
        interval: compact.first ?? compact.interval,
        'comparison.second': compact.second ?? compact.comparison?.second,
        'deliveries.view.interval': compact.viewInterval ?? viewRange,
        'deliveries.export.interval': compact.export,
      }[path];
    }
    const change = changes?.find((c) => path === c.field || path.startsWith(c.field + '.'));
    const root = change ? change.value : raw;
    const suffix = change ? path.slice(change.field.length + 1) : path;
    return (
      suffix ? suffix.split('.').reduce<any>((v, key) => v?.[key], root) : root
    ) as DraftRange;
  };
  const selection = channels!;
  return {
    goal,
    reference: { sessionId: info.sessionId, revision: info.revision },
    proposed: structuredClone(spec),
    input: {
      joint: joint!,
      side: selection.length === 2 ? 'both' : selection[0],
      basis: basis!,
      first: rangeChoice(declared('interval'), interval!) as RomInterval,
      second: rangeChoice(declared('comparison.second'), comparison!.second) as RomInterval,
      chart: view
        ? rangeChoice(declared('deliveries.view.interval'), view.interval)
        : { mode: 'cover' },
      report,
      csv: !!csv,
      showChart: !!view,
      linkChart:
        !view ||
        (joint === view.joint && basis === view.basis && sameChannels(selection, view.channels)),
      exportRange: rangeChoice(
        declared('deliveries.export.interval'),
        csv?.interval ?? [
          Math.min(interval![0], comparison!.second[0]),
          Math.max(interval![1], comparison!.second[1]),
        ],
      ) as RomInterval,
      separateMetrics: spec.goalTypes.includes('metrics'),
      quality: spec.goalTypes.includes('quality'),
      time: spec.time,
    },
  };
}

export function resolveFreeRom(
  input: FreeRomInput,
  info: SessionInfo,
  frames: readonly PoseFrame[],
) {
  const ranges = reviewRomCard(
    { ...input, chart: input.showChart ? input.chart : { mode: 'cover' } },
    info,
    frames,
  );
  const csv = input.csv
    ? reviewRomCard({ ...input, chart: input.exportRange }, info, frames)
    : null;
  const { first, second, chart } = ranges.ranges;
  const chartError =
    first &&
    second &&
    chart &&
    input.showChart &&
    [first, second].some(([a, b]) => chart[0] > a || chart[1] < b)
      ? '图表范围必须覆盖两段统计区间。'
      : ranges.errors.chart;
  const timeError =
    input.time !== null &&
    (!info.range ||
      !Number.isFinite(input.time) ||
      input.time < info.range[0] ||
      input.time > info.range[1])
      ? '定位秒数超出当前采样范围。'
      : undefined;
  return {
    ...ranges,
    chartError,
    csvRange: csv?.ranges.chart,
    csvError: csv?.errors.chart,
    timeError,
  };
}

export function confirmedFreeRomSpec(
  review: FreeRomReview,
  confirmation: FreeRomConfirmation,
  info: SessionInfo,
  frames: readonly PoseFrame[],
  previous: Parameters<typeof validateTaskSpec>[2],
  pending: Parameters<typeof validateTaskSpec>[3],
) {
  if (
    confirmation.reviewed.sessionId !== review.reference.sessionId ||
    confirmation.reviewed.revision !== review.reference.revision ||
    info.sessionId !== review.reference.sessionId ||
    info.revision !== review.reference.revision
  )
    throw new Error('STALE_SESSION');
  const { input } = confirmation;
  const ranges = resolveFreeRom(input, info, frames);
  if (!ranges.resolved || ranges.chartError || ranges.csvError || ranges.timeError)
    throw new Error('ROM_REVIEW_INVALID：请核对区间、定位和成果选项。');
  const { first, second, chart } = ranges.resolved;
  const proposed = review.proposed;
  const sides = input.side === 'both' ? (['left', 'right'] as const) : [input.side];
  const selection = { joint: input.joint, basis: input.basis, channels: [...sides] };
  const chartSelection = input.linkChart ? selection : (proposed.deliveries.view ?? selection);
  const spec: TaskSpec = {
    ...proposed,
    ...selection,
    interval: first,
    comparison: { second, direction: 'second_minus_first' },
    time: input.time,
    goalTypes: [
      ...proposed.goalTypes.filter(
        (type) => !['metrics', 'quality', 'view', 'report', 'export', 'seek'].includes(type),
      ),
      ...(input.separateMetrics ? ['metrics' as const] : []),
      ...(input.quality ? ['quality' as const] : []),
    ],
    deliveries: {
      view: input.showChart ? { ...chartSelection, interval: chart } : null,
      report: input.report,
      export: input.csv ? { format: 'csv', interval: ranges.csvRange! } : null,
    },
  };
  const changes = (
    [
      'goalTypes',
      'joint',
      'channels',
      'basis',
      'interval',
      'comparison',
      'time',
      'deliveries',
    ] as const
  ).filter(
    (key) =>
      !same(spec[key], proposed[key]) &&
      !(key === 'channels' && sameChannels(spec.channels!, proposed.channels!)) &&
      !(key === 'goalTypes' && same([...spec.goalTypes].sort(), [...proposed.goalTypes].sort())),
  );
  if (!changes.length) return proposed;
  // Form edits have their own user source. Keep the original model proposal in the audit.
  const text =
    '任务卡确认 ' + JSON.stringify(Object.fromEntries(changes.map((key) => [key, spec[key]])));
  spec.sources = [
    ...spec.sources.filter(
      (source) =>
        !changes.some((key) => source.field === key || source.field.startsWith(key + '.')),
    ),
    ...changes.map((field) => ({ field, text, origin: 'explicit' as const, fromRunId: null })),
  ];
  return validateTaskSpec(spec, review.goal + '\n' + text, previous, pending);
}
