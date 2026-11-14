<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  ref,
  shallowRef,
  shallowReactive,
  reactive,
  watch,
  nextTick,
} from 'vue';
import {
  ArrowLeftRight,
  ShieldCheck,
  ChevronDown,
  ArrowUpRight,
  ArrowDown,
  Settings2,
  BookOpen,
  Maximize2,
  Download,
  Video,
  Upload,
  FlaskConical,
  RotateCcw,
  Flag,
  Scissors,
  Check,
  MoveUpRight,
  Info,
  ScanLine,
  Clock3,
  Layers,
  Activity,
  Target,
  CheckCheck,
  Trash2,
  X,
  SlidersHorizontal,
  ChartNoAxesCombined,
  Bot,
  Moon,
  Sun,
} from 'lucide-vue-next';
import { ElMessage } from './ui';
import { theme, toggleTheme } from './theme';
import PoseStage from './components/PoseStage.vue';
import PlaybackTransport from './components/PlaybackTransport.vue';
import TimeChart from './components/TimeChart.vue';
import MarkerTimeline from './components/MarkerTimeline.vue';
import PoseCorrection from './components/PoseCorrection.vue';
import FloatingField from './components/FloatingField.vue';
import ExportDownload from './components/ExportDownload.vue';
import IconButton from './components/IconButton.vue';
import { WorkspaceApplicationError } from './agent/completion.ts';
import type { AgentRun } from './agent/runtime.ts';
import { DEFAULT_SETTINGS, JOINTS, MAX_FRAMES, POINT_NAMES } from './config';
import { DEMO_SIZE } from './utils/dimensions';
import { angleValue } from './utils/poseMath';
import { METRIC_VERSION } from './analysis/session';
import { sourceClock, sourceLabel, sourceTimeSpan } from './analysis/sourceDisplay';
import { createToolRegistry } from './analysis/tools';
import type { ChartView } from './analysis/tools';
import { intervalFrames, nearestFrameIndex, timeBound } from './analysis/frameIndex';
import { useSessionStore } from './composables/useSessionStore';
import { useCSVExport } from './composables/useCSVExport';
import { demoPose } from './utils/demo';
import type { Landmark, Joint, Marker, PoseFrame, Source, Channel } from './types';
import type { OfflineState, OfflineMetadata } from './video/protocol';

const brandMark = `${import.meta.env.BASE_URL}favicon.svg`;
const featureLoading = {
  delay: 0,
  loadingComponent: defineComponent({
    inheritAttrs: false,
    setup: () => () => h('p', { class: 'panel feature-status', role: 'status' }, '正在加载功能…'),
  }),
  errorComponent: defineComponent({
    inheritAttrs: false,
    setup: () => () =>
      h('p', { class: 'panel feature-status', role: 'alert' }, '功能加载失败，请刷新页面重试。'),
  }),
};
const PoseCompare = defineAsyncComponent({
  ...featureLoading,
  loader: () => import('./components/PoseCompare.vue'),
});
const AgentPanel = defineAsyncComponent({
  ...featureLoading,
  loader: () => import('./components/AgentPanel.vue'),
});
const nav = [
  {
    id: 'workspace',
    icon: ScanLine,
    label: '采集与分析',
    description: '采集姿态关键点，查看关节角度与重心变化。',
  },
  {
    id: 'analysis',
    icon: ChartNoAxesCombined,
    label: '时序可视化',
    description: '查看本次会话的关节角度、重心与统计指标。',
  },
  {
    id: 'compare',
    icon: ArrowLeftRight,
    label: '姿态对比',
    description: '对齐两段视频，查看动作差异出现的关节和时刻。',
  },
  {
    id: 'agent',
    icon: Bot,
    label: 'AI Agent 分析',
    description: '输入分析目标，由 Agent 调用本地工具计算指标。',
  },
  { id: 'export', icon: Download, label: '数据导出', description: '下载逐帧数据与可视化报告。' },
];
const page = ref('workspace'),
  source = ref<Source>('demo'),
  playing = ref(true),
  settingsOpen = ref(false),
  guideOpen = ref(false),
  exportOpen = ref(false),
  fullOpen = ref(false),
  busy = ref(false);
const currentPage = computed(() => nav.find((item) => item.id === page.value) ?? nav[0]!);
const settings = reactive({ ...DEFAULT_SETTINGS });
const joint = ref<Joint>('knee'),
  markers = ref<Marker[]>([]),
  sessionName = ref('合成姿态演示'),
  message = ref(''),
  range = ref<[number, number] | null>(null),
  clipStart = ref<number | null>(null),
  clipRange = ref<[number, number] | null>(null),
  seekTime = ref(8),
  selectedIndex = ref(-1),
  offlineSampleTotal = ref<number | null>(null);
const pointIndex = ref(15),
  pointBasis = ref<'raw' | 'filtered'>('filtered');
const analysisMounted = ref(false),
  agentMounted = ref(false);
const noMarkers: Marker[] = [];
watch(page, (value) => {
  if (value === 'analysis') analysisMounted.value = true;
  if (value === 'agent') agentMounted.value = true;
});
const stage = ref<InstanceType<typeof PoseStage>>();
const { session, frames, sessionInfo, summaryIndex, publishSession, publication } = useSessionStore(
  source.value,
  {
    threshold: settings.threshold,
    window: settings.window,
    aspect: DEMO_SIZE.width / DEMO_SIZE.height,
    metricVersion: METRIC_VERSION,
  },
);
// Replace the whole view and keep it cloneable for workspace observation.
const agentChart = shallowRef<ChartView | null>(null);
const agentSelection = computed<Omit<ChartView, 'interval'>>(
  () =>
    agentChart.value ?? {
      joint: joint.value,
      channels: joint.value === 'spine' ? ['midline'] : ['left', 'right'],
      basis: 'filtered',
    },
);
const agentTimeChart = ref<InstanceType<typeof TimeChart>>();
async function waitForAgentApplication(run: AgentRun) {
  await nextTick();
  if (run.calls.some((c) => c.name === 'set_chart_view' && c.output.ok)) {
    try {
      if (!agentTimeChart.value) throw new Error('AGENT_CHART_NOT_MOUNTED');
      await agentTimeChart.value.waitUntilRendered();
    } catch (error) {
      throw new WorkspaceApplicationError('set_chart_view', error);
    }
  }
  for (const call of run.calls) {
    if (call.output.ok && (call.name === 'prepare_report' || call.name === 'prepare_export')) {
      try {
        analysisTools.getArtifact((call.output.result as { handle: string }).handle);
      } catch (error) {
        throw new WorkspaceApplicationError(call.name, error);
      }
    }
  }
}
const syntheticFile = ref(false);
function fileProvenance() {
  playing.value = false;
  session.setFileSynthetic(syntheticFile.value);
  publishSession();
}
const analysisTools = createToolRegistry(session, {
  readWorkspace() {
    return {
      chart: agentChart.value,
      time: latest.value?.time ?? null,
    };
  },
  seekToTime(time) {
    const index = timeBound(session.frames, time);
    const before = session.frames[Math.max(0, index - 1)];
    const after = session.frames[Math.min(index, session.frames.length - 1)];
    const appliedTime =
      Math.abs(before.time - time) <= Math.abs(after.time - time) ? before.time : after.time;
    seek(appliedTime);
    return { appliedTime };
  },
  setChartView(view) {
    joint.value = view.joint;
    range.value = [...view.interval];
    agentChart.value = structuredClone(view);
    return structuredClone(view);
  },
});
let origin: number | null = null;
let cameraOffset = 0;
let lastCameraCaptureAt = 0;
// Corrections need every accepted camera sample, including invalid readings
// between the batched publications used by charts and the rest of the workspace.
const correctionCamera = shallowReactive<{ frame?: PoseFrame }>({});
const liveCorrection = computed(
  () => source.value === 'camera' && playing.value && selectedIndex.value < 0,
);
watch(
  playing,
  () => {
    correctionCamera.frame = undefined;
    if (!playing.value) publication.flush();
  },
  { flush: 'sync' },
);
const { csvProgress, csvState, csvMessage, csvFileStream, exportData, cancelCSV } = useCSVExport({
  session,
  tools: analysisTools,
  playing,
  visibleFrames: () => visibleFrames.value,
  markers,
  flush: () => publication.flush(),
});
const csvPercent = computed(() =>
  csvProgress.value?.total
    ? Math.min(99, Math.floor((csvProgress.value.rows / csvProgress.value.total) * 100))
    : 0,
);
const reportState = ref<'idle' | 'writing' | 'completed' | 'failed'>('idle');
const reportMessage = ref('');
function initializeDemo() {
  for (let i = 0; i < 160; i++) session.append(demoPose(i * 0.05), i * 0.05);
  publishSession();
}
initializeDemo();
const latest = computed(() =>
  selectedIndex.value >= 0 ? frames.value[selectedIndex.value] : frames.value.at(-1),
);
const duration = computed(() => frames.value.at(-1)?.time ?? 0);
const chartCursorTime = computed(() => (selectedIndex.value >= 0 ? latest.value?.time : undefined));
const playbackProgress = computed(() => {
  if (source.value !== 'file' || !offlineSampleTotal.value) return null;
  return Math.min(1, sessionInfo.value.sampleCount / offlineSampleTotal.value);
});
const confidence = computed(() => (latest.value ? latest.value.confidence * 100 : null));
const lowConfidenceCount = computed(
  () =>
    latest.value?.points.filter((p) => p.visibility <= 0 || p.visibility < settings.threshold)
      .length ?? 0,
);
const wholeSummary = computed(() => {
  void frames.value;
  return summaryIndex.query();
});
const meanAsym = computed(() => wholeSummary.value.meanAsym);
const visibleFrames = computed(() =>
  clipRange.value ? intervalFrames(frames.value, clipRange.value!) : frames.value,
);
const rangeFrames = computed(() =>
  range.value ? intervalFrames(visibleFrames.value, range.value!) : visibleFrames.value,
);
const formatTime = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(s % 60)
    .toString()
    .padStart(2, '0')}`;
const display = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : n.toFixed(digits);
const selectedInterval = computed<[number, number] | null>(() => {
  if (!range.value || !clipRange.value) return range.value ?? clipRange.value;
  return [
    Math.max(range.value[0], clipRange.value[0]),
    Math.min(range.value[1], clipRange.value[1]),
  ];
});
const selectedSummary = computed(() => {
  void frames.value;
  return selectedInterval.value ? summaryIndex.query(selectedInterval.value) : wholeSummary.value;
});
const centerScope = computed(() => {
  const interval = selectedInterval.value;
  if (!interval) return '完整会话';
  const [start, end] = interval;
  if (start > end) return '图表区间与当前片段无交集';
  const scope = range.value ? (clipRange.value ? '图表区间（片段内）' : '图表区间') : '当前片段';
  return `${scope} ${start.toFixed(2)}–${end.toFixed(2)} s`;
});
const fps = computed(() => {
  const last = frames.value.slice(-20);
  if (last.length < 2) return null;
  const elapsed = last.at(-1)!.time - last[0].time;
  return elapsed > 0 ? (last.length - 1) / elapsed : null;
});
const maxVelocity = computed(() => selectedSummary.value.maxVelocity);
const jointSummaries = computed(() => selectedSummary.value.joints);
const currentAngle = (key: Joint, side: Channel) =>
  latest.value ? angleValue(latest.value.angles, key, side) : null;
function recalculate() {
  playing.value = false;
  agentChart.value = null;
  session.recalculate({
    ...session.info().parameters,
    threshold: settings.threshold,
    window: settings.window,
  });
  publishSession();
  ElMessage.success('已用保存的原始样本统一重算；会话引用已更新，未重新解码视频。');
}
function capture(
  points: Landmark[],
  time: number,
  aspect: number,
  frameSource: Source,
  accept?: (frame?: PoseFrame) => void,
) {
  let acceptedFrame: PoseFrame | undefined;
  try {
    if (!playing.value || frameSource !== source.value) return;
    if (source.value === 'camera') {
      if (origin === null) origin = time;
      time = time - origin + cameraOffset;
    }
    if (session.frames.length >= MAX_FRAMES && source.value !== 'file') {
      playing.value = false;
      return;
    }
    const parameters = session.info().parameters;
    if (Math.abs(parameters.aspect - aspect) > 1e-8) {
      if (session.frames.length) {
        playing.value = false;
        ElMessage.warning('源画面比例变化，请显式重置会话后继续，避免混用几何口径。');
        return;
      }
      session.recalculate({ ...parameters, aspect });
    }
    try {
      if (!session.append(points, time)) return;
      acceptedFrame = session.frames.at(-1);
    } catch (error) {
      playing.value = false;
      ElMessage.error(`样本未写入：${error instanceof Error ? error.message : '未知错误'}`);
      return;
    }
    if (source.value === 'camera') {
      lastCameraCaptureAt = performance.now();
      correctionCamera.frame = acceptedFrame;
    }
    publication.schedule();
    selectedIndex.value = -1;
    if (session.frames.length >= MAX_FRAMES && source.value !== 'file') {
      playing.value = false;
      ElMessage.warning('已达到 18,000 帧上限，请导出或重置后继续。');
    }
  } finally {
    accept?.(acceptedFrame);
  }
}
function changeSource(value: Source) {
  if (source.value === value) return;
  playing.value = false;
  source.value = value;
  reset(false);
  sessionName.value =
    value === 'demo' ? '合成姿态演示' : value === 'camera' ? '实时摄像头' : '等待本地视频';
  if (value === 'demo') {
    initializeDemo();
    seekTime.value = 8;
    playing.value = true;
  }
}
function reset(resume = true, fileName?: string) {
  cancelCSV();
  publication.cancel();
  playing.value = false;
  session.reset(
    source.value,
    { ...session.info().parameters, threshold: settings.threshold, window: settings.window },
    fileName,
  );
  if (source.value === 'file') session.setFileSynthetic(syntheticFile.value);
  publishSession();
  markers.value = [];
  origin = null;
  cameraOffset = 0;
  lastCameraCaptureAt = 0;
  message.value = '';
  selectedIndex.value = -1;
  offlineSampleTotal.value = null;
  clipStart.value = null;
  clipRange.value = null;
  range.value = null;
  agentChart.value = null;
  stage.value?.reset();
  seekTime.value = 0;
  if (resume && source.value === 'demo') playing.value = true;
}
function togglePlay() {
  if (playing.value) {
    playing.value = false;
    return;
  }
  if (source.value === 'file' && stage.value?.isEnded()) {
    ElMessage.info('视频已结束；回看保留数据，重算请使用「重算指标」，重新采样请显式重置。');
    return;
  }
  selectedIndex.value = -1;
  if (session.frames.length >= MAX_FRAMES) {
    ElMessage.warning('请先导出并重置数据。');
    return;
  }
  if (source.value !== 'camera' && seekTime.value < duration.value) seekTime.value = duration.value;
  playing.value = true;
}
function mark() {
  if (!latest.value) {
    ElMessage.info('开始采集后可以添加标记。');
    return;
  }
  const marker = { time: latest.value.time, label: `标记 ${markers.value.length + 1}` };
  markers.value = [...markers.value, marker];
  ElMessage.success(`已添加 ${marker.label} · ${marker.time.toFixed(2)} s`);
}
function clip() {
  if (!latest.value) return;
  if (clipStart.value === null) {
    clipStart.value = latest.value.time;
    ElMessage.info('片段起点已记录，移动时间轴或继续分析，再次点击完成截取。');
  } else {
    const start = Math.min(clipStart.value, latest.value.time),
      end = Math.max(clipStart.value, latest.value.time);
    if (end - start < 0.05) {
      ElMessage.info('请选择不同的结束时刻。');
      return;
    }
    clipRange.value = [start, end];
    clipStart.value = null;
    ElMessage.success('已选中片段，图表和导出将使用此区间。');
  }
}
function seek(value: number | number[]) {
  if (Array.isArray(value)) return;
  playing.value = false;
  const index = nearestFrameIndex(frames.value, value);
  selectedIndex.value = index;
  seekTime.value = frames.value[index]?.time ?? value;
  // A repeated time (especially the initial 0 s) is still an explicit media
  // seek; a value-only prop watcher cannot represent that request.
  if (source.value === 'file') stage.value?.seekToTime(seekTime.value);
}
function agentRange(start: number, end: number) {
  agentChart.value = {
    ...agentSelection.value,
    interval: [start, end],
  };
}
function selectChartRange(start: number, end: number) {
  const first = visibleFrames.value[0]?.time;
  const last = visibleFrames.value.at(-1)?.time;
  range.value =
    first !== undefined && last !== undefined && start <= first && end >= last
      ? null
      : [start, end];
}
watch(clipRange, () => {
  range.value = null;
});
function status(text: string) {
  message.value = text;
}
function ready(name: string) {
  if (source.value === 'file') reset(false, name);
  if (source.value === 'camera') {
    const previous = session.frames.at(-1);
    // A replacement stream starts its media clock again at zero.
    if (previous) {
      cameraOffset =
        previous.time + Math.max(0.001, (performance.now() - lastCameraCaptureAt) / 1000);
      origin = null;
    }
  }
  sessionName.value = name;
}
function offlineStatus(state: OfflineState, metadata: OfflineMetadata | null) {
  if (source.value !== 'file' || state === 'idle') return;
  offlineSampleTotal.value = metadata?.sampleTotal ?? null;
  const sampled = metadata && metadata.sampleTotal < metadata.total;
  session.setAcquisition({
    mode: metadata?.transcoded
      ? sampled
        ? 'webcodecs-transcoded-sampled'
        : 'webcodecs-transcoded'
      : sampled
        ? 'webcodecs-sampled'
        : 'webcodecs',
    status: state,
    expectedFrames: metadata?.total ?? null,
    processedFrames: session.frames.length,
    codec: metadata?.codec ?? '',
    rotation: metadata?.rotation ?? 0,
    mediaTimeOffset: metadata?.mediaTimeOffset ?? 0,
  });
  publishSession();
}
async function redecode() {
  reset(false);
  await nextTick();
  playing.value = true;
}
async function report() {
  if (reportState.value === 'writing') return;
  const reportStage = stage.value;
  if (!reportStage?.canvas || !visibleFrames.value.length) {
    ElMessage.info('请先在采集页生成数据。');
    return;
  }
  reportState.value = 'writing';
  reportMessage.value = '正在生成图片报告…';
  try {
    playing.value = false;
    await nextTick();
    const reference = session.info(),
      frame = latest.value,
      samples = visibleFrames.value;
    const assertCurrent = () => {
      session.assertCurrent(reference);
      if (
        playing.value ||
        stage.value !== reportStage ||
        latest.value !== frame ||
        visibleFrames.value !== samples
      )
        throw new Error('报告画面或区间已改变，请重新生成。');
    };
    assertCurrent();
    const { exportReport } = await import('./utils/export');
    assertCurrent();
    await reportStage.waitUntilRendered();
    assertCurrent();
    await exportReport(reportStage.canvas, samples, reference.synthetic, {
      time: frame?.time,
      reference,
      assertCurrent,
    });
    reportState.value = 'completed';
    reportMessage.value = '图片报告已生成，已发起下载';
    ElMessage.success(reportMessage.value);
  } catch (error) {
    reportState.value = 'failed';
    reportMessage.value = `图片报告失败：${String(error)}`;
    ElMessage.error(reportMessage.value);
  }
}
watch(page, () => {
  if (page.value !== 'workspace') playing.value = false;
});
watch(
  () => [settings.window, settings.threshold],
  () => {
    try {
      recalculate();
    } catch {
      Object.assign(settings, {
        window: session.info().parameters.window,
        threshold: session.info().parameters.threshold,
      });
      ElMessage.error('参数无效，未改变会话指标。');
    }
  },
);
defineExpose({ analysisTools, sessionInfo });
</script>

<template>
  <div class="app-shell">
    <div
      v-if="csvState !== 'idle' && page !== 'export' && !exportOpen"
      class="csv-status"
      role="status"
      aria-live="polite"
    >
      <span>{{ csvMessage }}</span>
      <template v-if="csvProgress">
        <progress
          :value="
            csvState === 'completed'
              ? 100
              : Math.min(99, (csvProgress.rows / Math.max(1, csvProgress.total)) * 100)
          "
          max="100"
          aria-label="CSV 导出进度"
        />
        <small
          >{{ csvProgress.rows.toLocaleString() }} / {{ csvProgress.total.toLocaleString() }} 帧 ·
          {{ (csvProgress.bytes / 1048576).toFixed(2) }} MiB</small
        >
      </template>
      <button v-if="csvState === 'writing'" @click="cancelCSV">取消导出</button>
      <button v-else @click="csvState = 'idle'">关闭</button>
    </div>
    <div class="main-shell">
      <header class="topbar">
        <a class="brand" href="#" @click.prevent="page = 'workspace'">
          <img :src="brandMark" alt="" width="36" height="36" />
          <strong>Kinetic <span>动观</span></strong>
        </a>
        <nav class="topbar-nav" aria-label="主导航">
          <button
            v-for="item in nav"
            :key="item.id"
            type="button"
            :aria-label="item.label"
            :aria-current="page === item.id ? 'page' : undefined"
            :title="page === item.id ? undefined : item.label"
            @click="page = item.id"
          >
            <component :is="item.icon" :size="18" aria-hidden="true" />
            <span class="topbar-nav-label" aria-hidden="true"
              ><span>{{ item.label }}</span></span
            >
          </button>
        </nav>
        <div class="icon-actions">
          <button
            class="theme-toggle"
            type="button"
            aria-label="深色模式"
            :aria-pressed="theme === 'dark'"
            :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            <Sun :size="16" aria-hidden="true" />
            <Moon :size="16" aria-hidden="true" />
          </button>
          <IconButton label="使用指南" @click="guideOpen = true"><BookOpen /></IconButton>
          <IconButton label="分析设置" @click="settingsOpen = true"><Settings2 /></IconButton>
        </div>
      </header>
      <main>
        <div class="page-heading">
          <div>
            <h1>{{ currentPage.label }}</h1>
            <p>{{ currentPage.description }}</p>
          </div>
          <div v-if="page !== 'compare'" class="heading-actions">
            <a v-if="page === 'workspace'" class="capture-shortcut" href="#pose-capture">
              姿态采集<ArrowDown :size="14" />
            </a>
            <el-button @click="exportOpen = true">
              <Download :size="15" />导出数据<ChevronDown :size="13" />
            </el-button>
          </div>
        </div>

        <div
          v-show="page === 'workspace' || page === 'analysis'"
          class="dashboard"
          :class="{ 'dashboard-analysis': page === 'analysis' }"
        >
          <div class="dashboard-overview">
            <section class="metrics-grid" aria-label="会话指标概览">
              <article class="panel metric-card metric-primary">
                <h2 class="metric-label">关键点平均置信度<ScanLine :size="20" /></h2>
                <div class="metric-value">
                  {{ display(confidence) }}<span v-if="confidence !== null">%</span>
                </div>
                <div class="metric-context">
                  <div class="confidence-track" aria-hidden="true">
                    <span :style="{ width: `${confidence ?? 0}%` }" />
                  </div>
                  <small>{{
                    source === 'demo' ? '合成数据 · 不代表模型准确率' : '当前帧 33 个关键点平均值'
                  }}</small>
                </div>
              </article>
              <div class="metric-support">
                <article class="panel metric-card">
                  <h2 class="metric-label">已采集帧数<Layers :size="16" /></h2>
                  <div class="metric-value"
                    >{{ frames.length.toLocaleString() }}<span>帧</span></div
                  >
                  <small v-if="latest">
                    当前帧可用 {{ latest.points.length - lowConfidenceCount }} / 33 个关键点
                  </small>
                </article>
                <article class="panel metric-card">
                  <h2 class="metric-label">采样帧率<Activity :size="16" /></h2>
                  <div class="metric-value"
                    >{{ display(fps, 0) }}<span v-if="fps !== null">FPS</span></div
                  >
                  <small>按最近最多 20 帧估算</small>
                </article>
                <article class="panel metric-card">
                  <h2 class="metric-label">分析时长<Clock3 :size="16" /></h2>
                  <div class="metric-value">{{ formatTime(duration) }}</div>
                  <small>分钟 : 秒</small>
                </article>
                <article class="panel metric-card">
                  <h2 class="metric-label">平均左右不对称系数<ArrowLeftRight :size="16" /></h2>
                  <div class="metric-value"
                    >{{ display(meanAsym) }}<span v-if="meanAsym !== null">%</span></div
                  >
                  <small>
                    左右关节角差 / 180°
                    <el-tooltip content="各双侧关节角差的平均值；仅描述差异，不代表好坏。">
                      <Info :size="12" />
                    </el-tooltip>
                  </small>
                </article>
              </div>
            </section>
            <div v-if="clipRange" class="clip-banner"
              ><Scissors :size="15" />当前片段 {{ clipRange[0].toFixed(2) }}–{{
                clipRange[1].toFixed(2)
              }}
              s · {{ visibleFrames.length }} 帧<button @click="clipRange = null"
                >查看完整会话 <X :size="12" /></button
            ></div>
          </div>

          <div class="charts-layout">
            <section class="panel angle-panel"
              ><div class="panel-heading"
                ><div class="section-title"><span class="title-marker" /><h2>关节角度时序</h2></div
                ><div class="chart-tools"
                  ><span class="chart-legend"
                    ><i class="legend-dot blue" />{{ joint === 'spine' ? '中线' : '左侧'
                    }}<template v-if="joint !== 'spine'"
                      ><i class="legend-dot orange" />右侧</template
                    ></span
                  ><el-select
                    v-model="joint"
                    size="small"
                    aria-label="选择分析关节"
                    style="width: 100px"
                    ><el-option
                      v-for="item in JOINTS"
                      :key="item.key"
                      :label="item.label"
                      :value="item.key" /></el-select
                  ><IconButton label="放大角度图表" @click="fullOpen = true"
                    ><Maximize2 /></IconButton></div></div
              ><TimeChart
                :frames="visibleFrames"
                :revision="sessionInfo.revision"
                :joint="joint"
                :markers="markers"
                :interval="range"
                kind="angle"
                :active="page === 'workspace' || page === 'analysis'"
                :expanded="page === 'analysis'"
                :cursor-time="chartCursorTime"
                @seek="seek"
                @range="selectChartRange" /><div class="chart-footer"
                ><span><MoveUpRight :size="12" />Shift 拖动平移 · 滚轮缩放</span
                ><button v-if="page === 'workspace'" @click="page = 'analysis'"
                  >探索时序数据<ArrowUpRight :size="12" /></button></div
            ></section>
            <section class="panel motion-panel"
              ><div class="panel-heading"
                ><div class="section-title"><span class="title-marker" /><h2>重心起伏</h2></div
                ><span class="unit-label">Y / 归一化坐标</span></div
              ><TimeChart
                :frames="visibleFrames"
                :revision="sessionInfo.revision"
                :joint="joint"
                :markers="noMarkers"
                :interval="range"
                kind="center"
                :active="page === 'workspace' || page === 'analysis'"
                :expanded="page === 'analysis'"
                :cursor-time="chartCursorTime"
                @seek="seek"
                @range="selectChartRange"
              /><div class="center-chart-foot"
                ><span><i class="legend-dot mint" />纵向位置</span
                ><span
                  >波动范围 <b>{{ display(selectedSummary.centerRange, 4) }}</b></span
                ></div
              ><p class="center-stat-scope">统计范围：{{ centerScope }}</p></section
            >
          </div>

          <aside class="panel joints-panel" aria-labelledby="joints-title"
            ><div class="panel-heading"
              ><div class="section-title"
                ><span class="title-marker" /><h2 id="joints-title">当前帧关节数据</h2></div
              ><span class="live-label" :class="{ running: playing }"
                ><i />{{ playing ? '播放中' : '已暂停' }}</span
              ></div
            ><div class="joint-table-head"
              ><span>关节 (°)</span><span><i class="legend-dot blue" />左侧 / 中线</span
              ><span><i class="legend-dot orange" />右侧</span></div
            ><button
              v-for="item in JOINTS"
              :key="item.key"
              class="joint-row"
              :aria-pressed="joint === item.key"
              @click="joint = item.key"
              ><span>{{ item.label }}</span
              ><b class="left-value">{{
                display(currentAngle(item.key, item.key === 'spine' ? 'midline' : 'left'))
              }}</b
              ><b class="right-value">{{ display(currentAngle(item.key, 'right')) }}</b
              ><span class="joint-bar"
                ><i
                  :style="{
                    width:
                      ((currentAngle(item.key, item.key === 'spine' ? 'midline' : 'left') ?? 0) /
                        180) *
                        100 +
                      '%',
                  }" /><i
                  :style="{
                    width: ((currentAngle(item.key, 'right') ?? 0) / 180) * 100 + '%',
                  }" /></span></button
            ><div class="joint-footnote">角度已滤波，脊柱显示中线值。</div
            ><div class="center-summary"
              ><div class="subsection-title"><Target :size="15" /><b>近似重心</b></div
              ><div class="coordinate-row"
                ><div
                  ><small>X 坐标</small><b>{{ display(latest?.center?.x, 3) }}</b></div
                ><div
                  ><small>Y 坐标</small><b>{{ display(latest?.center?.y, 3) }}</b></div
                ></div
              ><p>归一化坐标，按左右髋部置信度加权</p></div
            ><div class="filter-status"
              ><div><CheckCheck :size="15" /><span>滑动均值滤波已启用</span></div
              ><span>{{ settings.window }} 帧窗口</span></div
            ></aside
          >

          <div v-show="page === 'workspace'" class="dashboard-capture">
            <section
              id="pose-capture"
              class="panel capture-panel"
              aria-labelledby="capture-title"
              tabindex="-1"
            >
              <div class="panel-heading capture-heading">
                <div class="section-title"
                  ><span class="title-marker" /><h2 id="capture-title">姿态采集</h2></div
                >
                <IconButton label="显示与分析设置" @click="settingsOpen = true">
                  <SlidersHorizontal />
                </IconButton>
              </div>
              <div class="source-toolbar">
                <div class="source-tabs" role="group" aria-label="采集来源">
                  <button
                    type="button"
                    :aria-pressed="source === 'demo'"
                    @click="changeSource('demo')"
                  >
                    <FlaskConical :size="14" />演示模式
                  </button>
                  <button
                    type="button"
                    :aria-pressed="source === 'camera'"
                    @click="changeSource('camera')"
                  >
                    <Video :size="14" />实时摄像头
                  </button>
                  <button
                    type="button"
                    :aria-pressed="source === 'file'"
                    @click="changeSource('file')"
                  >
                    <Upload :size="14" />上传视频
                  </button>
                </div>
              </div>
              <label
                v-if="source === 'file'"
                style="display: block; padding: 8px 18px; font-size: 12px"
              >
                <input v-model="syntheticFile" type="checkbox" @change="fileProvenance" />
                生成/合成视频素材（synthetic）
              </label>
              <PoseStage
                ref="stage"
                :source="source"
                :playing="playing"
                :settings="settings"
                :selected-frame="latest"
                :source-aspect="sessionInfo.parameters.aspect"
                :seek-time="seekTime"
                :session-id="sessionInfo.sessionId"
                @frame="capture"
                @status="status"
                @ready="ready"
                @ended="playing = false"
                @busy="busy = $event"
                @offline="offlineStatus"
              />
              <div class="capture-legend"
                ><span><i class="legend-dot mint" />人体骨骼</span
                ><span><i class="legend-dot amber" />近似重心</span
                ><span class="capture-quality"
                  ><i
                    class="mini-dot"
                    :class="
                      latest?.points.length === 33 && !lowConfidenceCount ? 'green-dot' : 'red-dot'
                    "
                  />{{
                    source === 'demo'
                      ? '合成序列 · 非推理结果'
                      : !latest
                        ? '等待采集'
                        : !latest.points.length
                          ? '当前帧无可用姿态'
                          : lowConfidenceCount
                            ? '部分关键点可用'
                            : '单人姿态 · 本地分析'
                  }}</span
                ></div
              >
              <div class="transport"
                ><PlaybackTransport
                  :playing="playing"
                  :busy="busy"
                  :time="latest?.time ?? 0"
                  :progress="playbackProgress"
                  @toggle="togglePlay"
                /><div class="transport-main"
                  ><IconButton label="重置会话" @click="reset()"><RotateCcw /></IconButton
                  ><button class="text-button" @click="recalculate">重算指标</button
                  ><button v-if="source === 'file'" class="text-button" @click="redecode">{{
                    sessionInfo.acquisition?.mode.endsWith('-sampled')
                      ? '重新抽样分析'
                      : '重新逐帧分析'
                  }}</button
                  ><span class="transport-divider" /><button class="text-button" @click="mark"
                    ><Flag :size="14" />手动打点</button
                  ><button
                    class="text-button clip-button"
                    :class="{ clipping: clipStart !== null }"
                    @click="clip"
                    ><Scissors :size="14" />{{
                      clipStart === null ? '截取片段' : '完成截取'
                    }}</button
                  ></div
                ><div class="timeline-row"
                  ><el-slider
                    :model-value="latest?.time ?? 0"
                    :min="0"
                    :max="Math.max(duration, 0.01)"
                    :step="0.01"
                    :show-tooltip="false"
                    aria-label="历史帧时间轴"
                    @input="seek"
                  /><span>{{ display(latest?.time ?? 0, 2) }} s</span></div
                ><div class="capture-marker-rail"
                  ><MarkerTimeline
                    :markers="markers"
                    :domain="[0, duration]"
                    :selection="
                      clipRange ??
                      (clipStart === null
                        ? null
                        : [
                            Math.min(clipStart, latest?.time ?? clipStart),
                            Math.max(clipStart, latest?.time ?? clipStart),
                          ])
                    "
                    @seek="seek" /></div
                ><div v-if="markers.length" class="marker-list"
                  ><button
                    v-for="(marker, index) in markers"
                    :key="index"
                    @click="seek(marker.time)"
                    ><Flag :size="10" />{{ marker.label }} · {{ marker.time.toFixed(1) }}s</button
                  ></div
                ></div
              >
              <div class="capture-tip"
                ><Info :size="13" /><span
                  >请保持单人全身入镜，正面或侧面视角更佳。角度为 2D 平面投影值。</span
                ></div
              >
            </section>
            <div v-if="message" class="status-message"
              ><Info :size="15" />{{ message
              }}<button aria-label="关闭提示" @click="message = ''"><X :size="14" /></button
            ></div>
            <div v-if="lowConfidenceCount > 0 && source !== 'demo'" class="status-message"
              ><Info :size="15" />{{
                lowConfidenceCount
              }}
              个关键点不可用，仍记录可测关节；缺失角度留空。请检查光照、遮挡和拍摄视角。</div
            >
            <PoseCorrection
              :frame="liveCorrection ? undefined : latest"
              :live="liveCorrection"
              :camera="correctionCamera"
            />
          </div>
        </div>

        <div v-if="analysisMounted" v-show="page === 'analysis'" class="analysis-bottom"
          ><section class="panel"
            ><div class="panel-heading"
              ><h2>关节活动幅度</h2
              ><span class="unit-label"
                >{{ range ? '图表区间与当前片段交集' : clipRange ? '当前片段' : '完整会话' }} · 单位
                °</span
              ></div
            ><div class="stats-table-wrap"
              ><table class="stats-table"
                ><thead
                  ><tr
                    ><th>关节</th><th>左侧 / 中线最小 / 最大</th><th>左侧 / 中线 ROM</th
                    ><th>右侧最小 / 最大</th><th>右侧 ROM</th><th>左侧 / 中线有效样本</th
                    ><th>右侧有效样本</th></tr
                  ></thead
                ><tbody
                  ><tr v-for="j in jointSummaries" :key="j.key"
                    ><td>{{ j.label }}{{ j.key === 'spine' ? '（中线）' : '' }}</td
                    ><td>{{ display(j.left.min) }} / {{ display(j.left.max) }}</td
                    ><td class="left-value">{{ display(j.left.rom) }}</td
                    ><td>{{ display(j.right.min) }} / {{ display(j.right.max) }}</td
                    ><td class="right-value">{{ display(j.right.rom) }}</td
                    ><td
                      >{{ j.left.sampleCount }} / {{ selectedSummary.sampleCount }} ·
                      {{ display(j.left.coverage === null ? null : j.left.coverage * 100) }}%</td
                    ><td
                      ><template v-if="j.key !== 'spine'"
                        >{{ j.right.sampleCount }} / {{ selectedSummary.sampleCount }} ·
                        {{
                          display(j.right.coverage === null ? null : j.right.coverage * 100)
                        }}%</template
                      ><template v-else>—</template></td
                    ></tr
                  ></tbody
                ></table
              ></div
            ><div class="info-line"
              >filtered ROM = 所选区间最大角度 − 最小角度（至少 2
              个有效样本）；低置信度或退化向量不参与统计。有效样本覆盖率的分母为当前统计区间内全部已采样帧（含未检出帧），不是源视频覆盖率或测量准确率；少量样本仍可能产生不稳定的
              ROM。二维投影受视角和遮挡影响。</div
            ></section
          ><section class="panel"
            ><div class="panel-heading"
              ><h2>角速度分布</h2><span class="unit-label">绝对值 · °/s</span></div
            ><TimeChart
              :frames="rangeFrames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="noMarkers"
              kind="heatmap"
              :active="page === 'analysis'"
            /><div class="info-line"
              >当前区间实际峰值 {{ display(maxVelocity) }} °/s（filtered）</div
            ><div class="panel-heading"><h2>重心轨迹</h2><span class="unit-label">X / Y</span></div
            ><TimeChart
              :frames="rangeFrames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="[]"
              kind="trajectory"
              :active="page === 'analysis'"
              :aspect="sessionInfo.parameters.aspect"
            /><div class="info-line"
              >坐标方差 raw {{ display(latest?.variance.raw.value, 6) }} / filtered
              {{ display(latest?.variance.filtered.value, 6) }}（归一化坐标²）。 配置窗口
              {{ settings.window }} 帧；当前 {{ latest?.variance.filtered.windowFrames ?? 0 }} 帧，
              {{ latest?.variance.filtered.validPoints ?? 0 }} 个有效点 /
              {{ latest?.variance.filtered.validSamples ?? 0 }} 点样本，
              {{ display(latest?.windowInterval[0], 2) }}–{{
                display(latest?.windowInterval[1], 2)
              }}
              s。运动与噪声均影响方差。</div
            ></section
          ></div
        >

        <section v-if="analysisMounted" v-show="page === 'analysis'" class="panel point-panel">
          <div class="panel-heading">
            <div class="section-title"><span class="title-marker" /><h2>关键点 X / Y 时序</h2></div>
            <div class="chart-tools">
              <span class="chart-legend"
                ><i class="legend-dot blue" />X<i class="legend-dot orange" />Y</span
              >
              <el-select
                v-model="pointIndex"
                size="small"
                aria-label="选择关键点"
                style="width: 190px"
                ><el-option
                  v-for="(name, index) in POINT_NAMES"
                  :key="name"
                  :label="`${index} · ${name}`"
                  :value="index"
              /></el-select>
              <el-select
                v-model="pointBasis"
                size="small"
                aria-label="关键点口径"
                style="width: 100px"
                ><el-option label="filtered" value="filtered" /><el-option label="raw" value="raw"
              /></el-select>
            </div>
          </div>
          <TimeChart
            :frames="visibleFrames"
            :revision="sessionInfo.revision"
            :joint="joint"
            :markers="markers"
            kind="point"
            :active="page === 'analysis'"
            :point-index="pointIndex"
            :point-basis="pointBasis"
            :threshold="sessionInfo.parameters.threshold"
            :interval="range"
            :cursor-time="chartCursorTime"
            expanded
            @range="selectChartRange"
            @seek="seek"
          />
        </section>

        <PoseCompare
          v-if="page === 'compare'"
          :settings="settings"
          @error="ElMessage.error($event)"
        />

        <AgentPanel
          v-if="agentMounted"
          v-show="page === 'agent'"
          :active="page === 'agent'"
          @manual="page = 'workspace'"
          @invalidate-view="agentChart = null"
          :session="session"
          :tools="analysisTools"
          :info="sessionInfo"
          :wait-for-application="waitForAgentApplication"
          @pause="playing = false"
          @export="exportData"
        >
          <section
            v-if="page === 'agent' && frames.length"
            id="agent-chart-view"
            class="panel"
            style="padding: 20px; margin-top: 18px"
          >
            <h2
              >Agent 视图 · {{ JOINTS.find((item) => item.key === agentSelection.joint)?.label }} ·
              {{ agentSelection.basis }} ·
              {{
                agentSelection.channels
                  .map((side) => ({ left: '左侧', right: '右侧', midline: '中线' })[side])
                  .join(' / ')
              }}</h2
            >
            <p
              >{{ sourceLabel(sessionInfo) }} · {{ sourceClock(sessionInfo) }} · 回看位置
              {{ display(latest?.time, 6) }} s · 图表区间
              <template v-if="!agentChart">完整会话 · </template>
              {{ sourceTimeSpan(agentChart?.interval ?? sessionInfo.range) }}</p
            >
            <TimeChart
              ref="agentTimeChart"
              :frames="frames"
              :revision="sessionInfo.revision"
              :joint="agentSelection.joint"
              :markers="markers"
              :view="agentChart"
              kind="angle"
              :cursor-time="chartCursorTime"
              expanded
              @range="agentRange"
              @seek="seek"
            />
            <el-button @click="page = 'workspace'">查看回看画面</el-button>
          </section>
        </AgentPanel>

        <div v-if="page === 'export'" class="export-page">
          <p class="export-summary">
            {{ sessionName }} · {{ visibleFrames.length.toLocaleString() }} 帧 ·
            {{ formatTime(duration) }}<template v-if="source === 'demo'"> · 合成数据</template>
          </p>
          <div class="export-options"
            ><section class="panel export-option"
              ><div class="file-type">CSV</div><h2>原始数据与量化指标</h2
              ><p
                >每帧 33 个关键点的 x / y / z /
                visibility、关节角度、角速度、重心、不对称系数、稳定性方差与手动标记。</p
              ><ul
                ><li><Check :size="14" />UTF-8 BOM，完整数值精度，分块写入</li
                ><li><Check :size="14" />保留低置信度原始点，计算缺失值留空</li
                ><li
                  ><Check :size="14" />{{ clipRange ? '导出当前截取片段' : '导出完整采集会话' }}</li
                ></ul
              ><ExportDownload
                :inert="exportOpen"
                format="CSV"
                label="下载 CSV 数据"
                :state="csvState"
                :percent="csvPercent"
                :message="csvMessage"
                :frame-count="visibleFrames.length"
                @download="exportData()"
                @cancel="cancelCSV" /></section
            ><section class="panel export-option"
              ><div class="file-type picture-type">PNG</div><h2>一页可视化报告</h2
              ><p
                >当前画布截图，以及时长、平均不对称系数、重心波动、各关节活动幅度与最大角速度汇总。</p
              ><ul
                ><li><Check :size="14" />直接在浏览器生成高清图片</li
                ><li><Check :size="14" />包含数据来源与 2D 量测限制说明</li
                ><li><Check :size="14" />适合研究记录与项目展示</li></ul
              ><ExportDownload
                :inert="exportOpen"
                format="PNG"
                label="下载图片报告"
                :state="reportState"
                :message="reportMessage"
                :frame-count="visibleFrames.length"
                @download="report" /></section></div
          ><section class="panel marker-panel"
            ><div class="panel-heading"
              ><h2>会话标记</h2><span class="tag">{{ markers.length }} 个节点</span></div
            ><div v-if="!markers.length" class="empty-markers"
              ><Flag :size="24" /><p>还没有手动标记</p
              ><span>在采集页点击「手动打点」，为你关注的时刻留下标记。</span></div
            ><div v-for="(marker, index) in markers" :key="index" class="export-marker"
              ><Flag :size="15" /><FloatingField
                v-slot="{ control }"
                :label="`标记 ${index + 1} 名称`"
                ><input v-bind="control" v-model="marker.label" maxlength="60" /></FloatingField
              ><span>{{ marker.time.toFixed(2) }} s</span
              ><IconButton label="删除标记" @click="markers = markers.filter((_, i) => i !== index)"
                ><Trash2 /></IconButton></div></section
        ></div>
      </main>
    </div>

    <el-drawer v-model="settingsOpen" title="分析与显示设置" size="360px"
      ><p class="drawer-intro"
        >参数变更会暂停采集，基于保存的 raw
        样本统一重算并更新引用；保留时间、标记和片段。回看不会重算，显式重置才清空数据。</p
      ><div class="setting-row"
        ><div><b>置信度阈值</b><p>低于阈值的点标红，不参与角度计算</p></div
        ><el-input-number
          v-model="settings.threshold"
          :min="0.1"
          :max="1"
          :step="0.05"
          :precision="2"
          controls-position="right" /></div
      ><div class="setting-row"
        ><div><b>滑动滤波窗口</b><p>以连续关键点均值减弱帧间抖动</p></div
        ><el-input-number
          v-model="settings.window"
          :min="1"
          :max="30"
          controls-position="right" /></div
      ><div class="setting-row"
        ><b>骨骼与关键点</b><el-switch v-model="settings.skeleton" aria-label="骨骼与关键点" /></div
      ><div class="setting-row"
        ><b>关节角度标注</b><el-switch v-model="settings.labels" aria-label="关节角度标注" /></div
      ><div v-if="settings.labels" class="label-joints"
        ><p>选择标注关节；自动避让并用引线连接。低置信度留空，脊柱仅中线。</p
        ><el-checkbox-group v-model="settings.labelJoints"
          ><el-checkbox v-for="item in JOINTS" :key="item.key" :value="item.key">{{
            item.label
          }}</el-checkbox></el-checkbox-group
        ></div
      ><div class="setting-row"
        ><b>近似重心轨迹</b
        ><el-switch v-model="settings.trajectory" aria-label="近似重心轨迹" /></div
      ><div class="info-box"
        ><ShieldCheck :size="20" /><p
          >推理资源在本地提供。视频文件与画面始终保留在浏览器内。刷新页面会清空本次采集。</p
        ></div
      ><el-button @click="Object.assign(settings, DEFAULT_SETTINGS)"
        >恢复默认设置</el-button
      ></el-drawer
    >
    <el-dialog v-model="guideOpen" title="开始你的第一次姿态观察" width="min(620px, 94vw)"
      ><div class="guide-content"
        ><div class="guide-step"
          ><span>01</span
          ><div
            ><h3>选择画面来源</h3
            ><p
              >演示模式使用明确标注的合成序列，无需摄像头。真实分析请切换到摄像头或上传
              MP4。单人全身入镜，正面或侧面视角更佳。</p
            ></div
          ></div
        ><div class="guide-step"
          ><span>02</span
          ><div
            ><h3>采集、观察、记录时刻</h3
            ><p
              >点击开始分析，在画布中查看骨骼与关节夹角。暂停后拖动时间轴查看已采集帧；手动打点可以为关键时刻命名。两次点击截取片段，分别记录起点和终点。</p
            ></div
          ></div
        ><div class="guide-step"
          ><span>03</span
          ><div
            ><h3>探索指标并导出</h3
            ><p
              >时序页支持选择关节和缩放时间区间；数据导出页可下载逐帧 CSV 或 PNG
              汇总报告。当前会话只保存在内存，刷新前请导出。</p
            ></div
          ></div
        ><div class="guide-limits"
          ><h3><Info :size="17" />理解量测边界</h3
          ><p
            >单目 2D
            投影角度不是真实三维角度，不等同专业动捕。左右髋中点只是重心近似。遮挡、光照和视角都会影响置信度；仅检测单人，多人会干扰结果。系统不识别运动类型、不判断动作对错、不内置运动知识库。连续分析最多
            18,000 帧。超过上限的本地视频会抽样覆盖全片，帧间快速动作可能漏采。</p
          ><a
            href="https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js"
            target="_blank"
            rel="noreferrer"
            >MediaPipe 官方文档 ↗</a
          ></div
        ></div
      ><template #footer
        ><el-button type="primary" @click="guideOpen = false">了解，开始观察</el-button></template
      ></el-dialog
    >
    <el-dialog v-model="exportOpen" title="导出本次分析" width="min(440px, calc(100vw - 24px))"
      ><p class="drawer-intro"
        >{{ source === 'demo' ? '合成演示数据' : '本地采集数据' }} · {{ visibleFrames.length }} 帧{{
          clipRange ? ' · 已选片段' : ''
        }}</p
      ><div class="export-dialog-options"
        ><ExportDownload
          v-if="exportOpen"
          format="CSV"
          :state="csvState"
          :percent="csvPercent"
          :message="csvMessage"
          :frame-count="visibleFrames.length"
          label="逐帧数据表"
          @download="exportData()"
          @cancel="cancelCSV" />
        <ExportDownload
          v-if="exportOpen"
          format="PNG"
          label="图片分析报告"
          :state="reportState"
          :message="reportMessage"
          :frame-count="visibleFrames.length"
          @download="report" /></div
      ><p class="export-hint"
        >{{
          csvFileStream
            ? 'CSV 优先选择位置分块写文件；受限时使用 Blob（完整文件驻留内存）。'
            : 'CSV 使用分块 Blob 下载，完整文件仍驻留内存。'
        }}
        支持取消；刷新前请保存数据。</p
      ></el-dialog
    >
    <el-dialog v-model="fullOpen" title="关节角度时序 · 区间探索" width="min(1100px, 95vw)"
      ><TimeChart
        v-if="fullOpen"
        :frames="visibleFrames"
        :revision="sessionInfo.revision"
        :joint="joint"
        :markers="markers"
        :interval="range"
        kind="angle"
        :cursor-time="chartCursorTime"
        expanded
        @range="selectChartRange"
        @seek="seek"
      /><p class="drawer-intro"
        >蓝色为左侧或脊柱中线，橙色为右侧；使用 filtered
        角度。横拖选择采样帧，松开定位回看。滚轮缩放，按住 Shift 拖动平移；低置信度帧显示为缺口。</p
      ></el-dialog
    >
  </div>
</template>
