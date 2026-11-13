import { enumeration, object, validate } from '../analysis/schema.ts';
import type { SessionInfo } from '../analysis/session.ts';
import type { ToolDefinition } from '../analysis/tools.ts';
import type { Channel, PoseFrame } from '../types.ts';
import { resolveFreeRom } from './freeRomReview.ts';
import type { FreeRomInput, FreeRomReview } from './freeRomReview.ts';
import type { ModelCall, ModelMessage } from './provider.ts';
import type { RomInterval } from './romTaskCard.ts';
import { applyTaskPatch } from './taskContext.ts';
import type { TaskPatch } from './taskContext.ts';
import { same, sameChannels, validateTaskSpec } from './taskSpec.ts';
import type { TaskSpec, TaskUnderstanding } from './taskSpec.ts';

type Chart = FreeRomInput['chart'];
type Selection = Pick<FreeRomInput, 'joint' | 'side' | 'basis'>;
type Windows = Pick<FreeRomInput, 'first' | 'second'>;
type RomIntent =
  | { kind: 'compare'; selection: Selection; windows: Windows; chart?: Chart }
  | { kind: 'revise'; side?: Selection['side']; windows: Partial<Windows> }
  | { kind: 'deliver'; exportRange: RomInterval; restated?: Selection & Windows };

const decimal = String.raw`\d+(?:\.\d+)?`;
const absolute = String.raw`(?:绝对\s*)?(?:第\s*)?${decimal}\s*[-–—~～至到]\s*(?:第\s*)?${decimal}\s*秒`;
const relative = String.raw`采样(?:开头|末尾)\s*${decimal}\s*秒`;
const window = `(?:${absolute}|${relative})`;
const selection = String.raw`(?<side>左右|双|左|右)(?<joint>膝|髋|肘|肩|踝|腕)(?:关节)?`;
const windows = String.raw`(?<first>${window})\s*(?:与|和)\s*(?<second>${window})`;
const compare = new RegExp(
  String.raw`^比较\s*(?<basis>filtered|raw)\s*${selection}\s*${windows}\s*的\s*ROM(?:\s*[,，]\s*并展示(?<chart>覆盖两段|${absolute})\s*的图表)?[。.]?$`,
  'i',
);
const compareInProse = new RegExp(
  String.raw`^用\s*(?<basis>filtered|raw)\s*口径(?:看|查看)\s*${selection}\s*ROM\s*[:：]\s*(?:比较|对照)\s*${windows}\s*[,，]\s*图表(?:涵盖|覆盖)(?<chart>这?两段)[。.]?$`,
  'i',
);
const revise = new RegExp(
  String.raw`^(?:只看(?<side>左|右)(?<joint>膝|髋|肘|肩|踝|腕|侧)(?:关节)?(?:\s*[,，]\s*|$))?(?:(?<part>第一段|前段|第二段|后段)改(?:成|为)\s*(?<interval>${window}))?[。.]?$`,
);
const reviseInProse = new RegExp(
  String.raw`^改(?:为|用)\s*(?<side>左|右)(?<joint>膝|髋|肘|肩|踝|腕|侧)(?:关节)?\s*[,，]\s*(?<part>后段|第二段)(?:换成|改为)\s*(?<interval>${window})\s*[,，]\s*(?:前段|第一段)照旧[。.]?$`,
);
const deliver = new RegExp(
  String.raw`^(?:准备当前${selection}\s*(?<basis>filtered|raw)\s*${windows}\s*的比较报告|(?:保持比较参数\s*[,，]\s*)?(?:增加|准备)报告)\s*(?:和|及)\s*(?<csv>${absolute})\s*CSV(?:\s*[,，]\s*保持当前最终视图)?[。.]?$`,
  'i',
);
const deliverInProse = new RegExp(
  String.raw`^沿用(?:刚才的|上一轮的)(?:对照|比较)和图表\s*[,，]\s*准备(?:一份)?报告和\s*(?<csv>${absolute})\s*(?:的\s*)?CSV[。.]?$`,
  'i',
);
const joints = {
  膝: 'knee',
  髋: 'hip',
  肘: 'elbow',
  肩: 'shoulder',
  踝: 'ankle',
  腕: 'wrist',
} as const;
const sideOf = (side: string): Selection['side'] =>
  side === '左' ? 'left' : side === '右' ? 'right' : 'both';
const channelsOf = (side: Selection['side']): Channel[] =>
  side === 'both' ? ['left', 'right'] : [side];

function readRange(text: string): RomInterval {
  const [start, end] = text.match(new RegExp(decimal, 'g'))!.map(Number);
  if (text.startsWith('采样'))
    return { mode: text.startsWith('采样开头') ? 'start' : 'end', seconds: start };
  return { mode: 'absolute', start, end };
}

function readSelection(groups: Record<string, string>): Selection {
  return {
    joint: joints[groups.joint as keyof typeof joints],
    side: sideOf(groups.side),
    basis: groups.basis.toLowerCase() as Selection['basis'],
  };
}

// Bind only complete, supported phrases. Other free goals keep their normal
// declaration and task-card/clarification route.
export function parseRomIntent(goal: string, previous?: FreeRomInput): RomIntent | undefined {
  const text = goal.trim();
  if (!previous) {
    const groups = (compare.exec(text) ?? compareInProse.exec(text))?.groups;
    if (!groups) return;
    return {
      kind: 'compare',
      selection: readSelection(groups),
      windows: { first: readRange(groups.first), second: readRange(groups.second) },
      chart: groups.chart?.endsWith('两段')
        ? { mode: 'cover' }
        : groups.chart
          ? readRange(groups.chart)
          : undefined,
    };
  }
  const revision = (revise.exec(text) ?? reviseInProse.exec(text))?.groups;
  if (revision && (revision.side || revision.interval)) {
    if (
      revision.joint &&
      revision.joint !== '侧' &&
      joints[revision.joint as keyof typeof joints] !== previous.joint
    )
      return;
    return {
      kind: 'revise',
      side: revision.side ? sideOf(revision.side) : undefined,
      windows: revision.interval
        ? { [/第一段|前段/.test(revision.part) ? 'first' : 'second']: readRange(revision.interval) }
        : {},
    };
  }
  const delivery = (deliver.exec(text) ?? deliverInProse.exec(text))?.groups;
  if (delivery)
    return {
      kind: 'deliver',
      exportRange: readRange(delivery.csv),
      restated: delivery.joint
        ? {
            ...readSelection(delivery),
            first: readRange(delivery.first),
            second: readRange(delivery.second),
          }
        : undefined,
    };
}

export interface BoundRomIntent {
  kind: RomIntent['kind'];
  review: FreeRomReview;
}

export function bindRomIntent(
  intent: RomIntent,
  goal: string,
  info: SessionInfo,
  frames: readonly PoseFrame[],
  previous?: { task: TaskUnderstanding; input: FreeRomInput },
): BoundRomIntent {
  let input: FreeRomInput;
  if (intent.kind === 'compare') {
    input = {
      ...intent.selection,
      ...intent.windows,
      showChart: !!intent.chart,
      chart: intent.chart ?? { mode: 'cover' },
      linkChart: true,
      report: false,
      csv: false,
      exportRange: { mode: 'absolute', start: null, end: null },
      separateMetrics: false,
      quality: false,
      time: null,
    };
  } else {
    if (!previous) throw new Error('ROM_INTENT_CONTEXT_REQUIRED');
    input = structuredClone(previous.input);
    if (intent.kind === 'revise') {
      Object.assign(input, intent.windows);
      if (intent.side) input.side = intent.side;
    } else {
      input.report = true;
      input.csv = true;
      input.exportRange = intent.exportRange;
    }
  }
  const ranges = resolveFreeRom(input, info, frames);
  if (!ranges.resolved || ranges.chartError || ranges.csvError || ranges.timeError)
    throw new Error(
      'ROM_INTENT_RANGE：' +
        [...Object.values(ranges.errors), ranges.chartError, ranges.csvError, ranges.timeError]
          .filter(Boolean)
          .join(' '),
    );
  const { first, second, chart } = ranges.resolved;
  const { joint, basis } = input;
  const channels = channelsOf(input.side);
  const view = input.showChart
    ? {
        ...(input.linkChart
          ? { joint, basis, channels }
          : (previous?.task.spec.deliveries.view ?? { joint, basis, channels })),
        interval: chart,
      }
    : null;
  const csv = input.csv ? { format: 'csv' as const, interval: ranges.csvRange! } : null;
  const reference = { sessionId: info.sessionId, revision: info.revision };
  let proposed: TaskSpec;
  if (intent.kind === 'compare') {
    const explicit = ['goalTypes', 'joint', 'channels', 'basis', 'metrics', 'deliveries.report'];
    if (view)
      explicit.push('deliveries.view.joint', 'deliveries.view.basis', 'deliveries.view.channels');
    const origins: [string, 'explicit' | 'derived'][] = [
      ...explicit.map((field): [string, 'explicit'] => [field, 'explicit']),
      ['interval', origin(input.first)],
      ['comparison.second', origin(input.second)],
      ['comparison.direction', 'derived'],
    ];
    if (view) origins.push(['deliveries.view.interval', origin(input.chart)]);
    proposed = validateTaskSpec(
      {
        goalTypes: ['comparison'],
        joint,
        channels,
        basis,
        interval: first,
        comparison: { second, direction: 'second_minus_first' },
        metrics: ['rom'],
        time: null,
        deliveries: { view, report: false, export: null },
        sources: origins.map(([field, origin]) => ({ field, origin, text: goal, fromRunId: null })),
        unresolved: [],
      },
      goal,
    );
  } else {
    const prior = previous!.task.spec;
    const changes: TaskPatch['changes'] = [];
    const change = (field: string, value: unknown, origin: 'explicit' | 'derived' = 'explicit') =>
      changes.push({ field, value, origin, text: goal, fromRunId: null });
    if (intent.kind === 'revise') {
      if (intent.side) change('channels', channels);
      if (intent.windows.first) change('interval', first, origin(input.first));
      if (intent.windows.second) change('comparison.second', second, origin(input.second));
      if (view && !sameChannels(view.channels, prior.deliveries.view!.channels))
        change('deliveries.view.channels', view.channels, 'derived');
      if (view && !same(view.interval, prior.deliveries.view!.interval))
        change('deliveries.view.interval', view.interval, origin(input.chart));
    } else {
      if (intent.restated) {
        const restatement = resolveFreeRom({ ...input, ...intent.restated }, info, frames).ranges;
        if (
          joint !== intent.restated.joint ||
          basis !== intent.restated.basis ||
          input.side !== intent.restated.side ||
          !same(first, restatement.first) ||
          !same(second, restatement.second)
        )
          throw new Error('ROM_INTENT_CONFLICT：报告复述的比较参数与已确认任务不同，请核对。');
      }
      change('deliveries.report', true);
      change('deliveries.export', csv);
    }
    proposed = applyTaskPatch({ changes }, goal, previous!.task);
  }
  return {
    kind: intent.kind,
    review: { goal, reference, proposed, input, parameterSource: 'local' },
  };
}

function origin(range: Chart) {
  return range.mode === 'absolute' ? ('explicit' as const) : ('derived' as const);
}

export const ROM_INTENT_PROMPT =
  '调用 review_rom_intent 一次，将用户请求提交到本地 ROM 任务卡。首次比较用 compare，调整比较参数用 revise，追加报告和 CSV 用 deliver。只填写 intent。区间、来源、会话版本和交付参数由本地绑定，用户确认后才执行。';

export const ROM_INTENT_TOOL: ToolDefinition = {
  name: 'review_rom_intent',
  description:
    '选择 compare（首次比较）、revise（调整比较参数）或 deliver（追加报告和 CSV），引用当前请求内唯一的本地候选。',
  inputSchema: object({ intent: enumeration('compare', 'revise', 'deliver') }),
  outputSchema: {},
};

export function romIntentMessages(candidate: BoundRomIntent): ModelMessage[] {
  const { goal, reference, proposed } = candidate.review;
  return [
    { role: 'system', content: ROM_INTENT_PROMPT },
    { role: 'user', content: JSON.stringify({ goal, reference, candidate: proposed }) },
  ];
}

export function verifyRomIntent(
  calls: ModelCall[],
  candidate: BoundRomIntent,
  current: SessionInfo,
) {
  const { reference } = candidate.review;
  if (reference.sessionId !== current.sessionId || reference.revision !== current.revision)
    throw new Error('STALE_SESSION');
  if (calls.length !== 1 || calls[0].name !== ROM_INTENT_TOOL.name)
    throw new Error('ROM_INTENT_CALL_REQUIRED：模型须提交一次结构化 ROM 意图。');
  validate(ROM_INTENT_TOOL.inputSchema, calls[0].arguments);
  if ((calls[0].arguments as { intent: string }).intent !== candidate.kind)
    throw new Error('ROM_INTENT_CONFLICT：模型意图与本轮本地候选不一致。');
}
