import type { Channel, Joint, PoseFrame } from '../types.ts';
import { angleValue, channels, JOINT_KEYS } from '../utils/poseMath.ts';
import { AnalysisSession } from './session.ts';
import { intervalFrames } from './frameIndex.ts';
import { csvHeader } from '../utils/csv.ts';
const CSV_COLUMN_COUNT = csvHeader().length;
import {
  array,
  boolean,
  enumeration,
  integer,
  nullable,
  number,
  object,
  string,
  validate,
  SchemaError,
} from './schema.ts';
import type { Schema, SchemaIssue } from './schema.ts';

const intervalSchema = array({ type: 'number', minimum: 0 }, 2, 2);
const parametersSchema = object({
  threshold: { type: 'number', minimum: 0, maximum: 1 },
  window: { type: 'integer', minimum: 1, maximum: 120 },
  aspect: number,
  metricVersion: enumeration('2.0'),
});
const reference = { sessionId: string, revision: integer };
const acquisitionSchema = nullable(
  object({
    mode: enumeration('webcodecs', 'webcodecs-transcoded'),
    status: enumeration(
      'preparing',
      'running',
      'paused',
      'completed',
      'cancelled',
      'truncated',
      'failed',
    ),
    expectedFrames: nullable(integer),
    processedFrames: integer,
    codec: string,
    rotation: integer,
    mediaTimeOffset: number,
  }),
);
const sessionSchema = object({
  ...reference,
  source: enumeration('demo', 'camera', 'file'),
  synthetic: boolean,
  parameters: parametersSchema,
  range: nullable(intervalSchema),
  sampleCount: integer,
  acquisition: acquisitionSchema,
});
const statsSchema = object({
  min: nullable(number),
  max: nullable(number),
  mean: nullable(number),
  populationVariance: nullable(number),
  sampleCount: integer,
});
const evidenceSchema = object({
  ...reference,
  parameters: parametersSchema,
  source: enumeration('demo', 'camera', 'file'),
  synthetic: boolean,
  interval: intervalSchema,
  basis: enumeration('raw', 'filtered'),
  sampleCount: integer,
  sampledRange: nullable(intervalSchema),
  acquisition: acquisitionSchema,
  limitations: array(string),
});
const metricSchema = object({
  evidence: evidenceSchema,
  joint: enumeration(...JOINT_KEYS),
  channels: array(
    object({
      channel: enumeration('left', 'right', 'midline'),
      angle: statsSchema,
      rom: nullable(number),
      velocity: statsSchema,
      peakAbsoluteVelocity: nullable(number),
      coverage: number,
    }),
    1,
    2,
  ),
  units: object({
    angle: enumeration('deg'),
    velocity: enumeration('deg/s'),
    angleVariance: enumeration('deg²'),
    coordinateVariance: enumeration('normalized_coordinate²'),
  }),
  coordinateVariance: object({
    windows: statsSchema,
    validPointSamples: integer,
    configuredWindowFrames: integer,
    windowInterval: nullable(intervalSchema),
  }),
});
const qualitySchema = object({
  evidence: evidenceSchema,
  detectedSamples: integer,
  missingSamples: integer,
  fullyReliableSamples: integer,
  effectiveRate: number,
  meanConfidence: nullable(number),
  lowConfidenceIntervals: array(object({ interval: intervalSchema, samples: integer }), 0, 100),
  omittedIntervals: integer,
  maxSampleGapSeconds: nullable(number),
});
const compareSchema = object({
  first: metricSchema,
  second: metricSchema,
  comparable: boolean,
  reasons: array(string),
  differences: array(
    object({
      channel: enumeration('left', 'right', 'midline'),
      rom: nullable(number),
      meanAngle: nullable(number),
      peakAbsoluteVelocity: nullable(number),
    }),
    1,
    2,
  ),
  differenceDirection: enumeration('second_minus_first'),
});
const selection = {
  ...reference,
  joint: enumeration(...JOINT_KEYS),
  channels: array(enumeration('left', 'right', 'midline'), 1, 2),
  basis: enumeration('raw', 'filtered'),
};
const chartViewSchema = object({
  joint: selection.joint,
  channels: selection.channels,
  basis: selection.basis,
  interval: intervalSchema,
});
const reportInput = {
  ...selection,
  interval: intervalSchema,
  comparison: nullable(intervalSchema),
};
const reportSchema = object({
  handle: string,
  evidence: evidenceSchema,
  state: enumeration('ready'),
  facts: metricSchema,
  comparison: nullable(compareSchema),
  quality: qualitySchema,
  trends: array(string),
  missing: array(string),
  limitations: array(string),
});
const exportSchema = object({
  handle: string,
  evidence: evidenceSchema,
  state: enumeration('ready'),
  format: enumeration('csv'),
  rows: integer,
  columns: integer,
  downloadStarted: boolean,
});
const WORKSPACE_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'seek_to_time',
    description: '定位到范围内最近的已采样帧，返回实际时间；不重新采集。',
    inputSchema: object({ ...reference, time: number }),
    outputSchema: object({ ...reference, requestedTime: number, appliedTime: number }),
  },
  {
    name: 'set_chart_view',
    description: '应用关节、侧别、raw/filtered 和秒区间到真实图表；不改变导出片段。',
    inputSchema: object({ ...selection, interval: intervalSchema }),
    outputSchema: object({ ...reference, view: chartViewSchema }),
  },
  {
    name: 'prepare_report',
    description:
      '本地计算事实、ROM差值趋势、缺失与限制，生成可预览/保存的版本报告。comparison 为后段或 null。',
    inputSchema: object(reportInput),
    outputSchema: reportSchema,
  },
  {
    name: 'prepare_export',
    description: '准备指定区间CSV句柄及行列数；不会自动下载，用户可直接保存准备结果。',
    inputSchema: object({ ...reference, interval: intervalSchema, format: enumeration('csv') }),
    outputSchema: exportSchema,
  },
];
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Schema;
  outputSchema: Schema;
}
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_session_info',
    description: '读取当前会话版本、参数、来源及已采样范围；无视频或关键点。',
    inputSchema: object({}),
    outputSchema: sessionSchema,
  },
  {
    name: 'get_quality_summary',
    description: '按已采样帧统计检测、置信度和缺失区间，非源视频覆盖率。',
    inputSchema: object({ ...reference, interval: intervalSchema }),
    outputSchema: qualitySchema,
  },
  {
    name: 'query_metrics',
    description: '指定 raw/filtered、关节、侧别和闭区间；脊柱只能用 midline。',
    inputSchema: object({ ...selection, interval: intervalSchema }),
    outputSchema: metricSchema,
  },
  {
    name: 'compare_intervals',
    description: '同口径比较两个区间，差值为第二段减第一段；返回可比性限制。',
    inputSchema: object({ ...selection, first: intervalSchema, second: intervalSchema }),
    outputSchema: compareSchema,
  },
];
export type WorkspaceToolName =
  | 'seek_to_time'
  | 'set_chart_view'
  | 'prepare_report'
  | 'prepare_export';
export interface ViewReportPorts {
  seekToTime(time: number): { appliedTime: number };
  setChartView(view: ChartView): ChartView;
  readWorkspace?(): { chart: ChartView | null; time: number | null };
}
export interface ChartView {
  joint: Joint;
  channels: Channel[];
  basis: 'raw' | 'filtered';
  interval: [number, number];
}
export interface PreparedArtifact {
  kind: 'report' | 'csv';
  reference: ReturnType<AnalysisSession['info']>;
  interval: [number, number];
  result: any;
}
type Interval = [number, number];
type Basis = 'raw' | 'filtered';
interface Selection {
  sessionId: string;
  revision: number;
  joint: Joint;
  channels: Channel[];
  basis: Basis;
}
interface Query extends Selection {
  interval: Interval;
}
const LIMITATIONS = [
  '单人单目 2D 几何投影；不代表动作质量或对错。',
  '覆盖率只按已采样帧计，不能证明穷尽源视频帧；缺失、主动运动和视角影响统计。',
  '方差为总体方差；坐标方差是各可靠点 x/y 方差和的均值；滑窗可含查询起点之前的样本。',
];
export function statistics(values: number[]) {
  const mean = values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
  return {
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean,
    populationVariance:
      mean === null ? null : values.reduce((s, n) => s + (n - mean) ** 2, 0) / values.length,
    sampleCount: values.length,
  };
}
function inInterval(session: AnalysisSession, interval: Interval) {
  const range = session.info().range;
  if (!range) throw new Error('NO_DATA');
  if (interval[0] > interval[1] || interval[0] < range[0] || interval[1] > range[1])
    throw new Error('INVALID_INTERVAL');
  const frames = intervalFrames(session.frames, interval);
  if (!frames.length) throw new Error('NO_SAMPLES');
  return frames;
}
function evidence(session: AnalysisSession, interval: Interval, basis: Basis, frames: PoseFrame[]) {
  const { range: _, ...info } = session.info();
  return {
    ...info,
    interval: [...interval],
    basis,
    sampleCount: frames.length,
    sampledRange: frames.length ? [frames[0].time, frames.at(-1)!.time] : null,
    limitations: [
      ...LIMITATIONS,
      ...(info.acquisition?.mode === 'webcodecs-transcoded'
        ? [
            '视频已在本机转换；帧数、时间轴和完整性核对以转换后视频为准，不能视为原文件逐帧无损审计。',
          ]
        : []),
      ...(info.acquisition && info.acquisition.status !== 'completed'
        ? [`离线视频状态为 ${info.acquisition.status}；当前数据是已分析前缀，不能代表完整源视频。`]
        : []),
    ],
  };
}
function query(session: AnalysisSession, p: Query) {
  if (
    new Set(p.channels).size !== p.channels.length ||
    p.channels.some((side) => !channels(p.joint).includes(side))
  )
    throw new Error('INVALID_CHANNEL');
  const frames = inInterval(session, p.interval);
  const positions = frames.map((f) => f.variance[p.basis]);
  return {
    evidence: evidence(session, p.interval, p.basis, frames),
    joint: p.joint,
    channels: p.channels.map((channel) => {
      const values = frames.flatMap((f) => {
        const n = angleValue(p.basis === 'raw' ? f.rawAngles : f.angles, p.joint, channel);
        return n === null ? [] : [n];
      });
      // Do not count a derivative that uses an angle outside the query interval.
      const speeds = frames.slice(1).flatMap((f) => {
        const n = angleValue(p.basis === 'raw' ? f.rawVelocity : f.velocity, p.joint, channel);
        return n === null ? [] : [n];
      });
      const angle = statistics(values);
      return {
        channel,
        angle,
        rom: angle.sampleCount >= 2 ? angle.max! - angle.min! : null,
        velocity: statistics(speeds),
        peakAbsoluteVelocity: speeds.length ? Math.max(...speeds.map(Math.abs)) : null,
        coverage: values.length / frames.length,
      };
    }),
    units: {
      angle: 'deg',
      velocity: 'deg/s',
      angleVariance: 'deg²',
      coordinateVariance: 'normalized_coordinate²',
    },
    coordinateVariance: {
      windows: statistics(positions.flatMap((v) => (v.value === null ? [] : [v.value]))),
      validPointSamples: positions.reduce((s, v) => s + v.validSamples, 0),
      configuredWindowFrames: session.info().parameters.window,
      windowInterval: positions.some((v) => v.value !== null)
        ? [
            Math.min(
              ...frames
                .filter((f) => f.variance[p.basis].value !== null)
                .map((f) => f.windowInterval[0]),
            ),
            frames.at(-1)!.time,
          ]
        : null,
    },
  };
}
function quality(session: AnalysisSession, interval: Interval) {
  const frames = inInterval(session, interval),
    threshold = session.info().parameters.threshold;
  const groups: { interval: Interval; samples: number }[] = [];
  let group: (typeof groups)[number] | undefined;
  let groupCount = 0;
  for (const f of frames) {
    if (f.rawPoints.length !== 33 || f.rawPoints.some((p) => p.visibility < threshold)) {
      if (!group) {
        group = { interval: [f.time, f.time], samples: 0 };
        groupCount++;
        if (groups.length < 100) groups.push(group);
      }
      group.interval[1] = f.time;
      group.samples++;
    } else group = undefined;
  }
  const detectedSamples = frames.filter((f) => f.rawPoints.length === 33).length;
  const fullyReliableSamples = frames.filter(
    (f) => f.rawPoints.length === 33 && f.rawPoints.every((p) => p.visibility >= threshold),
  ).length;
  return {
    evidence: evidence(session, interval, 'raw', frames),
    detectedSamples,
    missingSamples: frames.length - detectedSamples,
    fullyReliableSamples,
    effectiveRate: fullyReliableSamples / frames.length,
    meanConfidence: statistics(frames.map((f) => f.confidence)).mean,
    lowConfidenceIntervals: groups,
    omittedIntervals: Math.max(0, groupCount - 100),
    maxSampleGapSeconds:
      frames.length > 1
        ? Math.max(...frames.slice(1).map((f, i) => f.time - frames[i].time))
        : null,
  };
}
export type ToolResult =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error: { code: string; message: string; issue?: SchemaIssue } };
export function createToolRegistry(session: AnalysisSession, ports?: ViewReportPorts) {
  // Bounded aggregate-only LRU; never retain per-frame results or old revisions.
  const cache = new Map<string, unknown>();
  let namespace = '';
  const artifacts = new Map<string, PreparedArtifact>();
  const definitions = [...TOOL_DEFINITIONS, ...WORKSPACE_DEFINITIONS];
  const cacheKey = (name: string, input: unknown) =>
    name +
    JSON.stringify(
      Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  return {
    definitions,
    readWorkspace() {
      if (!ports?.readWorkspace) throw new Error('WORKSPACE_OBSERVATION_UNAVAILABLE');
      return structuredClone(ports.readWorkspace());
    },
    getArtifact(handle: string) {
      const artifact = artifacts.get(handle);
      if (!artifact) throw new Error('UNKNOWN_ARTIFACT');
      session.assertCurrent(artifact.reference);
      return structuredClone(artifact);
    },
    execute(name: string, input: unknown): ToolResult {
      try {
        const definition = definitions.find((d) => d.name === name);
        if (!definition) throw new Error('UNKNOWN_TOOL');
        validate(definition.inputSchema, input);
        if (name !== 'get_session_info') session.assertCurrent(input as Selection);
        const info = session.info();
        if (WORKSPACE_DEFINITIONS.some((d) => d.name === name)) {
          const p = input as Query & { time: number; comparison: Interval | null; format: 'csv' };
          let result: any;
          if (name === 'seek_to_time') {
            if (!info.range) throw new Error('NO_DATA');
            if (p.time < info.range[0] || p.time > info.range[1])
              throw new Error('INVALID_INTERVAL');
            if (!ports) throw new Error('VIEW_UNAVAILABLE');
            result = {
              sessionId: info.sessionId,
              revision: info.revision,
              requestedTime: p.time,
              ...ports.seekToTime(p.time),
            };
            if (!session.frames.some((f) => f.time === result.appliedTime))
              throw new Error('VIEW_NOT_APPLIED');
          } else if (name === 'set_chart_view') {
            query(session, p); // Validate channels, basis and actual sampled range before mutation.
            if (!ports) throw new Error('VIEW_UNAVAILABLE');
            const requested: ChartView = {
              joint: p.joint,
              channels: [...p.channels],
              basis: p.basis,
              interval: [...p.interval],
            };
            const view = ports.setChartView(structuredClone(requested));
            if (JSON.stringify(view) !== JSON.stringify(requested))
              throw new Error('VIEW_NOT_APPLIED');
            result = { sessionId: info.sessionId, revision: info.revision, view };
          } else {
            const selected = inInterval(session, p.interval);
            const ev = evidence(
              session,
              p.interval,
              name === 'prepare_report' ? p.basis : 'raw',
              selected,
            );
            const handle = crypto.randomUUID();
            if (name === 'prepare_report') {
              const facts = query(session, p);
              const compared = p.comparison
                ? this.execute('compare_intervals', {
                    sessionId: p.sessionId,
                    revision: p.revision,
                    joint: p.joint,
                    channels: p.channels,
                    basis: p.basis,
                    first: p.interval,
                    second: p.comparison,
                  })
                : null;
              if (compared && !compared.ok) throw new Error(compared.error.code);
              const comparison = compared?.ok ? (compared.result as any) : null;
              const q = quality(session, p.interval);
              const secondQuality = p.comparison ? quality(session, p.comparison) : null;
              result = {
                handle,
                evidence: ev,
                state: 'ready',
                facts,
                comparison,
                quality: q,
                trends: comparison
                  ? comparison.differences.map(
                      (d: any) =>
                        `${d.channel} ROM：${d.rom === null ? '缺失' : d.rom > 0 ? '后段较大' : d.rom < 0 ? '后段较小' : '相同'}（仅区间差异，非阶段趋势或质量判断）`,
                    )
                  : ['单区间统计不推断时间趋势。'],
                missing: [q, ...(secondQuality ? [secondQuality] : [])].map(
                  (v) =>
                    `${v.evidence.interval.join('–')} s：未检测 ${v.missingSamples} 个；全点不可靠 ${v.evidence.sampleCount - v.fullyReliableSamples} 个；省略低置信段 ${v.omittedIntervals} 个。`,
                ),
                limitations: [
                  ...ev.limitations,
                  ...(comparison?.reasons ?? []),
                  'ROM 至少需要两个有效角度；空值保持缺失。',
                ],
              };
            } else
              result = {
                handle,
                evidence: ev,
                state: 'ready',
                format: 'csv',
                rows: selected.length,
                columns: CSV_COLUMN_COUNT,
                downloadStarted: false,
              };
            validate(definition.outputSchema, result);
            artifacts.set(handle, {
              kind: name === 'prepare_report' ? 'report' : 'csv',
              reference: info,
              interval: [...p.interval],
              result: structuredClone(result),
            });
            if (artifacts.size > 12) artifacts.delete(artifacts.keys().next().value!);
          }
          session.assertCurrent(info);
          validate(definition.outputSchema, result);
          return { ok: true, tool: name, result };
        }
        const nextNamespace = JSON.stringify([info.sessionId, info.revision, info.parameters]);
        if (nextNamespace !== namespace) {
          cache.clear();
          namespace = nextNamespace;
        }
        const key = cacheKey(name, input);
        if (cache.has(key)) {
          const value = cache.get(key);
          cache.delete(key);
          cache.set(key, value);
          return { ok: true, tool: name, result: structuredClone(value) };
        }
        let result: unknown;
        if (name === 'get_session_info') result = session.info();
        else if (name === 'get_quality_summary')
          result = quality(session, (input as Query).interval);
        else if (name === 'query_metrics') result = query(session, input as Query);
        else {
          const p = input as Selection & { first: Interval; second: Interval };
          const first = query(session, { ...p, interval: p.first }),
            second = query(session, { ...p, interval: p.second });
          const reasons: string[] = [];
          if (Math.abs(p.first[1] - p.first[0] - (p.second[1] - p.second[0])) > 1e-6)
            reasons.push('区间时长不同');
          if (
            first.channels.some((v) => v.coverage < 0.8 || v.angle.sampleCount < 2) ||
            second.channels.some((v) => v.coverage < 0.8 || v.angle.sampleCount < 2)
          )
            reasons.push('至少一侧有效样本不足 2 或已采样帧覆盖率低于 80%');
          if (p.first[0] <= p.second[1] && p.second[0] <= p.first[1])
            reasons.push('区间重叠，不能作为独立片段');
          const diff = (a: number | null, b: number | null) =>
            a === null || b === null ? null : b - a;
          result = {
            first,
            second,
            comparable: !reasons.length,
            reasons,
            differences: first.channels.map((a, i) => ({
              channel: a.channel,
              rom: diff(a.rom, second.channels[i].rom),
              meanAngle: diff(a.angle.mean, second.channels[i].angle.mean),
              peakAbsoluteVelocity: diff(
                a.peakAbsoluteVelocity,
                second.channels[i].peakAbsoluteVelocity,
              ),
            })),
            differenceDirection: 'second_minus_first',
          };
        }
        validate(definition.outputSchema, result);
        cache.set(key, structuredClone(result));
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
        return { ok: true, tool: name, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'TOOL_FAILED';
        return {
          ok: false,
          tool: name,
          error: {
            code: message.startsWith('SCHEMA') ? 'SCHEMA_VALIDATION' : message,
            message,
            ...(error instanceof SchemaError ? { issue: error.issue } : {}),
          },
        };
      }
    },
    validateEvidence(value: unknown) {
      validate(evidenceSchema, value);
      session.assertCurrent(value as Selection);
      const p = value as {
        parameters: Record<string, unknown>;
        interval: Interval;
        sampleCount: number;
        sampledRange: Interval;
        source: string;
        synthetic: boolean;
        acquisition: unknown;
      };
      const info = session.info();
      if (Object.entries(info.parameters).some(([key, v]) => p.parameters[key] !== v))
        throw new Error('STALE_PARAMETERS');
      const frames = inInterval(session, p.interval);
      if (
        p.source !== info.source ||
        p.synthetic !== info.synthetic ||
        JSON.stringify(p.acquisition) !== JSON.stringify(info.acquisition) ||
        p.sampleCount !== frames.length ||
        p.sampledRange?.[0] !== frames[0].time ||
        p.sampledRange?.[1] !== frames.at(-1)!.time
      )
        throw new Error('INVALID_EVIDENCE');
      return true;
    },
  };
}
