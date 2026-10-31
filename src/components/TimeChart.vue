<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { PoseFrame, Joint, Marker } from '../types';
import type { ChartView } from '../analysis/tools';
import { JOINTS, COLORS } from '../config';
import { DEMO_SIZE } from '../utils/dimensions';
import { angleValue, channels } from '../utils/poseMath';
import { intervalFrames } from '../analysis/frameIndex';
import {
  paddedExtent,
  trajectoryBounds,
  velocityHeatmap,
  pointSeries,
  peakDisplaySeries,
  peakDisplayTrajectory,
} from '../utils/visualization';
import MarkerTimeline from './MarkerTimeline.vue';
echarts.use([
  LineChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);
const props = withDefaults(
  defineProps<{
    frames: PoseFrame[];
    joint: Joint;
    markers: Marker[];
    kind?: 'angle' | 'center' | 'heatmap' | 'trajectory' | 'point';
    expanded?: boolean;
    revision?: number;
    view?: ChartView | null;
    interval?: [number, number] | null;
    aspect?: number;
    threshold?: number;
    pointIndex?: number;
    pointBasis?: 'raw' | 'filtered';
    active?: boolean;
  }>(),
  { active: true },
);
const emit = defineEmits<{ range: [start: number, end: number]; seek: [time: number] }>();
const element = ref<HTMLElement>(),
  note = ref(''),
  empty = ref(false);
const temporal = computed(() => !['heatmap', 'trajectory'].includes(props.kind ?? 'angle'));
const domain = computed<[number, number]>(() => {
  // Publication mutates the same frame array; revision invalidates this extent.
  void props.revision;
  return [props.frames[0]?.time ?? 0, props.frames.at(-1)?.time ?? 0];
});
const selection = computed(() => props.view?.interval ?? props.interval);
let chart: echarts.ECharts | undefined,
  observer: ResizeObserver,
  lastRender = 0;
let trailing: ReturnType<typeof setTimeout> | undefined;
let sourceKey = '';
let sourceFrames: PoseFrame[] | undefined;
let sourceSeries: { name: string; color: string; data: [number, number | null][] }[] = [];
let dirty = true;
let chartKind: string | undefined;
function applyOption(option: echarts.EChartsCoreOption) {
  const kind = props.kind ?? 'angle';
  chart!.setOption(option, { notMerge: chartKind !== kind, replaceMerge: ['series'] });
  chartKind = kind;
}
function presentChart() {
  if (!chart) return;
  for (const element of chart.getZr().storage.getDisplayList()) element.dirty();
  chart.getZr().refreshImmediately();
}
const renderWaiters: (() => void)[] = [];
// Expose a measurement barrier without changing the existing draw schedule.
async function waitUntilRendered() {
  if (trailing) await new Promise<void>((resolve) => renderWaiters.push(resolve));
  if (!chart) throw new Error('CHART_NOT_READY');
  if (dirty || !chartKind) throw new Error('CHART_NOT_RENDERED');
  chart.getZr().flush();
}
defineExpose({ waitUntilRendered });
const axis = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: { color: '#8b9a98', fontSize: 10 },
  splitLine: { lineStyle: { color: '#edf1ef', type: 'dashed' as const } },
};
function locate(time: number) {
  const selected = selection.value;
  if (selected && (time < selected[0] || time > selected[1])) emit('range', ...domain.value);
  emit('seek', time);
}
function draw() {
  if (!chart) return;
  const frames = props.frames;
  const selected = selection.value;
  const visible = selected ? intervalFrames(frames, selected) : frames;
  const grid = { left: 52, right: 24, top: 24, bottom: temporal.value ? 42 : 30 };
  empty.value = !visible.length;
  note.value = '';
  if (props.kind === 'heatmap') {
    const heat = velocityHeatmap(
      visible,
      chart.getWidth() - 75,
      props.view?.basis ?? 'filtered',
      props.view?.channels,
    );
    note.value = `时间桶内各侧绝对速度最大值；双侧取最大，脊柱仅中线。灰格为缺失，部分缺失见提示。色标 0–${heat.cap.toFixed(1)} °/s${heat.clipped ? `（${heat.clipped} 格截顶，提示保留实际值）` : ''}；实际峰值 ${heat.peak?.toFixed(1) ?? '—'} °/s。`;
    const cellData = (missing: boolean) =>
      heat.cells
        .filter((c) => (c.value === null) === missing)
        .map((c) => ({
          value: [c.column, c.row, missing ? 0 : Math.min(c.value!, heat.cap)],
          cell: c,
        }));
    applyOption({
      animation: false,
      grid: { left: 58, right: 18, top: 10, bottom: 62 },
      tooltip: {
        formatter: (p: unknown) => {
          const c = (p as { data: { cell: (typeof heat.cells)[number] } }).data.cell;
          const bucket = heat.buckets[c.column]!;
          return `${JOINTS[c.row]!.label} · ${bucket[0].toFixed(3)}–${bucket[1].toFixed(3)} s<br/>${c.value === null ? '缺失 / 无有效速度' : `实际峰值 ${c.value.toFixed(3)} °/s${c.value > heat.cap ? '（颜色截顶）' : ''}`}<br/>有效 ${c.valid} / 缺失 ${c.missing} 侧样本`;
        },
      },
      xAxis: {
        ...axis,
        type: 'category',
        data: heat.buckets.map((_, i) => String(i)),
        splitLine: { show: false },
        axisLabel: {
          ...axis.axisLabel,
          interval: Math.max(0, Math.ceil(heat.buckets.length / 4) - 1),
          formatter: (v: string) => `${heat.buckets[Number(v)]![0].toFixed(2)}s`,
        },
      },
      yAxis: {
        ...axis,
        type: 'category',
        inverse: true,
        data: JOINTS.map((j) => (j.key === 'spine' ? '脊柱·中线' : j.label)),
        splitLine: { show: false },
      },
      visualMap: [
        {
          type: 'continuous',
          show: heat.peak !== null,
          seriesIndex: 1,
          dimension: 2,
          min: 0,
          max: heat.cap,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          itemWidth: 9,
          itemHeight: Math.max(70, Math.min(150, chart.getWidth() - 140)),
          precision: 1,
          text: [`${heat.cap.toFixed(1)} °/s`, '0'],
          textStyle: { color: '#83968b', fontSize: 10 },
          inRange: { color: ['#e8f4ed', '#bce4cb', '#7ac79c', '#e3bd76', '#e89461'] },
        },
        {
          type: 'continuous',
          show: false,
          seriesIndex: 0,
          dimension: 2,
          min: 0,
          max: 1,
          inRange: { color: ['#eef1ef', '#eef1ef'] },
        },
      ],
      series: [
        {
          id: 'missing-velocity',
          type: 'heatmap',
          data: cellData(true),
          itemStyle: { color: '#eef1ef', borderColor: '#fff', borderWidth: 1 },
        },
        {
          id: 'valid-velocity',
          type: 'heatmap',
          data: cellData(false),
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          progressive: 0,
        },
      ],
    });
    return;
  }
  if (props.kind === 'trajectory') {
    const bounds = trajectoryBounds(
      visible,
      chart.getWidth() - grid.left - grid.right,
      chart.getHeight() - grid.top - grid.bottom,
      props.aspect ?? DEMO_SIZE.width / DEMO_SIZE.height,
    );
    const valid = visible.filter(
      (f) => f.center && Number.isFinite(f.center.x) && Number.isFinite(f.center.y),
    );
    empty.value = !valid.length;
    const stationary =
      valid.length > 0 &&
      valid.every(
        (f) => f.center!.x === valid[0]!.center!.x && f.center!.y === valid[0]!.center!.y,
      );
    note.value = 'X 向右、Y 向下 · 归一化坐标；按源宽高比等比例显示，轴范围含边距；缺失处断开。';
    const display = peakDisplayTrajectory(visible, chart.getWidth() - grid.left - grid.right);
    if (display.length < visible.length)
      note.value += ' 显示按时间桶保留 X/Y 首末点及极值；查询、CSV 和证据使用全量数据。';
    applyOption({
      animation: false,
      grid,
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const v = (p as { value: number[] }).value;
          return `${v[2]!.toFixed(3)} s<br/>X ${v[0]!.toFixed(4)} · Y ${v[1]!.toFixed(4)}`;
        },
      },
      xAxis: {
        ...axis,
        type: 'value',
        name: 'X →',
        min: bounds.x[0],
        max: bounds.x[1],
        axisLabel: { ...axis.axisLabel, formatter: (v: number) => v.toFixed(3) },
      },
      yAxis: {
        ...axis,
        type: 'value',
        name: 'Y ↓',
        inverse: true,
        min: bounds.y[0],
        max: bounds.y[1],
        axisLabel: { ...axis.axisLabel, formatter: (v: number) => v.toFixed(3) },
      },
      series: [
        {
          id: 'center-trajectory',
          type: 'line',
          symbol: 'circle',
          symbolSize: 5,
          showSymbol: valid.length <= 1 || stationary,
          connectNulls: false,
          data: display,
          lineStyle: { color: '#0f947b', width: 2 },
          itemStyle: { color: '#0f947b' },
        },
      ],
    });
    return;
  }
  const center = props.kind === 'center',
    point = props.kind === 'point';
  // Display-source cache only; session identity, revision and semantic parameters
  // invalidate it. Queries, exports and evidence always read original frames.
  const key = JSON.stringify([
    props.revision,
    props.kind,
    center || point ? null : props.joint,
    props.view?.basis,
    props.view?.channels,
    props.pointIndex,
    props.pointBasis,
    props.threshold,
  ]);
  if (sourceFrames !== frames || sourceKey !== key) {
    sourceFrames = frames;
    sourceKey = key;
    sourceSeries = center
      ? [
          {
            name: '重心 Y',
            color: '#18977e',
            data: frames.map((f) => [f.time, f.center?.y ?? null]),
          },
        ]
      : point
        ? (['x', 'y'] as const).map((coordinate, i) => ({
            name: coordinate.toUpperCase(),
            color: i ? COLORS.right : COLORS.left,
            data: pointSeries(
              frames,
              props.pointIndex ?? 15,
              props.pointBasis ?? 'filtered',
              props.threshold ?? 0.5,
              coordinate,
            ),
          }))
        : channels(props.joint)
            .filter((side) => !props.view || props.view.channels.includes(side))
            .map((side) => ({
              name: { left: '左侧', right: '右侧', midline: '中线' }[side],
              color: side === 'right' ? COLORS.right : COLORS.left,
              data: frames.map<[number, number | null]>((f) => [
                f.time,
                angleValue(props.view?.basis === 'raw' ? f.rawAngles : f.angles, props.joint, side),
              ]),
            }));
  }
  const series = sourceSeries;
  note.value = point
    ? `${props.pointBasis ?? 'filtered'} · X 向右、Y 向下 · 归一化坐标；低于置信阈值的点留空。`
    : center
      ? 'filtered · Y 向下 · 归一化坐标；缺失处断开。'
      : '';
  let aggregated = false;
  const display = series.map((s) => {
    const source = selected
      ? s.data.filter((p) => p[0] >= selected[0] && p[0] <= selected[1])
      : s.data;
    const data = peakDisplaySeries(source, chart!.getWidth() - grid.left - grid.right);
    aggregated ||= data.length < source.length;
    return { ...s, data };
  });
  // Aggregation preserves every bucket's extrema and finite runs. Its output
  // therefore has exactly the source extent/empty state without another scan
  // and flatMap allocation across all 18,000 source samples per linked chart.
  const values = display.flatMap((s) => s.data.flatMap((p) => (p[1] === null ? [] : [p[1]])));
  const extent = center || point ? paddedExtent(values) : [0, 180];
  empty.value = !values.length;
  if (aggregated)
    note.value +=
      ' 显示按时间桶保留首末点和最小/最大值，缺失处断开；查询、CSV 和证据使用全量数据。';
  const first = domain.value[0],
    last = domain.value[1];
  applyOption({
    animation: false,
    grid,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        v === null
          ? '不可用'
          : Number(v).toFixed(center || point ? 4 : 1) + (center || point ? '' : '°'),
    },
    xAxis: {
      ...axis,
      type: 'value',
      min: first,
      max: last > first ? last : first + 0.05,
      splitLine: { show: false },
      axisLabel: { ...axis.axisLabel, formatter: (v: number) => v.toFixed(2) + ' s' },
    },
    yAxis: {
      ...axis,
      type: 'value',
      inverse: center || point,
      min: center || point ? extent[0] : 0,
      max: center || point ? extent[1] : 180,
      axisLabel: {
        ...axis.axisLabel,
        formatter: (v: number) => (center || point ? v.toFixed(3) : v + '°'),
      },
    },
    dataZoom: [
      {
        type: 'inside',
        filterMode: 'none',
        startValue: selected?.[0] ?? first,
        endValue: selected?.[1] ?? last,
      },
      {
        type: 'slider',
        showDataShadow: false,
        filterMode: 'none',
        startValue: selected?.[0] ?? first,
        endValue: selected?.[1] ?? last,
        height: 12,
        bottom: 3,
        left: grid.left,
        right: grid.right,
        borderColor: 'transparent',
        backgroundColor: '#f3f7f5',
        fillerColor: 'rgba(24,151,126,.12)',
        handleStyle: { color: '#78c3ad', borderWidth: 0 },
        showDetail: false,
        brushSelect: true,
      },
    ],
    series: display.map((s, i) => ({
      id: `temporal-${i}`,
      name: s.name,
      type: 'line',
      data: s.data,
      symbol: 'circle',
      symbolSize: 5,
      showSymbol: visible.length === 1,
      connectNulls: false,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: center ? { color: 'rgba(24,151,126,.06)' } : undefined,
      markLine:
        i === 0
          ? {
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: '#9db8ac', type: 'dashed' },
              data: props.markers
                .filter((m) => m.time >= first && m.time <= last)
                .map((m) => ({ name: m.label, xAxis: m.time })),
            }
          : undefined,
    })),
  });
}
function initializeChart() {
  if (chart || !element.value?.clientWidth || !element.value.clientHeight) return;
  chart = echarts.init(element.value);
  chart.on('datazoom', (event: unknown) => {
    type Zoom = { start?: number; end?: number; startValue?: number; endValue?: number };
    const data = event as Zoom & { batch?: Zoom[] };
    const zoom = data.batch?.[0] ?? data;
    const [first, last] = domain.value;
    const span = last > first ? last - first : 0.05;
    // The event already contains the value/percentage range on our fixed value
    // axis. getOption() clones every displayed series just to read two numbers.
    const start =
      zoom.startValue ?? (typeof zoom.start === 'number' ? first + (span * zoom.start) / 100 : NaN);
    const end =
      zoom.endValue ?? (typeof zoom.end === 'number' ? first + (span * zoom.end) / 100 : NaN);
    if (Number.isFinite(start) && Number.isFinite(end)) emit('range', start, end);
  });
  scheduleDraw(true);
}
function scheduleDraw(interactive = false) {
  dirty = true;
  clearTimeout(trailing);
  trailing = undefined;
  if (props.active === false) return;
  const wait = interactive ? 0 : Math.max(0, 250 - (performance.now() - lastRender));
  const render = () => {
    lastRender = performance.now();
    draw();
    dirty = false;
    trailing = undefined;
    renderWaiters.splice(0).forEach((resolve) => resolve());
  };
  // Five linked charts otherwise execute inside one Vue flush. Coalesce mount,
  // resize and prop changes, then give each chart its own browser task.
  trailing = setTimeout(render, wait);
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!element.value?.clientWidth || !element.value.clientHeight) return;
    if (chart) {
      if (
        chart.getWidth() !== element.value.clientWidth ||
        chart.getHeight() !== element.value.clientHeight
      ) {
        chart.resize();
        scheduleDraw(true);
      } else {
        if (dirty) scheduleDraw(true);
        else presentChart();
      }
    } else initializeChart();
  });
  observer.observe(element.value!);
  initializeChart();
});
watch(
  () => props.active,
  (active) => {
    if (!active) return;
    if (dirty || !chart) {
      initializeChart();
      scheduleDraw(true);
    } else {
      // Page reveal can happen between ResizeObserver deliveries with unchanged
      // dimensions. Explicitly present the retained canvas in that case too.
      setTimeout(presentChart, 0);
    }
  },
  { flush: 'post' },
);
watch(
  () => [props.frames, props.revision],
  (current, previous) => scheduleDraw(current[0] !== previous[0]),
);
watch(
  [
    () => ((props.kind ?? 'angle') === 'angle' ? props.joint : null),
    () => props.markers.map((m) => m.label + ':' + m.time).join('|'),
    () => props.kind,
    () => props.view,
    () => props.interval,
    () => props.aspect,
    () => props.pointIndex,
    () => props.pointBasis,
    () => props.threshold,
  ],
  () => scheduleDraw(true),
);
onBeforeUnmount(() => {
  clearTimeout(trailing);
  trailing = undefined;
  renderWaiters.splice(0).forEach((resolve) => resolve());
  observer?.disconnect();
  chart?.dispose();
});
</script>
<template>
  <div class="time-chart" :data-kind="kind ?? 'angle'">
    <div class="chart-surface">
      <div
        ref="element"
        class="echart"
        :class="{ 'chart-expanded': expanded, 'heatmap-chart': kind === 'heatmap' }"
        role="img"
        :aria-label="
          kind === 'center'
            ? '重心起伏时序图'
            : kind === 'heatmap'
              ? '七类关节角速度热力图'
              : kind === 'trajectory'
                ? '重心轨迹图'
                : kind === 'point'
                  ? '关键点 X/Y 时序图'
                  : '关节角度时序图'
        "
      />
      <span v-if="empty" class="chart-empty">暂无有效样本</span>
    </div>
    <div v-if="temporal && markers.length" class="chart-markers"
      ><MarkerTimeline :markers="markers" :domain="domain" :selection="selection" @seek="locate"
    /></div>
    <p v-if="note" class="chart-note">{{ note }}</p>
  </div>
</template>
<style scoped>
.chart-surface {
  position: relative;
}
.chart-empty {
  position: absolute;
  top: 44%;
  left: 50%;
  transform: translateX(-50%);
  color: #8b9a98;
  font-size: 12px;
  pointer-events: none;
}
.chart-note {
  font-size: 11px;
  line-height: 1.7;
  color: #83968b;
  margin: 5px 18px 13px;
}
.chart-markers {
  margin: 0 24px 0 52px;
}
.heatmap-chart {
  height: 270px;
}
</style>
