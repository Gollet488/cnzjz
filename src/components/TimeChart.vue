<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch, computed } from 'vue';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import type { PoseFrame, Joint, Marker } from '../types';
import type { ChartView } from '../analysis/tools';
import { JOINTS } from '../config';
import { theme } from '../theme';
import { DEMO_SIZE } from '../utils/dimensions';
import { angleValue, channels } from '../utils/poseMath';
import { intervalFrames, nearestFrameIndex, timeBound } from '../analysis/frameIndex';
import {
  paddedExtent,
  trajectoryBounds,
  velocityHeatmap,
  pointSeries,
  peakDisplaySeries,
  peakDisplayTrajectory,
  seriesInterval,
} from '../utils/visualization';
import MarkerTimeline from './MarkerTimeline.vue';
import RollingNumber from './RollingNumber.vue';
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
    cursorTime?: number;
  }>(),
  { active: true },
);
const emit = defineEmits<{ range: [start: number, end: number]; seek: [time: number] }>();
const element = ref<HTMLElement>(),
  note = ref(''),
  empty = ref(false),
  pending = ref(true),
  loadError = ref(false);
const temporal = computed(() => !['heatmap', 'trajectory'].includes(props.kind ?? 'angle'));
const domain = computed<[number, number]>(() => {
  // Publication mutates the same frame array; revision invalidates this extent.
  void props.revision;
  return [props.frames[0]?.time ?? 0, props.frames.at(-1)?.time ?? 0];
});
const selection = computed(() => props.view?.interval ?? props.interval);
const temporalGrid = { left: 52, right: 24, top: 24, bottom: 42 };
const cursor = shallowRef<{
  index: number;
  time: number;
  x: number;
  values: { name: string; color: string; text: string; y: number | null }[];
}>();
const cursorBounds = shallowRef<[number, number]>([0, 0]);
const keyboardCursor = ref(false);
const chartLabel = computed(() => {
  switch (props.kind) {
    case 'center':
      return '重心起伏时序图';
    case 'heatmap':
      return '七类关节角速度热力图';
    case 'trajectory':
      return '重心轨迹图';
    case 'point':
      return '关键点 X/Y 时序图';
    default:
      return '关节角度时序图';
  }
});
let pointerX: number | undefined;
const dragPointer = ref<number>();
let chart: ECharts | undefined,
  observer: ResizeObserver,
  lastRender = 0;
let engine: typeof import('../utils/chartEngine') | undefined;
let loading: Promise<void> | undefined;
let disposed = false;
let trailing: ReturnType<typeof setTimeout> | undefined;
let immediatePending = false;
let sourceKey = '';
let sourceFrames: PoseFrame[] | undefined;
type TemporalSeries = {
  name: string;
  color: 'left' | 'right' | 'center';
  data: [number, number | null][];
};
let sourceSeries: TemporalSeries[] = [];
let plotSeries: TemporalSeries[] = [];
let dirty = true;
let chartKind: string | undefined;
function applyOption(option: EChartsCoreOption) {
  const kind = props.kind ?? 'angle';
  chart!.setOption(option, { notMerge: chartKind !== kind, replaceMerge: ['series'] });
  chartKind = kind;
}
function presentChart() {
  if (!chart || !props.active) return;
  for (const element of chart.getZr().storage.getDisplayList()) element.dirty();
  chart.getZr().refreshImmediately();
}
const renderWaiters: (() => void)[] = [];
// Expose a measurement barrier without changing the existing draw schedule.
async function waitUntilRendered() {
  await loading;
  if (trailing !== undefined) await new Promise<void>((resolve) => renderWaiters.push(resolve));
  if (!chart || !props.active) throw new Error('CHART_NOT_READY');
  if (dirty || !chartKind) throw new Error('CHART_NOT_RENDERED');
  chart.getZr().flush();
}
defineExpose({ waitUntilRendered });
// ECharts paints to canvas and needs resolved CSS values.
const palette = computed(() => {
  void theme.value;
  const style = getComputedStyle(document.documentElement);
  const color = (token: string) => style.getPropertyValue(token).trim();
  const chartMuted = color('--muted');
  const chartSurface = color('--surface');
  const line = color('--line');
  return {
    chartMuted,
    chartSurface,
    chartAccent: color('--chart-center'),
    chartTrack: color('--surface-muted'),
    chartHandle: color('--accent-mid'),
    chartFill: color('--chart-fill'),
    chartSelection: color('--chart-selection'),
    heatColors: [color('--chart-heat-low'), color('--chart-heat-mid'), color('--chart-heat-high')],
    series: {
      left: color('--chart-left'),
      right: color('--chart-right'),
      center: color('--chart-center'),
    },
    tooltip: {
      backgroundColor: chartSurface,
      borderColor: line,
      textStyle: { color: color('--ink') },
    },
    axis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: chartMuted, fontSize: 10 },
      nameTextStyle: { color: chartMuted },
      splitLine: { lineStyle: { color: line, type: 'dashed' as const } },
    },
  };
});
function locate(time: number) {
  const selected = selection.value;
  if (selected && (time < selected[0] || time > selected[1])) emit('range', ...domain.value);
  emit('seek', time);
}
// ECharts retains formatters across option updates. Build them outside draw's
// lexical environment so they cannot pin its complete source/visible session.
const sourceTimeLabel = (value: number) => value.toFixed(2) + ' s';
const coordinateLabel = (value: number) => value.toFixed(3);
const angleLabel = (value: number) => value + '°';
function showCursor(index: number) {
  if (!chart || sourceFrames !== props.frames || !props.frames[index]) {
    cursor.value = undefined;
    return;
  }
  const time = props.frames[index].time;
  const x = chart.convertToPixel({ xAxisIndex: 0 }, time);
  if (!Number.isFinite(x)) {
    cursor.value = undefined;
    return;
  }
  const coordinates = props.kind === 'center' || props.kind === 'point';
  const height = chart.getHeight() - temporalGrid.bottom;
  const values = sourceSeries.map(({ name, color, data }) => {
    const value = data[index]?.[1];
    const valid = value != null && Number.isFinite(value);
    const y = valid ? chart!.convertToPixel({ yAxisIndex: 0 }, value) : NaN;
    return {
      name,
      color: palette.value.series[color],
      text: valid ? value.toFixed(coordinates ? 4 : 1) + (coordinates ? '' : '°') : '—',
      y: y >= temporalGrid.top && y <= height ? y : null,
    };
  });
  cursor.value = { index, time, x, values };
}
function refreshCursor(force = false) {
  const [start, end] = cursorBounds.value;
  if (!chart || !props.active || !temporal.value || start >= end) {
    cursor.value = undefined;
    return;
  }
  if (pointerX !== undefined) {
    const x = Math.max(
      temporalGrid.left,
      Math.min(pointerX, chart.getWidth() - temporalGrid.right),
    );
    const time = chart.convertFromPixel({ xAxisIndex: 0 }, x);
    const index = Number.isFinite(time) ? nearestFrameIndex(props.frames, time, start, end) : -1;
    if (force || cursor.value?.index !== index) showCursor(index);
    return;
  }
  if (keyboardCursor.value && cursor.value) {
    showCursor(Math.max(start, Math.min(end - 1, cursor.value.index)));
    return;
  }
  const time = props.cursorTime;
  const index =
    time !== undefined && time >= props.frames[start]?.time && time <= props.frames[end - 1]?.time
      ? nearestFrameIndex(props.frames, time, start, end)
      : -1;
  if (force || cursor.value?.index !== index) showCursor(index);
}
function readPointer(event: PointerEvent, clamp: boolean) {
  if (!chart || !element.value || !temporal.value) return false;
  const rect = element.value.getBoundingClientRect();
  const point = [event.clientX - rect.left, event.clientY - rect.top];
  if (!clamp && !chart.containPixel({ gridIndex: 0 }, point)) return false;
  pointerX = point[0];
  refreshCursor();
  return true;
}
function clearPointer() {
  if (pointerX === undefined) return;
  pointerX = undefined;
  refreshCursor();
}
function movePointer(event: PointerEvent) {
  if (dragPointer.value === event.pointerId) readPointer(event, true);
  else if (event.pointerType !== 'touch' && !readPointer(event, false)) clearPointer();
}
function beginScrub(event: PointerEvent) {
  if (
    !event.isPrimary ||
    event.button !== 0 ||
    event.shiftKey ||
    cursorBounds.value[0] >= cursorBounds.value[1] ||
    !readPointer(event, false)
  )
    return;
  dragPointer.value = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function endScrub(event: PointerEvent) {
  if (dragPointer.value !== event.pointerId) return;
  dragPointer.value = undefined;
  if (event.type === 'pointerup') {
    readPointer(event, true);
    if (cursor.value) locate(cursor.value.time);
  }
  if (event.pointerType === 'touch' || event.type !== 'pointerup') clearPointer();
}
function focusCursor() {
  clearPointer();
  keyboardCursor.value = true;
  if (!cursor.value && cursorBounds.value[0] < cursorBounds.value[1])
    showCursor(cursorBounds.value[0]);
}
function blurCursor() {
  keyboardCursor.value = false;
  refreshCursor();
}
function moveKeyboardCursor(event: KeyboardEvent) {
  const [start, end] = cursorBounds.value;
  if (start >= end) return;
  const index = cursor.value?.index ?? start;
  const next = {
    Home: start,
    End: end - 1,
    ArrowLeft: Math.max(start, index - 1),
    ArrowRight: Math.min(end - 1, index + 1),
    ArrowDown: Math.max(start, index - 1),
    ArrowUp: Math.min(end - 1, index + 1),
  }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    pointerX = undefined;
    showCursor(next);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (cursor.value) locate(cursor.value.time);
  }
}
function trajectoryTooltip(p: unknown) {
  const v = (p as { value: number[] }).value;
  return `${v[2]!.toFixed(3)} s<br/>X ${v[0]!.toFixed(4)} · Y ${v[1]!.toFixed(4)}`;
}
function heatmapFormatters(heat: ReturnType<typeof velocityHeatmap>) {
  return {
    tooltip: (p: unknown) => {
      const c = (p as { data: { cell: (typeof heat.cells)[number] } }).data.cell;
      const bucket = heat.buckets[c.column]!;
      return `${JOINTS[c.row]!.label} · ${bucket[0].toFixed(3)}–${bucket[1].toFixed(3)} s<br/>${c.value === null ? '缺失 / 无有效速度' : `实际峰值 ${c.value.toFixed(3)} °/s${c.value > heat.cap ? '（颜色截顶）' : ''}`}<br/>有效 ${c.valid} / 缺失 ${c.missing} 侧样本`;
    },
    axis: (v: string) => `${heat.buckets[Number(v)]![0].toFixed(2)}s`,
  };
}
function draw() {
  if (!chart) return;
  const {
    chartAccent,
    chartMuted,
    chartSurface,
    chartTrack,
    chartHandle,
    chartFill,
    chartSelection,
    heatColors,
    series,
    tooltip,
    axis,
  } = palette.value;
  const frames = props.frames;
  const selected = selection.value;
  const grid = temporal.value ? temporalGrid : { ...temporalGrid, top: 24, bottom: 30 };
  note.value = '';
  if (!temporal.value) cursorBounds.value = [0, 0];
  if (props.kind === 'heatmap') {
    const visible = selected ? intervalFrames(frames, selected) : frames;
    empty.value = !visible.length;
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
    const format = heatmapFormatters(heat);
    applyOption({
      animation: false,
      grid: { left: 58, right: 18, top: 10, bottom: 62 },
      tooltip: {
        ...tooltip,
        formatter: format.tooltip,
      },
      xAxis: {
        ...axis,
        type: 'category',
        data: heat.buckets.map((_, i) => String(i)),
        splitLine: { show: false },
        axisLabel: {
          ...axis.axisLabel,
          interval: Math.max(0, Math.ceil(heat.buckets.length / 4) - 1),
          formatter: format.axis,
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
          textStyle: { color: chartMuted, fontSize: 10 },
          inRange: { color: heatColors },
        },
        {
          type: 'continuous',
          show: false,
          seriesIndex: 0,
          dimension: 2,
          min: 0,
          max: 1,
          inRange: { color: [chartTrack, chartTrack] },
        },
      ],
      series: [
        {
          id: 'missing-velocity',
          type: 'heatmap',
          data: cellData(true),
          itemStyle: { color: chartTrack, borderColor: chartSurface, borderWidth: 1 },
        },
        {
          id: 'valid-velocity',
          type: 'heatmap',
          data: cellData(false),
          itemStyle: { borderColor: chartSurface, borderWidth: 1 },
          progressive: 0,
        },
      ],
    });
    return;
  }
  if (props.kind === 'trajectory') {
    const visible = selected ? intervalFrames(frames, selected) : frames;
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
        ...tooltip,
        trigger: 'item',
        formatter: trajectoryTooltip,
      },
      xAxis: {
        ...axis,
        type: 'value',
        name: 'X →',
        min: bounds.x[0],
        max: bounds.x[1],
        axisLabel: { ...axis.axisLabel, formatter: coordinateLabel },
      },
      yAxis: {
        ...axis,
        type: 'value',
        name: 'Y ↓',
        inverse: true,
        min: bounds.y[0],
        max: bounds.y[1],
        axisLabel: { ...axis.axisLabel, formatter: coordinateLabel },
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
          lineStyle: { color: chartAccent, width: 2 },
          itemStyle: { color: chartAccent },
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
            color: 'center',
            data: frames.map((f) => [f.time, f.center?.y ?? null]),
          },
        ]
      : point
        ? (['x', 'y'] as const).map<TemporalSeries>((coordinate, i) => ({
            name: coordinate.toUpperCase(),
            color: i ? 'right' : 'left',
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
            .map<TemporalSeries>((side) => ({
              name: { left: '左侧', right: '右侧', midline: '中线' }[side],
              color: side === 'right' ? 'right' : 'left',
              data: frames.map<[number, number | null]>((f) => [
                f.time,
                angleValue(props.view?.basis === 'raw' ? f.rawAngles : f.angles, props.joint, side),
              ]),
            }));
    const breaks = frames.flatMap((f, i) => (i > 0 && f.samplingGapLimit !== null ? [i] : []));
    plotSeries = breaks.length
      ? sourceSeries.map((s) => {
          const data: typeof s.data = [];
          let next = 0;
          for (const [i, point] of s.data.entries()) {
            // The null point is display only; actual frame times remain unchanged.
            if (breaks[next] === i) {
              data.push([(s.data[i - 1][0] + point[0]) / 2, null]);
              next++;
            }
            data.push(point);
          }
          return { ...s, data };
        })
      : sourceSeries;
  }
  note.value = point
    ? `${props.pointBasis ?? 'filtered'} · X 向右、Y 向下 · 归一化坐标；低于置信阈值的点留空。`
    : center
      ? 'filtered · Y 向下 · 归一化坐标；缺失处断开。'
      : '';
  let aggregated = false;
  const display = plotSeries.map((s) => {
    const source = selected ? seriesInterval(s.data, selected) : s.data;
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
  const start = selected ? timeBound(frames, selected[0]) : 0;
  const end = selected ? timeBound(frames, selected[1], true) : frames.length;
  if (cursorBounds.value[0] !== start || cursorBounds.value[1] !== end)
    cursorBounds.value = [start, end];
  applyOption({
    animation: false,
    grid,
    tooltip: { show: false },
    xAxis: {
      ...axis,
      type: 'value',
      min: first,
      max: last > first ? last : first + 0.05,
      splitLine: { show: false },
      axisLabel: { ...axis.axisLabel, formatter: sourceTimeLabel },
    },
    yAxis: {
      ...axis,
      type: 'value',
      inverse: center || point,
      min: center || point ? extent[0] : 0,
      max: center || point ? extent[1] : 180,
      axisLabel: {
        ...axis.axisLabel,
        formatter: center || point ? coordinateLabel : angleLabel,
      },
    },
    dataZoom: [
      {
        type: 'inside',
        filterMode: 'none',
        moveOnMouseMove: 'shift',
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
        backgroundColor: chartTrack,
        fillerColor: chartSelection,
        handleStyle: { color: chartHandle, borderWidth: 0 },
        moveHandleStyle: { color: chartHandle },
        emphasis: { handleStyle: { color: chartAccent }, moveHandleStyle: { color: chartAccent } },
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
      showSymbol: end - start === 1,
      connectNulls: false,
      lineStyle: { width: 2, color: series[s.color] },
      itemStyle: { color: series[s.color] },
      areaStyle: center ? { color: chartFill } : undefined,
      markLine:
        i === 0
          ? {
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: chartMuted, type: 'dashed' },
              data: props.markers
                .filter((m) => m.time >= first && m.time <= last)
                .map((m) => ({ name: m.label, xAxis: m.time })),
            }
          : undefined,
    })),
  });
}
function initializeChart() {
  if (
    disposed ||
    !props.active ||
    chart ||
    !element.value?.clientWidth ||
    !element.value.clientHeight
  )
    return;
  if (!engine) {
    // Mount the controls and chart layout before loading the chart library.
    loading ??= import('../utils/chartEngine').then(
      (module) => {
        engine = module;
        initializeChart();
      },
      () => {
        if (!disposed) loadError.value = true;
      },
    );
    return;
  }
  chart = engine.initChart(element.value);
  chart.on('datazoom', (event: unknown) => {
    type Zoom = { start?: number; end?: number; startValue?: number; endValue?: number };
    const data = event as Zoom & { batch?: Zoom[] };
    const zoom = data.batch?.[0] ?? data;
    const [first, last] = domain.value;
    const axisEnd = last > first ? last : first + 0.05;
    const span = axisEnd - first;
    // The event already contains the value/percentage range on our fixed value
    // axis. getOption() clones every displayed series just to read two numbers.
    const start =
      zoom.startValue ?? (typeof zoom.start === 'number' ? first + (span * zoom.start) / 100 : NaN);
    const end =
      zoom.endValue ??
      (zoom.end === 100
        ? axisEnd
        : typeof zoom.end === 'number'
          ? first + (span * zoom.end) / 100
          : NaN);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      // ECharts wheel zoom can leave its endpoints a few ULPs inside the axis.
      const epsilon = 8 * Number.EPSILON * Math.max(1, Math.abs(first), Math.abs(axisEnd));
      emit(
        'range',
        Math.abs(start - first) <= epsilon ? first : start,
        Math.abs(end - axisEnd) <= epsilon ? axisEnd : end,
      );
    }
  });
  scheduleDraw(true);
}
function scheduleDraw(interactive = false) {
  dirty = true;
  if (!chart || !props.active) return;
  // Frame publications must not replace a queued seek, zoom or option change.
  if (trailing !== undefined && (!interactive || immediatePending)) return;
  clearTimeout(trailing);
  immediatePending = interactive;
  const wait = interactive ? 0 : Math.max(0, 250 - (performance.now() - lastRender));
  const render = () => {
    trailing = undefined;
    immediatePending = false;
    lastRender = performance.now();
    try {
      if (props.active) {
        draw();
        refreshCursor(true);
        dirty = false;
        pending.value = false;
      }
    } finally {
      renderWaiters.splice(0).forEach((resolve) => resolve());
    }
  };
  // Five linked charts otherwise execute inside one Vue flush. Coalesce mount,
  // resize and prop changes, then give each chart its own browser task.
  trailing = setTimeout(render, wait);
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!props.active || !element.value?.clientWidth || !element.value.clientHeight) return;
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
    if (!active) {
      pointerX = dragPointer.value = undefined;
      keyboardCursor.value = false;
      cursor.value = undefined;
      return;
    }
    if (dirty || !chart) {
      initializeChart();
      scheduleDraw(true);
    } else {
      // Page reveal can happen between ResizeObserver deliveries with unchanged
      // dimensions. Explicitly present the retained canvas in that case too.
      setTimeout(presentChart, 0);
      refreshCursor(true);
    }
  },
  { flush: 'post' },
);
watch(
  () => [props.frames, props.revision],
  (current, previous) => {
    if (current[0] !== previous[0]) {
      // Reset/recalculation replaces the array even while this chart is hidden.
      // Drop the old session immediately; an inactive chart may never draw again.
      sourceFrames = undefined;
      sourceSeries = [];
      plotSeries = [];
      sourceKey = '';
      cursor.value = undefined;
      cursorBounds.value = [0, 0];
    }
    scheduleDraw(current[0] !== previous[0]);
  },
);
watch(
  () => props.cursorTime,
  () => refreshCursor(),
);
watch(
  [
    theme,
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
  disposed = true;
  clearTimeout(trailing);
  trailing = undefined;
  renderWaiters.splice(0).forEach((resolve) => resolve());
  observer?.disconnect();
  chart?.dispose();
  chart = undefined;
});
</script>
<template>
  <div class="time-chart" :data-kind="kind ?? 'angle'">
    <div class="chart-surface">
      <div
        class="echart"
        :class="{
          'chart-expanded': expanded,
          'heatmap-chart': kind === 'heatmap',
          'temporal-plot': temporal,
          'is-scrubbing': dragPointer !== undefined && cursor,
        }"
        role="img"
        :aria-label="chartLabel"
        @pointermove="movePointer"
        @pointerleave="clearPointer"
        @pointerdown="beginScrub"
        @pointerup="endScrub"
        @pointercancel="endScrub"
        @lostpointercapture="endScrub"
      >
        <div ref="element" class="chart-engine" />
        <template v-if="temporal && cursor">
          <div
            class="chart-cursor"
            :style="{ transform: `translateX(${cursor.x}px)` }"
            aria-hidden="true"
          >
            <template v-for="value in cursor.values" :key="value.name">
              <span
                v-if="value.y !== null"
                class="chart-cursor-dot"
                :style="{
                  '--dot': value.color,
                  transform: `translate(-50%, ${value.y - temporalGrid.top}px) translateY(-50%)`,
                }"
              />
            </template>
          </div>
          <div class="chart-readout">
            <div class="chart-reading">
              <span>时间</span
              ><strong><RollingNumber :value="sourceTimeLabel(cursor.time)" /></strong>
            </div>
            <div v-for="value in cursor.values" :key="value.name" class="chart-reading">
              <span><i :style="{ background: value.color }" />{{ value.name }}</span>
              <strong><RollingNumber :value="value.text" /></strong>
            </div>
          </div>
        </template>
        <span v-else-if="temporal && cursorBounds[0] < cursorBounds[1]" class="chart-readout-hint"
          >横拖查看采样值，松开定位</span
        >
      </div>
      <div
        v-if="temporal && active && cursorBounds[0] < cursorBounds[1]"
        class="chart-keyboard"
        tabindex="0"
        role="slider"
        :aria-label="`${chartLabel}游标，方向键选择采样点，回车定位`"
        :aria-valuemin="frames[cursorBounds[0]]?.time"
        :aria-valuemax="frames[cursorBounds[1] - 1]?.time"
        :aria-valuenow="cursor?.time ?? frames[cursorBounds[0]]?.time"
        :aria-valuetext="
          cursor
            ? [
                sourceTimeLabel(cursor.time),
                ...cursor.values.map(
                  (value) => `${value.name} ${value.text === '—' ? '缺失' : value.text}`,
                ),
              ].join('，')
            : undefined
        "
        @focus="focusCursor"
        @blur="blurCursor"
        @keydown="moveKeyboardCursor"
      />
      <span v-if="loadError" class="chart-empty" role="alert">图表加载失败，请刷新页面重试。</span>
      <span v-else-if="pending" class="chart-loading">正在加载图表…</span>
      <span v-else-if="empty" class="chart-empty">暂无有效样本</span>
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
.echart {
  position: relative;
}
.chart-engine {
  position: absolute;
  inset: var(--readout-height, 0px) 0 0;
}
.temporal-plot {
  --readout-height: 42px;
  box-sizing: content-box;
  padding-top: var(--readout-height);
  touch-action: pan-y pinch-zoom;
}
.temporal-plot .chart-engine {
  cursor: crosshair;
}
.temporal-plot.is-scrubbing .chart-engine {
  cursor: grabbing;
  user-select: none;
}
.chart-keyboard {
  position: absolute;
  inset: 0;
  border-radius: 6px;
  pointer-events: none;
}
.chart-keyboard:focus-visible {
  outline: 2px solid var(--accent-mid);
  outline-offset: -3px;
}
.chart-cursor {
  position: absolute;
  left: 0;
  pointer-events: none;
  transition: transform 105ms cubic-bezier(0.2, 0.68, 0.32, 1);
  top: calc(var(--readout-height) + 24px);
  bottom: 42px;
  width: 1px;
  background: var(--accent-mid);
}
.chart-cursor-dot {
  position: absolute;
  top: 0;
  left: 50%;
  width: 9px;
  height: 9px;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--dot);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot), transparent 65%);
  transition: transform 105ms cubic-bezier(0.2, 0.68, 0.32, 1);
}
.chart-readout {
  position: absolute;
  top: 0;
  left: 18px;
  display: flex;
  gap: 12px;
  width: min(276px, calc(100% - 36px));
  height: 37px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--accent-dark);
  box-shadow: 0 3px 8px var(--shadow-soft);
}
.chart-readout-hint {
  position: absolute;
  top: 10px;
  left: 19px;
  color: var(--muted);
  font-size: 10px;
}
.chart-reading {
  display: grid;
  align-content: center;
  flex: 1;
  min-width: 0;
  gap: 2px;
}
.chart-reading > span {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 9px;
  white-space: nowrap;
}
.chart-reading i {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.chart-reading strong {
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.chart-empty,
.chart-loading {
  position: absolute;
  top: 44%;
  left: 50%;
  transform: translateX(-50%);
  color: var(--muted);
  font-size: 12px;
  pointer-events: none;
}
.chart-note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--muted);
  margin: 5px 18px 13px;
}
.chart-markers {
  margin: 0 24px 0 52px;
}
.heatmap-chart {
  height: 270px;
}
</style>
