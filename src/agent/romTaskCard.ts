import type { Channel, Joint, PoseFrame } from '../types.ts';
import type { SessionInfo, SessionReference } from '../analysis/session.ts';
import { timeBound } from '../analysis/frameIndex.ts';
import { boolean, enumeration, number, object, validate } from '../analysis/schema.ts';
import type { ToolDefinition, createToolRegistry } from '../analysis/tools.ts';
import { JOINT_KEYS } from '../utils/poseMath.ts';
import { resolveCitation } from './evidenceCatalog.ts';
import type { RunAudit } from './audit.ts';
import { abortable, ProviderResponseError } from './provider.ts';
import type { ModelMessage, ModelProvider } from './provider.ts';
import type { AgentRun, CallRecord } from './runtime.ts';
import type { Interval } from './taskSpec.ts';

export type RomInterval =
  | { mode: 'absolute'; start: number | null; end: number | null }
  | { mode: 'start' | 'end'; seconds: number | null }
  | { mode: 'sampled' };

export interface RomCardInput {
  joint: Joint;
  side: 'left' | 'right' | 'both' | 'midline';
  basis: 'raw' | 'filtered';
  first: RomInterval;
  second: RomInterval;
  chart: RomInterval | { mode: 'cover' };
  report: boolean;
  csv: boolean;
}
type RangeField = 'first' | 'second' | 'chart';
export const ROM_RANGE_LABELS = { first: '统计前段', second: '统计后段', chart: '图表范围' };
export const ROM_SIDE_LABELS = { left: '左侧', right: '右侧', both: '左右侧', midline: '中线' };
export const ROM_INTERVAL_LABELS = {
  absolute: '绝对秒区间',
  start: '采样开头若干秒',
  end: '采样末尾若干秒',
  sampled: '全部采样',
  cover: '覆盖两段',
};

export function emptyRomCard(): RomCardInput {
  return {
    joint: 'knee',
    side: 'both',
    basis: 'filtered',
    first: { mode: 'absolute', start: null, end: null },
    second: { mode: 'absolute', start: null, end: null },
    chart: { mode: 'cover' },
    report: false,
    csv: false,
  };
}

const absolute = object({ mode: enumeration('absolute'), start: number, end: number });
const relative = object({ mode: enumeration('start', 'end'), seconds: number });
const cover = object({ mode: enumeration('cover') });
const draftTool: ToolDefinition = {
  name: 'draft_rom_comparison',
  description: '提交待用户确认的两段 ROM 参数。按用户原话区分绝对秒区间和相对采样边界。',
  inputSchema: object({
    joint: enumeration(...JOINT_KEYS),
    side: enumeration('left', 'right', 'both', 'midline'),
    basis: enumeration('raw', 'filtered'),
    first: { anyOf: [absolute, relative] },
    second: { anyOf: [absolute, relative] },
    chart: { anyOf: [absolute, relative, cover] },
    report: boolean,
    csv: boolean,
  }),
  outputSchema: boolean,
};

function parseDraft(value: unknown): RomCardInput {
  const fields = { ...draftTool.inputSchema.properties };
  if (value && typeof value === 'object') {
    const input = value as Partial<Record<RangeField, RomCardInput['chart']>>;
    for (const field of ['first', 'second', 'chart'] as const) {
      const mode = input[field]?.mode;
      // Use the selected branch for diagnostics such as a missing duration.
      if (mode === 'absolute') fields[field] = absolute;
      else if (mode === 'start' || mode === 'end') fields[field] = relative;
      else if (field === 'chart' && mode === 'cover') fields[field] = cover;
    }
  }
  validate(object(fields), value);
  return value as RomCardInput;
}

function expand(value: RomInterval, range: Interval | null): Interval {
  if (value.mode === 'sampled') {
    if (!range) throw new Error('当前会话没有采样。');
    return range;
  }
  if (value.mode === 'absolute') {
    if (value.start === null) throw new Error('请填写开始秒。');
    if (value.end === null) throw new Error('请填写结束秒。');
    if (!Number.isFinite(value.start) || !Number.isFinite(value.end))
      throw new Error('开始和结束秒必须是有限数值。');
    if (value.start < 0 || value.end <= value.start)
      throw new Error('开始秒须大于等于 0，结束秒须大于开始秒。');
    return [value.start, value.end];
  }
  if (value.seconds === null) throw new Error('请填写时长（秒）。');
  if (!Number.isFinite(value.seconds) || value.seconds <= 0) throw new Error('时长须为正数。');
  if (!range) throw new Error('当前会话没有采样，无法展开相对区间。');
  if (value.seconds > range[1] - range[0])
    throw new Error(`时长超出当前采样范围（${range[0]}–${range[1]} s）。`);
  return value.mode === 'start'
    ? [range[0], Math.min(range[0] + value.seconds, range[1])]
    : [Math.max(range[0], range[1] - value.seconds), range[1]];
}

export function reviewRomCard(
  input: RomCardInput,
  info: SessionInfo,
  frames: readonly PoseFrame[],
) {
  const ranges: Partial<Record<RangeField, Interval>> = {};
  const errors: Partial<Record<RangeField | 'side', string>> = {};
  if ((input.joint === 'spine') !== (input.side === 'midline'))
    errors.side = '脊柱使用中线，其他关节使用左侧、右侧或左右侧。';
  for (const field of ['first', 'second', 'chart'] as const) {
    try {
      const value = input[field];
      const { range } = info;
      let interval: Interval;
      if (value.mode === 'cover') {
        const { first, second } = ranges;
        if (!first || !second) throw new Error('请先填写有效的统计前段和后段。');
        interval = [Math.min(first[0], second[0]), Math.max(first[1], second[1])];
      } else interval = expand(value, range);
      if (!range) throw new Error('当前会话没有采样。');
      if (interval[0] < range[0] || interval[1] > range[1])
        throw new Error(`区间超出当前采样范围（${range[0]}–${range[1]} s）。`);
      if (timeBound(frames, interval[0]) === timeBound(frames, interval[1], true))
        throw new Error('区间内没有采样帧。');
      ranges[field] = interval;
    } catch (error) {
      errors[field] = error instanceof Error ? error.message : String(error);
    }
  }
  const { first, second, chart } = ranges;
  return {
    ranges,
    errors,
    resolved: first && second && chart && !errors.side ? { first, second, chart } : null,
  };
}
export type RomRanges = NonNullable<ReturnType<typeof reviewRomCard>['resolved']>;

export interface RomDraftAudit {
  provider: string;
  model: string;
  reference?: SessionReference;
  startedAt: number;
  elapsedMs: number;
  request: RunAudit['requests'][number];
}

export async function draftRomCard(
  provider: ModelProvider,
  goal: string,
  signal: AbortSignal,
): Promise<{ draft?: RomCardInput; audit: RomDraftAudit }> {
  const started = performance.now();
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        '仅调用 draft_rom_comparison 一次，提交两段 ROM 参数供用户审阅。绝对 A–B 秒写 {mode:"absolute",start:A,end:B}。只有用户明确说采样开头/末尾 N 秒才写 {mode:"start"/"end",seconds:N}。图表覆盖两段写 {mode:"cover"}，明确给了图表秒数则照填。只为用户要求的报告和 CSV 勾选 true，CSV 与图表同区间。不要把绝对秒数换算成相对区间。若要求缺失，不要臆填。',
    },
    { role: 'user', content: goal.trim() },
  ];
  const audit: RomDraftAudit = {
    provider: provider.id,
    model: provider.model,
    startedAt: Date.now(),
    elapsedMs: 0,
    request: { messages, tools: [draftTool] },
  };
  const deadline = AbortSignal.timeout(120_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  try {
    requestSignal.throwIfAborted();
    const reply = await abortable(
      provider.complete({ messages, tools: [draftTool], signal: requestSignal }),
      requestSignal,
    );
    audit.request.reply = reply;
    requestSignal.throwIfAborted();
    const [call] = reply.calls;
    if (reply.calls.length !== 1 || call.name !== draftTool.name)
      throw new Error('模型须返回一份结构化 ROM 草稿。');
    const draft = parseDraft(call.arguments);
    if ((draft.joint === 'spine') !== (draft.side === 'midline'))
      throw new Error('侧别：脊柱使用中线，其他关节使用左侧、右侧或左右侧。');
    return { draft, audit };
  } catch (error) {
    if (requestSignal.aborted)
      audit.request.error =
        typeof requestSignal.reason === 'string'
          ? requestSignal.reason
          : deadline.aborted && requestSignal.reason === deadline.reason
            ? '模型草拟超时。'
            : '模型草拟已取消。';
    else audit.request.error = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderResponseError) audit.request.providerFailure = error.failure;
    return { audit };
  } finally {
    audit.elapsedMs = performance.now() - started;
  }
}

export interface RomConfirmation {
  entry: 'manual' | 'model-draft';
  draft?: RomDraftAudit;
  draftAttempt?: RomDraftAudit;
  previousRunId?: string;
  confirmedAt: number;
  input: RomCardInput;
  reviewed: SessionReference;
}
export interface RomCardExecution extends RomConfirmation {
  resolved?: RomRanges;
  evidenceSource: 'browser-local-workflow';
}

export function executeRomCard(
  tools: ReturnType<typeof createToolRegistry>,
  info: SessionInfo,
  frames: readonly PoseFrame[],
  confirmation: RomConfirmation,
): RunAudit {
  const started = performance.now();
  const id = crypto.randomUUID();
  const run: AgentRun = {
    id,
    goal: '两段 ROM 比较 · 本地任务卡',
    provider: 'browser-local-workflow',
    model: '本地执行',
    status: 'running',
    phase: '读取当前会话',
    reference: info,
    startedAt: Date.now(),
    elapsedMs: 0,
    rounds: 0,
    steps: [],
    calls: [],
    citations: [],
    message: '',
    usage: { inputTokens: null, outputTokens: null, reportedRequests: 0 },
    romCard: { ...confirmation, evidenceSource: 'browser-local-workflow' },
  };
  function call(
    name: string,
    args: unknown,
  ): CallRecord & { output: { ok: true; result: unknown } } {
    const at = performance.now();
    const output = tools.execute(name, args);
    const record = {
      id: `${id.slice(0, 8)}-c${run.calls.length + 1}`,
      name,
      arguments: args,
      output,
      elapsedMs: performance.now() - at,
    };
    run.calls.push(record);
    if (!output.ok) throw new Error(`${name}：${output.error.message}`);
    return { ...record, output };
  }
  function cite(record: ReturnType<typeof call>, paths: string[]) {
    for (const path of paths) {
      run.citations.push({
        callId: record.id,
        path,
        value: resolveCitation(record.output.result, path),
        source: 'browser-local-workflow',
      });
    }
  }
  try {
    const current = call('get_session_info', {}).output.result as SessionInfo;
    run.reference = current;
    const { sessionId, revision } = current;
    if (
      sessionId !== confirmation.reviewed.sessionId ||
      revision !== confirmation.reviewed.revision
    ) {
      run.status = 'stale';
      throw new Error('采样会话在确认时已更新，请重新审阅区间并确认。');
    }
    const input = confirmation.input;
    const review = reviewRomCard(input, current, frames);
    if (!review.resolved)
      throw new Error(
        Object.entries(review.errors)
          .map(
            ([key, error]) =>
              `${key === 'side' ? '侧别' : ROM_RANGE_LABELS[key as RangeField]}：${error}`,
          )
          .join(' '),
      );
    const { first, second, chart } = review.resolved;
    run.romCard!.resolved = review.resolved;
    const selected: Channel[] = input.side === 'both' ? ['left', 'right'] : [input.side];
    const reference = { sessionId, revision };
    const selection = { ...reference, joint: input.joint, channels: selected, basis: input.basis };
    const comparison = call('compare_intervals', { ...selection, first, second });
    cite(
      comparison,
      selected.flatMap((_, i) => [
        `/first/channels/${i}/rom`,
        `/second/channels/${i}/rom`,
        `/differences/${i}/rom`,
      ]),
    );
    cite(call('set_chart_view', { ...selection, interval: chart }), [
      '/view/interval/0',
      '/view/interval/1',
    ]);
    if (input.report)
      cite(call('prepare_report', { ...selection, interval: first, comparison: second }), [
        '/handle',
      ]);
    if (input.csv)
      cite(call('prepare_export', { ...reference, interval: chart, format: 'csv' }), ['/handle']);
    run.status = resolveCitation(comparison.output.result, '/comparable')
      ? 'completed'
      : 'not_comparable';
    run.message = '浏览器已执行确认的参数。';
  } catch (error) {
    if (run.status !== 'stale') run.status = 'failed';
    run.message = error instanceof Error ? error.message : String(error);
  }
  run.phase = '本地执行结束';
  run.elapsedMs = performance.now() - started;
  return {
    version: '1.0.0',
    conversationId: id,
    run,
    tools: tools.definitions.filter((definition) =>
      run.calls.some((c) => c.name === definition.name),
    ),
    requests: [confirmation.draft, confirmation.draftAttempt].flatMap((event) =>
      event ? [event.request] : [],
    ),
  };
}
