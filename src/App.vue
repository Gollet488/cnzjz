<script setup lang="ts">
import { computed, ref, reactive, watch, nextTick } from 'vue';
import {
  Activity,
  LayoutDashboard,
  ChartNoAxesCombined,
  ArrowLeftRight,
  FolderDown,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Settings2,
  BookOpen,
  PanelLeftClose,
  Maximize2,
  Download,
  Video,
  Upload,
  FlaskConical,
  Play,
  Pause,
  RotateCcw,
  Flag,
  Scissors,
  Check,
  MoveUpRight,
  Info,
  Radio,
  ScanLine,
  Clock3,
  Layers,
  Target,
  CheckCheck,
  Trash2,
  X,
  SlidersHorizontal,
  Bot,
} from 'lucide-vue-next';
import { ElMessage } from './ui';
import PoseStage from './components/PoseStage.vue';
import TimeChart from './components/TimeChart.vue';
import MarkerTimeline from './components/MarkerTimeline.vue';
import PoseCompare from './components/PoseCompare.vue';
import AgentPanel from './components/AgentPanel.vue';
import type { AgentRun } from './agent/runtime.ts';
import { DEFAULT_SETTINGS, JOINTS, MAX_FRAMES, POINT_NAMES } from './config';
import { DEMO_SIZE } from './utils/dimensions';
import { angleValue } from './utils/poseMath';
import { METRIC_VERSION } from './analysis/session';
import { createToolRegistry } from './analysis/tools';
import type { ChartView } from './analysis/tools';
import { intervalFrames, timeBound } from './analysis/frameIndex';
import { useSessionStore } from './composables/useSessionStore';
import { useCSVExport } from './composables/useCSVExport';
import { demoPose } from './utils/demo';
import { exportReport } from './utils/export';
import type { Landmark, Joint, Marker, Source, Channel } from './types';
import type { OfflineState, OfflineMetadata } from './video/protocol';

const nav = [
  { id: 'workspace', label: '采集与分析', icon: LayoutDashboard },
  { id: 'analysis', label: '时序可视化', icon: ChartNoAxesCombined },
  { id: 'compare', label: '姿态对比', icon: ArrowLeftRight },
  { id: 'agent', label: 'AI Agent 分析', icon: Bot },
  { id: 'export', label: '数据导出', icon: FolderDown },
];
const page = ref('workspace'),
  source = ref<Source>('demo'),
  playing = ref(true),
  settingsOpen = ref(false),
  guideOpen = ref(false),
  exportOpen = ref(false),
  fullOpen = ref(false),
  sidebarOpen = ref(false),
  busy = ref(false);
const settings = reactive({ ...DEFAULT_SETTINGS });
const joint = ref<Joint>('knee'),
  markers = ref<Marker[]>([]),
  sessionName = ref('合成姿态演示'),
  message = ref(''),
  range = ref<[number, number] | null>(null),
  clipStart = ref<number | null>(null),
  clipRange = ref<[number, number] | null>(null),
  seekTime = ref(8),
  selectedIndex = ref(-1);
const pointIndex = ref(15),
  pointBasis = ref<'raw' | 'filtered'>('filtered');
const analysisMounted = ref(false);
watch(page, (value) => {
  if (value === 'analysis') analysisMounted.value = true;
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
const agentChart = ref<ChartView | null>(null);
const agentTimeChart = ref<InstanceType<typeof TimeChart>>();
async function waitForAgentApplication(run: AgentRun) {
  await nextTick();
  if (run.calls.some((c) => c.name === 'set_chart_view' && c.output.ok)) {
    if (!agentTimeChart.value) throw new Error('AGENT_CHART_NOT_MOUNTED');
    await agentTimeChart.value.waitUntilRendered();
  }
  for (const call of run.calls) {
    if (call.output.ok && ['prepare_report', 'prepare_export'].includes(call.name))
      analysisTools.getArtifact((call.output.result as { handle: string }).handle);
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
      chart: agentChart.value
        ? {
            joint: joint.value,
            channels: [...agentChart.value.channels],
            basis: agentChart.value.basis,
            interval: [...agentChart.value.interval] as [number, number],
          }
        : null,
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
watch(
  playing,
  () => {
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
function initializeDemo() {
  for (let i = 0; i < 160; i++) session.append(demoPose(i * 0.05), i * 0.05);
  publishSession();
}
initializeDemo();
const latest = computed(() =>
  selectedIndex.value >= 0 ? frames.value[selectedIndex.value] : frames.value.at(-1),
);
const duration = computed(() => frames.value.at(-1)?.time ?? 0);
const confidence = computed(() => (latest.value ? latest.value.confidence * 100 : 0));
const lowConfidenceCount = computed(
  () => latest.value?.points.filter((p) => p.visibility < settings.threshold).length ?? 0,
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
const visibleSummary = computed(() => {
  void frames.value;
  return clipRange.value ? summaryIndex.query(clipRange.value) : wholeSummary.value;
});
const selectedSummary = computed(() => {
  void frames.value;
  if (!range.value) return visibleSummary.value;
  const a = Math.max(range.value[0], clipRange.value?.[0] ?? -Infinity);
  const b = Math.min(range.value[1], clipRange.value?.[1] ?? Infinity);
  return summaryIndex.query([a, b]);
});
const centerRange = computed(() => visibleSummary.value.centerRange);
const fps = computed(() => {
  const last = frames.value.slice(-20);
  return last.length > 1 ? (last.length - 1) / (last.at(-1)!.time - last[0].time) : 0;
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
  accept?: (value: boolean) => void,
) {
  let accepted = false;
  try {
    if (!playing.value || frameSource !== source.value) return;
    if (source.value === 'camera') {
      if (origin === null) origin = time;
      time -= origin;
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
      accepted = true;
    } catch (error) {
      playing.value = false;
      ElMessage.error(`样本未写入：${error instanceof Error ? error.message : '未知错误'}`);
      return;
    }
    publication.schedule();
    selectedIndex.value = -1;
    if (session.frames.length >= MAX_FRAMES && source.value !== 'file') {
      playing.value = false;
      ElMessage.warning('已达到 18,000 帧上限，请导出或重置后继续。');
    }
  } finally {
    accept?.(accepted);
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
function reset(resume = true) {
  cancelCSV();
  publication.cancel();
  playing.value = false;
  session.reset(source.value, {
    ...session.info().parameters,
    threshold: settings.threshold,
    window: settings.window,
  });
  if (source.value === 'file') session.setFileSynthetic(syntheticFile.value);
  publishSession();
  markers.value = [];
  origin = null;
  message.value = '';
  selectedIndex.value = -1;
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
  let index = timeBound(frames.value, value);
  if (index >= frames.value.length) index = frames.value.length - 1;
  const before = frames.value[Math.max(0, index - 1)],
    after = frames.value[index];
  if (before && after && Math.abs(before.time - value) <= Math.abs(after.time - value))
    index = Math.max(0, index - 1);
  selectedIndex.value = index;
  seekTime.value = frames.value[index]?.time ?? value;
  // A repeated time (especially the initial 0 s) is still an explicit media
  // seek; a value-only prop watcher cannot represent that request.
  if (source.value === 'file') stage.value?.seekToTime(seekTime.value);
}
function agentRange(start: number, end: number) {
  agentChart.value = {
    ...(agentChart.value ?? {
      joint: joint.value,
      channels: joint.value === 'spine' ? ['midline'] : ['left', 'right'],
      basis: 'filtered',
    }),
    interval: [start, end],
  };
}
watch(clipRange, () => {
  range.value = null;
});
function status(text: string) {
  message.value = text;
}
function ready(name: string) {
  if (source.value === 'file') reset(false);
  sessionName.value = name;
}
function offlineStatus(state: OfflineState, metadata: OfflineMetadata | null) {
  if (source.value !== 'file' || state === 'idle') return;
  session.setAcquisition({
    mode: 'webcodecs',
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
  if (!stage.value?.canvas || !visibleFrames.value.length) {
    ElMessage.info('请先在采集页生成数据。');
    return;
  }
  playing.value = false;
  await nextTick();
  try {
    const reference = session.info(),
      time = latest.value?.time,
      samples = visibleFrames.value;
    const assertCurrent = () => {
      session.assertCurrent(reference);
      if (latest.value?.time !== time || visibleFrames.value !== samples)
        throw new Error('报告画面或区间已改变，请重新生成。');
    };
    await stage.value.waitUntilRendered();
    assertCurrent();
    await exportReport(stage.value.canvas, samples, reference.synthetic, {
      time,
      reference,
      assertCurrent,
    });
    ElMessage.success('图片报告已生成，已发起下载');
  } catch (error) {
    ElMessage.error(`图片报告失败：${String(error)}`);
  }
}
watch(page, () => {
  sidebarOpen.value = false;
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
    <div v-if="csvState !== 'idle'" class="csv-status" role="status" aria-live="polite">
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
    <div v-if="sidebarOpen" class="sidebar-shade" @click="sidebarOpen = false" />
    <aside class="sidebar" :class="{ opened: sidebarOpen }">
      <a class="brand" href="#" @click.prevent="page = 'workspace'"
        ><div class="brand-symbol"><Activity :size="24" stroke-width="2.3" /></div
        ><div
          ><strong>kinetic<span>动观</span></strong
          ><small>HUMAN MOTION LAB</small></div
        ></a
      >
      <div class="workspace-label"
        ><span class="workspace-avatar">K</span
        ><span>我的研究工作空间<small>个人空间 · 本地分析</small></span
        ><ChevronDown :size="14"
      /></div>
      <div class="nav-label">工作台 <span>WORKSPACE</span></div>
      <nav
        ><button
          v-for="item in nav"
          :key="item.id"
          :class="{ active: page === item.id }"
          @click="page = item.id"
          ><component :is="item.icon" :size="19" /><span>{{ item.label }}</span
          ><span v-if="item.id === 'workspace'" class="nav-count">01</span
          ><ChevronRight v-else :size="13" class="nav-chevron" /></button
      ></nav>
      <div class="nav-label session-label">当前会话 <i /></div>
      <button class="session-item" @click="page = 'workspace'"
        ><span class="session-dot" /><div
          >{{ sessionName
          }}<small
            >{{ frames.length.toLocaleString() }} 帧 ·
            {{ source === 'demo' ? '演示数据' : '本地数据' }}</small
          ></div
        ><ChevronRight :size="13"
      /></button>
      <div class="sidebar-bottom"
        ><div class="privacy-card"
          ><div><ShieldCheck :size="19" /><b>让数据留在你手中</b></div
          ><p>所有姿态推理在浏览器内完成，<br />视频与原始画面不会上传。</p
          ><span>本地计算，隐私优先 <ArrowUpRight :size="13" /></span></div
        ><button class="utility-link" @click="guideOpen = true"
          ><BookOpen :size="17" />使用指南 <ArrowUpRight :size="14" /></button
        ><button class="utility-link" @click="settingsOpen = true"
          ><Settings2 :size="17" />分析设置 <span class="version">v0.1 DEMO</span></button
        ><div class="user-row"
          ><div class="avatar">研</div><div><b>研究者</b><small>本地研究工作空间</small></div
          ><span class="user-online" /></div
      ></div>
    </aside>

    <div class="main-shell">
      <header class="topbar"
        ><div class="breadcrumbs"
          ><button class="mobile-toggle" aria-label="展开导航" @click="sidebarOpen = !sidebarOpen"
            ><PanelLeftClose :size="19" /></button
          ><span>工作空间</span><ChevronRight :size="13" /><b>{{
            nav.find((n) => n.id === page)?.label
          }}</b></div
        ><div class="topbar-right"
          ><span class="privacy-status"><ShieldCheck :size="14" />隐私保护已开启</span
          ><span class="topbar-divider" /><span class="project-tag">传智杯 · AI WEB</span
          ><div class="small-avatar">研</div></div
        ></header
      >
      <main>
        <div class="page-heading"
          ><div
            ><div class="eyebrow">OBSERVE. MEASURE. UNDERSTAND.</div
            ><h1>{{
              page === 'workspace'
                ? '每一帧，都有迹可循。'
                : page === 'analysis'
                  ? '从变化中，读懂运动。'
                  : page === 'compare'
                    ? '并肩观察，量化差异。'
                    : page === 'agent'
                      ? '从目标，到有据的分析。'
                      : '把观察，变成可用的数据。'
            }}</h1
            ><p>{{
              page === 'workspace'
                ? '通用人体姿态量化分析 · 让运动中的几何关系清晰可见'
                : page === 'analysis'
                  ? '探索关节角度、重心与时序变化，所有指标均来自本次会话。'
                  : page === 'compare'
                    ? '使用你提供的两段视频，观察姿态序列的几何相似程度。'
                    : page === 'agent'
                      ? '由模型动态选择本地工具，以真实计算结果完成分析目标。'
                      : '将原始关键点与计算指标带入你的下一步研究。'
            }}</p></div
          ><div class="heading-actions"
            ><span class="local-badge"><i />浏览器本地运行</span
            ><el-button @click="exportOpen = true"
              ><Download :size="15" />导出数据<ChevronDown :size="13" /></el-button></div
        ></div>

        <template v-if="page === 'workspace' || page === 'analysis'">
          <div class="metrics-grid">
            <article class="metric-card"
              ><div class="metric-label">关键点平均置信度<ScanLine :size="16" /></div
              ><div class="metric-value"
                >{{ frames.length ? confidence.toFixed(1) : '—' }}<span>%</span
                ><svg viewBox="0 0 90 30" class="spark green">
                  <path
                    d="M0 26 9 22 17 24 26 13 33 17 42 14 49 18 58 9 67 13 75 4 90 7"
                  /></svg></div
              ><small
                ><span class="mini-dot green-dot" />{{
                  source === 'demo' ? '合成数据 · 不代表模型准确率' : '当前帧 33 个关键点平均值'
                }}</small
              ></article
            >
            <article class="metric-card"
              ><div class="metric-label">已采集帧数<Layers :size="16" /></div
              ><div class="metric-value"
                >{{ frames.length.toLocaleString() }}<span>帧</span
                ><span class="metric-badge">{{ display(fps, 0) }} FPS</span></div
              ><small
                >33 个姿态关键点 / 帧
                <span class="quiet"
                  >· {{ source === 'demo' ? '演示序列' : '单人姿态' }}</span
                ></small
              ></article
            >
            <article class="metric-card"
              ><div class="metric-label">分析时长<Clock3 :size="16" /></div
              ><div class="metric-value tabular"
                >{{ formatTime(duration) }}<span class="metric-time-unit">min : sec</span></div
              ><small
                ><span class="mini-dot" :class="playing ? 'green-dot' : 'gray-dot'" />{{
                  playing ? '正在持续采集' : '采集已暂停'
                }}
                <span class="quiet"
                  >· {{ source === 'demo' ? '演示模式' : '本地模式' }}</span
                ></small
              ></article
            >
            <article class="metric-card"
              ><div class="metric-label">平均左右不对称系数<ArrowLeftRight :size="16" /></div
              ><div class="metric-value"
                >{{ display(meanAsym) }}<span>%</span
                ><div class="asym-bars"><i /><i /><i /><i /><i /><i /><i /></div></div
              ><small
                >左右关节角差 / 180°
                <el-tooltip content="各双侧关节角差的平均值；仅描述差异，不代表好坏。"
                  ><Info :size="12" /></el-tooltip></small
            ></article>
          </div>
        </template>

        <div v-show="page === 'workspace'" class="capture-layout">
          <section class="panel capture-panel">
            <div class="panel-heading capture-heading"
              ><div class="section-title"
                ><span class="title-marker" /><h2>姿态采集</h2
                ><span class="tag">LIVE CAPTURE</span></div
              ><button class="icon-button" aria-label="画布使用说明" @click="guideOpen = true"
                ><Info :size="17" /></button
            ></div>
            <div class="source-toolbar"
              ><div class="source-tabs"
                ><button :class="{ selected: source === 'demo' }" @click="changeSource('demo')"
                  ><FlaskConical :size="14" />演示模式</button
                ><button :class="{ selected: source === 'camera' }" @click="changeSource('camera')"
                  ><Video :size="14" />实时摄像头</button
                ><button :class="{ selected: source === 'file' }" @click="changeSource('file')"
                  ><Upload :size="14" />上传视频</button
                ></div
              ><el-tooltip content="骨骼、角度标注、平滑窗口与置信阈值"
                ><button
                  class="icon-button"
                  aria-label="显示与分析设置"
                  @click="settingsOpen = true"
                  ><SlidersHorizontal :size="16" /></button></el-tooltip
            ></div>
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
              :selected-points="latest?.points"
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
                  :class="confidence >= settings.threshold * 100 ? 'green-dot' : 'red-dot'"
                />{{
                  source === 'demo'
                    ? '合成序列 · 非推理结果'
                    : confidence < settings.threshold * 100
                      ? '置信度偏低，请调整光照与遮挡'
                      : '单人姿态 · 本地分析'
                }}</span
              ></div
            >
            <div class="transport"
              ><div class="transport-row"
                ><div class="transport-main"
                  ><el-button type="primary" :loading="busy" @click="togglePlay"
                    ><component :is="playing ? Pause : Play" :size="15" fill="currentColor" />{{
                      playing ? '暂停分析' : '开始分析'
                    }}</el-button
                  ><el-tooltip content="清空本次会话数据并从头开始"
                    ><button class="icon-button reset-button" aria-label="重置会话" @click="reset()"
                      ><RotateCcw :size="16" /></button></el-tooltip
                  ><button class="text-button" @click="recalculate">重算指标</button
                  ><button v-if="source === 'file'" class="text-button" @click="redecode"
                    >重新逐帧分析</button
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
                ><span class="transport-time"
                  >{{ formatTime(latest?.time ?? 0) }}
                  <span>/ {{ formatTime(duration) }}</span></span
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
                ><button v-for="(marker, index) in markers" :key="index" @click="seek(marker.time)"
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

          <aside class="panel joints-panel"
            ><div class="panel-heading"
              ><div class="section-title"><span class="title-marker" /><h2>实时关节数据</h2></div
              ><span class="live-label"><i />{{ playing ? 'LIVE' : 'PAUSED' }}</span></div
            ><div class="joint-intro"><span>关节夹角</span><small>单位：°</small></div
            ><div class="joint-table-head"
              ><span>关节</span><span><i class="legend-dot blue" />左侧 / 中线</span
              ><span><i class="legend-dot orange" />右侧</span></div
            ><button
              v-for="item in JOINTS"
              :key="item.key"
              class="joint-row"
              :class="{ highlight: joint === item.key }"
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
            ><div class="joint-footnote">当前显示 filtered 角度；脊柱只显示一个中线值。</div
            ><div class="center-summary"
              ><div class="subsection-title"
                ><Target :size="15" /><b>近似重心</b><span>HIP CENTER</span></div
              ><div class="coordinate-row"
                ><div
                  ><small>X 坐标</small
                  ><b>{{ display(latest?.center?.x, 3) }}<span>norm</span></b></div
                ><div
                  ><small>Y 坐标</small
                  ><b>{{ display(latest?.center?.y, 3) }}<span>norm</span></b></div
                ></div
              ><p>以左右髋部置信度加权估算</p></div
            ><div class="filter-status"
              ><div><CheckCheck :size="15" /><span>滑动均值滤波已启用</span></div
              ><span>{{ settings.window }} 帧窗口</span></div
            ></aside
          >
        </div>

        <div v-if="message && page === 'workspace'" class="status-message"
          ><Info :size="15" />{{ message
          }}<button aria-label="关闭提示" @click="message = ''"><X :size="14" /></button
        ></div>
        <div
          v-if="lowConfidenceCount > 0 && source !== 'demo' && page === 'workspace'"
          class="status-message"
          ><Info :size="15" />{{
            lowConfidenceCount
          }}
          个关键点低于置信阈值，相关关节角度留空。请调整光照、遮挡或拍摄视角。</div
        >
        <div v-if="clipRange && (page === 'workspace' || page === 'analysis')" class="clip-banner"
          ><Scissors :size="15" />当前片段 {{ clipRange[0].toFixed(2) }}–{{
            clipRange[1].toFixed(2)
          }}
          s · {{ visibleFrames.length }} 帧<button @click="clipRange = null"
            >查看完整会话 <X :size="12" /></button
        ></div>

        <div
          v-show="page === 'workspace' || page === 'analysis'"
          class="charts-layout"
          :class="{ 'analysis-charts': page === 'analysis' }"
        >
          <section class="panel angle-panel"
            ><div class="panel-heading"
              ><div class="section-title"
                ><span class="title-marker" /><h2>关节角度时序</h2
                ><span class="tag">ANGLE / TIME</span></div
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
                ><button class="icon-button" aria-label="放大角度图表" @click="fullOpen = true"
                  ><Maximize2 :size="14" /></button></div></div
            ><TimeChart
              :frames="visibleFrames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="markers"
              :interval="range"
              kind="angle"
              :active="page === 'workspace' || page === 'analysis'"
              :expanded="page === 'analysis'"
              @seek="seek"
              @range="(a, b) => (range = [a, b])" /><div class="chart-footer"
              ><span><MoveUpRight :size="12" />滚轮缩放 · 拖动底部滑块选择时间区间</span
              ><button @click="page = 'analysis'"
                >{{ page === 'analysis' ? '详细统计见下方' : '探索时序数据'
                }}<ArrowUpRight :size="12" /></button></div
          ></section>
          <section class="panel motion-panel"
            ><div class="panel-heading"
              ><div class="section-title"><span class="title-marker" /><h2>重心起伏</h2></div
              ><span class="unit-label">Y / 归一化坐标</span></div
            ><TimeChart
              :frames="visibleFrames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="[]"
              :interval="range"
              kind="center"
              :active="page === 'workspace' || page === 'analysis'"
              @range="(a, b) => (range = [a, b])"
            /><div class="center-chart-foot"
              ><span><i class="legend-dot mint" />纵向位置</span
              ><span
                >波动范围 <b>{{ display(centerRange, 4) }}</b></span
              ></div
            ></section
          >
        </div>

        <div v-if="analysisMounted" v-show="page === 'analysis'" class="analysis-bottom"
          ><section class="panel"
            ><div class="panel-heading"
              ><h2>关节活动幅度</h2
              ><span class="unit-label"
                >{{ range ? '图表选中区间' : '完整会话' }} · 单位 °</span
              ></div
            ><div class="stats-table-wrap"
              ><table class="stats-table"
                ><thead
                  ><tr
                    ><th>关节</th><th>左侧 / 中线最小 / 最大</th><th>左侧 / 中线 ROM</th
                    ><th>右侧最小 / 最大</th><th>右侧 ROM</th></tr
                  ></thead
                ><tbody
                  ><tr v-for="j in jointSummaries" :key="j.key"
                    ><td>{{ j.label }}{{ j.key === 'spine' ? '（中线）' : '' }}</td
                    ><td>{{ display(j.left.min) }} / {{ display(j.left.max) }}</td
                    ><td class="left-value">{{ display(j.left.rom) }}</td
                    ><td>{{ display(j.right.min) }} / {{ display(j.right.max) }}</td
                    ><td class="right-value">{{ display(j.right.rom) }}</td></tr
                  ></tbody
                ></table
              ></div
            ><div class="info-line"
              >filtered ROM = 所选区间最大角度 − 最小角度（至少 2
              个有效样本）；低置信度或退化向量不参与统计。</div
            ></section
          ><section class="panel"
            ><div class="panel-heading"
              ><h2>角速度分布</h2><span class="unit-label">绝对值 · °/s</span></div
            ><TimeChart
              :frames="rangeFrames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="[]"
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
            expanded
            @range="(a, b) => (range = [a, b])"
            @seek="seek"
          />
        </section>

        <PoseCompare
          v-if="page === 'compare'"
          :settings="settings"
          @error="ElMessage.error($event)"
        />

        <AgentPanel
          v-show="page === 'agent'"
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
              >Agent 视图 · {{ JOINTS.find((item) => item.key === joint)?.label }} ·
              {{ agentChart?.basis ?? 'filtered' }} ·
              {{
                agentChart?.channels
                  .map((side) => ({ left: '左侧', right: '右侧', midline: '中线' })[side])
                  .join(' / ') ?? '左侧 / 右侧'
              }}</h2
            >
            <p
              >回看位置 {{ display(latest?.time, 3) }} s · 图表区间
              {{ agentChart?.interval.join('–') ?? '完整会话' }} s</p
            >
            <TimeChart
              ref="agentTimeChart"
              :frames="frames"
              :revision="sessionInfo.revision"
              :joint="joint"
              :markers="markers"
              :view="agentChart"
              kind="angle"
              expanded
              @range="agentRange"
              @seek="seek"
            />
            <el-button @click="page = 'workspace'">查看回看画面</el-button>
          </section>
        </AgentPanel>

        <div v-if="page === 'export'" class="export-page"
          ><div class="export-summary panel"
            ><div class="export-icon"><FolderDown :size="30" /></div
            ><div
              ><span class="eyebrow">YOUR DATA, YOUR NEXT STEP</span><h2>本次观察，已经准备好。</h2
              ><p
                >{{ sessionName }} · {{ visibleFrames.length.toLocaleString() }} 帧 ·
                {{ formatTime(duration)
                }}<span v-if="source === 'demo'" class="tag">合成演示数据</span></p
              ></div
            ><div class="export-summary-mark"
              ><ShieldCheck :size="36" /><span>LOCAL ONLY</span></div
            ></div
          ><div class="export-options"
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
              ><el-button
                type="primary"
                :disabled="!visibleFrames.length || csvState === 'writing'"
                @click="exportData"
                ><Download :size="15" />下载 CSV 数据</el-button
              ></section
            ><section class="panel export-option"
              ><div class="file-type picture-type">PNG</div><h2>一页可视化报告</h2
              ><p
                >当前画布截图，以及时长、平均不对称系数、重心波动、各关节活动幅度与最大角速度汇总。</p
              ><ul
                ><li><Check :size="14" />直接在浏览器生成高清图片</li
                ><li><Check :size="14" />包含数据来源与 2D 量测限制说明</li
                ><li><Check :size="14" />适合研究记录与项目展示</li></ul
              ><el-button :disabled="!visibleFrames.length" @click="report"
                ><Download :size="15" />下载图片报告</el-button
              ></section
            ></div
          ><section class="panel marker-panel"
            ><div class="panel-heading"
              ><h2>会话标记</h2><span class="tag">{{ markers.length }} 个节点</span></div
            ><div v-if="!markers.length" class="empty-markers"
              ><Flag :size="24" /><p>还没有手动标记</p
              ><span>在采集页点击「手动打点」，为你关注的时刻留下标记。</span></div
            ><div v-for="(marker, index) in markers" :key="index" class="export-marker"
              ><Flag :size="15" /><input
                v-model="marker.label"
                :aria-label="`标记 ${index + 1} 名称`"
                maxlength="60" /><span>{{ marker.time.toFixed(2) }} s</span
              ><button
                class="icon-button"
                aria-label="删除标记"
                @click="markers = markers.filter((_, i) => i !== index)"
                ><Trash2 :size="14" /></button></div></section
        ></div>

        <div v-if="page === 'workspace'" class="bottom-insight"
          ><div
            ><Radio :size="16" /><span>专注客观量化，让解读保留空间。</span
            ><small>不识别运动类型，不预设动作标准，不做对错评分。</small></div
          ><button @click="guideOpen = true">了解分析边界 <ArrowUpRight :size="13" /></button
        ></div>
        <footer
          ><span><Activity :size="12" />KINETIC 动观 <span>·</span> 通用人体姿态量化分析平台</span
          ><span>Vue 3 <i /> MediaPipe <i /> ECharts <b>FRONTEND ONLY</b></span></footer
        >
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
      ><div class="setting-row"><b>骨骼与关键点</b><el-switch v-model="settings.skeleton" /></div
      ><div class="setting-row"><b>关节角度标注</b><el-switch v-model="settings.labels" /></div
      ><div v-if="settings.labels" class="label-joints"
        ><p>选择标注关节；自动避让并用引线连接。低置信度留空，脊柱仅中线。</p
        ><el-checkbox-group v-model="settings.labelJoints"
          ><el-checkbox v-for="item in JOINTS" :key="item.key" :value="item.key">{{
            item.label
          }}</el-checkbox></el-checkbox-group
        ></div
      ><div class="setting-row"><b>近似重心轨迹</b><el-switch v-model="settings.trajectory" /></div
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
            18,000 帧。</p
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
    <el-dialog v-model="exportOpen" title="导出本次分析" width="440px"
      ><p class="drawer-intro"
        >{{ source === 'demo' ? '合成演示数据' : '本地采集数据' }} · {{ visibleFrames.length }} 帧{{
          clipRange ? ' · 已选片段' : ''
        }}</p
      ><div class="export-dialog-options"
        ><button :disabled="!visibleFrames.length || csvState === 'writing'" @click="exportData"
          ><span class="file-type">CSV</span
          ><div><b>逐帧数据表</b><small>33 个原始关键点 + 全部量化指标</small></div
          ><Download :size="17" /></button
        ><button :disabled="!visibleFrames.length" @click="report"
          ><span class="file-type picture-type">PNG</span
          ><div><b>图片分析报告</b><small>当前画布 + 会话汇总指标</small></div
          ><Download :size="17" /></button></div
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
        expanded
        @range="(a, b) => (range = [a, b])"
        @seek="seek"
      /><p class="drawer-intro"
        >蓝色为左侧或脊柱中线，橙色为右侧；使用 filtered
        角度。使用滚轮与底部滑块缩放；低置信度帧显示为缺口。</p
      ></el-dialog
    >
  </div>
</template>
