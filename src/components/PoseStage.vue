<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { UploadCloud, Video, ScanLine } from 'lucide-vue-next';
import type { Landmark, Settings, Source } from '../types';
import { demoPose } from '../utils/demo';
import { renderPose } from '../utils/renderer';
import { getPoseEngine } from '../utils/poseEngine';
import { OfflineVideoJob } from '../video/job';
import type { OfflineMetadata, OfflineState } from '../video/protocol';
import { MAX_FRAMES } from '../config';
import { DEMO_SIZE, stageSize } from '../utils/dimensions';
import { centerOfMass } from '../utils/poseMath';
const props = defineProps<{
  source: Source;
  playing: boolean;
  settings: Settings;
  selectedPoints?: Landmark[];
  seekTime?: number;
  sessionId: string;
}>();
const emit = defineEmits<{
  frame: [
    points: Landmark[],
    time: number,
    aspect: number,
    source: Source,
    accept?: (value: boolean) => void,
  ];
  status: [message: string];
  ready: [name: string];
  ended: [];
  busy: [value: boolean];
  offline: [state: OfflineState, metadata: OfflineMetadata | null];
}>();
const canvas = ref<HTMLCanvasElement>(),
  video = ref<HTMLVideoElement>(),
  input = ref<HTMLInputElement>();
const filename = ref(''),
  loading = ref(false),
  modelReady = ref(false);
const offlineState = ref<OfflineState>('idle');
const offlineMetadata = ref<OfflineMetadata | null>(null);
const cameraConnected = ref(false);
const cameraHint = ref('点击开始分析，在浏览器提示中允许使用摄像头。');
let pausedDemoPaint:
  | { points: Landmark[]; settings: string; width: number; height: number }
  | undefined;
const processed = ref(0);
let file: File | undefined;
let job: OfflineVideoJob | undefined;
let preview: ImageBitmap | undefined;
let reviewing = false;
let hiddenPause = false;
let stream: MediaStream | undefined,
  objectURL = '',
  raf = 0,
  lastSample = 0,
  lastTrailSample = 0,
  lastVideo = -1,
  demoTime = 8,
  previousNow = 0,
  points: Landmark[] = [],
  trail: ({ x: number; y: number } | null)[] = [],
  generation = 0,
  inferenceTime = 0,
  lastDetection: boolean | null = null;
let engine: Awaited<ReturnType<typeof getPoseEngine>> | undefined;
let cameraRequest:
  | { generation: number; expired: boolean; timer: ReturnType<typeof setTimeout> }
  | undefined;
function cameraStatus(message: string) {
  cameraHint.value = message;
  emit('status', message);
}
function releaseCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  cameraConnected.value = false;
  if (video.value) {
    video.value.pause();
    video.value.srcObject = null;
  }
}
function cameraFailure(message: string) {
  stop();
  cameraStatus(message);
  emit('ended');
}
function cameraError(error: unknown) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const help: Record<string, string> = {
    NotAllowedError: '浏览器或系统未允许摄像头访问，请手动检查本站权限与系统摄像头权限。',
    NotFoundError: '未找到可用摄像头，请检查设备连接。',
    NotReadableError: '摄像头无法读取，可能被其他程序占用或被硬件开关关闭，请检查后再试。',
    OverconstrainedError: '摄像头无法满足当前画面请求，请检查设备支持。',
    SecurityError: '当前页面不允许摄像头访问，请使用 localhost 或 HTTPS 并检查页面策略。',
    AbortError: '摄像头启动被中断，请检查设备后重新开始。',
    TimeoutError: '等待摄像头画面超过 10 秒，已释放设备，请检查设备后重新开始。',
  };
  return `摄像头启动失败（${name}）：${help[name] ?? '请检查设备连接及本站权限后重新开始。'}`;
}
async function cameraDeadline<T>(operation: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DOMException('Camera startup timed out', 'TimeoutError')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function prepare() {
  const token = generation;
  loading.value = true;
  emit('busy', true);
  try {
    const prepared = await cameraDeadline(getPoseEngine(), 30_000);
    if (token === generation) {
      engine = prepared;
      modelReady.value = true;
      emit('status', '本地推理已就绪');
      return true;
    }
  } catch (error) {
    if (token === generation) {
      const message =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? '本地模型加载超过 30 秒，已停止启动并释放摄像头，请检查本地资源后重新开始。'
          : '模型加载失败，请检查本地模型资源后重新开始。';
      if (props.source === 'camera') cameraFailure(message);
      else {
        emit('status', message);
        emit('ended');
      }
    }
  } finally {
    if (token === generation) {
      loading.value = false;
      emit('busy', false);
    }
  }
  return false;
}
async function start() {
  const token = generation;
  if (props.source === 'demo') return;
  if (props.source === 'file') {
    if (!file) {
      emit('status', '请先选择 H.264 MP4 视频。');
      emit('ended');
      return;
    }
    if (['completed', 'cancelled', 'truncated', 'failed'].includes(offlineState.value)) {
      emit('status', '本次解码已停止；可回看或重算指标，重新解码请点击「重新逐帧分析」。');
      emit('ended');
      return;
    }
    reviewing = false;
    if (job) {
      if (document.hidden) {
        hiddenPause = true;
        job.pause();
        emit('status', '页面位于后台，离线分析已暂停；返回后自动继续。');
      } else job.resume();
      return;
    }
    const sessionId = props.sessionId;
    const current = () =>
      token === generation && sessionId === props.sessionId && props.source === 'file';
    try {
      job = new OfflineVideoJob(file, MAX_FRAMES, {
        metadata(value) {
          if (current()) {
            offlineMetadata.value = value;
            emit('offline', offlineState.value, value);
          }
        },
        frame(value) {
          if (!current()) {
            value.preview.close();
            return false;
          }
          if (offlineState.value === 'preparing') {
            offlineState.value = 'running';
            emit('offline', 'running', offlineMetadata.value);
            emit('status', '正在离线逐帧分析；不保证快于视频时长。');
          }
          let accepted = false;
          emit(
            'frame',
            value.points,
            value.time,
            offlineMetadata.value!.aspect,
            'file',
            (value) => {
              accepted = value;
            },
          );
          if (!accepted) {
            value.preview.close();
            return false;
          }
          preview?.close();
          preview = value.preview;
          points = value.points;
          processed.value = value.index;
          lastSample = value.index;
          return true;
        },
        state(value, detail) {
          if (!current()) return;
          offlineState.value = value;
          emit('offline', value, offlineMetadata.value);
          if (value === 'preparing')
            emit('status', '正在读取 MP4 索引并准备本地 Worker，分析与播放独立。');
          if (value === 'running') emit('status', '正在离线逐帧分析；不保证快于视频时长。');
          if (['completed', 'cancelled', 'truncated', 'failed'].includes(value)) {
            emit(
              'status',
              value === 'completed'
                ? '已核对全部呈现帧及源 PTS，逐帧分析完成。'
                : value === 'truncated'
                  ? `达到 ${MAX_FRAMES.toLocaleString()} 帧上限，结果已截断，未分析完整视频。`
                  : value === 'cancelled'
                    ? '已取消解码，保留已分析前缀；重新解码需显式重置。'
                    : `逐帧分析失败，已保留前缀：${detail}`,
            );
            emit('ended');
          }
        },
      });
    } catch (error) {
      offlineState.value = 'failed';
      emit('offline', 'failed', offlineMetadata.value);
      emit(
        'status',
        `无法启动离线 Worker：${error instanceof Error ? error.message : String(error)}`,
      );
      emit('ended');
      return;
    }
    if (document.hidden) {
      hiddenPause = true;
      job.pause();
      emit('status', '页面位于后台，离线分析已暂停；返回后自动继续。');
    }
    return;
  }
  if (props.source === 'camera' && !stream) {
    if (cameraRequest) {
      if (cameraRequest.generation === token && !cameraRequest.expired) return;
      cameraStatus(
        '上一次浏览器摄像头请求仍未结束，不会重复申请。请处理原权限提示；若无响应，请关闭此页面后重新打开。',
      );
      emit('ended');
      return;
    }
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      cameraFailure('当前页面不支持摄像头访问，请用 Edge 或 Chrome 打开 localhost 或 HTTPS 地址。');
      return;
    }
    const request = {
      generation: token,
      expired: false,
      timer: setTimeout(() => {
        request.expired = true;
        if (token === generation && props.source === 'camera')
          cameraFailure(
            '等待浏览器摄像头响应超过 30 秒，页面已停止等待。请处理权限提示；若无响应，请关闭此页面后重新打开。迟到授权会自动释放设备。',
          );
      }, 30_000),
    };
    cameraRequest = request;
    cameraStatus('等待浏览器摄像头授权，请处理地址栏附近的权限提示；页面不会自动批准权限。');
    try {
      const granted = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      clearTimeout(request.timer);
      if (request.expired || token !== generation || !props.playing) {
        granted.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = granted;
      video.value!.srcObject = stream;
      cameraStatus('摄像头已连接，正在等待视频画面…');
      await cameraDeadline(video.value!.play(), 10_000);
      if (token !== generation) return;
      if (!props.playing) video.value!.pause();
      cameraConnected.value = true;
      emit('ready', '实时摄像头');
    } catch (error) {
      if (token !== generation || !props.playing) return;
      cameraFailure(cameraError(error));
      return;
    } finally {
      clearTimeout(request.timer);
      // getUserMedia has no cancellation API. Retain the pending request across
      // resets/timeouts until it settles, then release every abandoned grant.
      if (cameraRequest === request) cameraRequest = undefined;
    }
  }
  if (token !== generation || !props.playing) return;
  if (!modelReady.value) {
    cameraStatus('摄像头画面已就绪，正在加载本地姿态模型…');
    if (!(await prepare())) return;
  }
  if (token !== generation || !props.playing) return;
  if (video.value && modelReady.value) {
    try {
      await cameraDeadline(video.value.play(), 10_000);
    } catch (error) {
      if (token === generation && props.playing) cameraFailure(cameraError(error));
    }
  }
}
async function loadFile(selected?: File) {
  if (!selected) return;
  if (selected.size > 500 * 1024 * 1024) {
    emit('status', '视频超过 500 MB，请先截取较短片段。');
    return;
  }
  if (!/\.mp4$/i.test(selected.name)) {
    emit('status', '逐帧分析仅支持 H.264 MP4；WebM/MOV 暂不支持，不进行播放采样降级。');
    return;
  }
  stop();
  file = selected;
  emit('ended');
  stream?.getTracks().forEach((t) => t.stop());
  stream = undefined;
  video.value!.srcObject = null;
  try {
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(selected);
    filename.value = selected.name;
    video.value!.src = objectURL;
    video.value!.load();
    lastVideo = -1;
    points = [];
    trail = [];
    offlineMetadata.value = null;
    processed.value = 0;
    offlineState.value = 'idle';
    emit('ready', selected.name);
    emit('status', '文件已选择，点击「开始分析」验证容器和编码并逐帧解码。');
  } catch {
    emit('status', '本地文件读取失败。');
  }
}
function fileChange(event: Event) {
  void loadFile((event.target as HTMLInputElement).files?.[0]);
  (event.target as HTMLInputElement).value = '';
}
function drop(event: DragEvent) {
  event.preventDefault();
  if (props.source === 'file') void loadFile(event.dataTransfer?.files[0]);
}
function stop() {
  generation++;
  if (cameraRequest) {
    cameraRequest.expired = true;
    clearTimeout(cameraRequest.timer);
  }
  job?.cancel();
  job = undefined;
  preview?.close();
  preview = undefined;
  offlineState.value = 'idle';
  processed.value = 0;
  hiddenPause = false;
  releaseCamera();
  points = [];
  trail = [];
  lastVideo = -1;
  lastDetection = null;
  modelReady.value = !!engine;
  loading.value = false;
  emit('busy', false);
}
function tick(now: number) {
  raf = requestAnimationFrame(tick);
  const dt = previousNow ? Math.min((now - previousNow) / 1000, 0.15) : 0;
  previousNow = now;
  if (props.source === 'demo') {
    if (props.playing) demoTime += dt;
    points = props.playing ? demoPose(demoTime) : (props.selectedPoints ?? demoPose(demoTime));
    if (props.playing && now - lastSample >= 50) {
      lastSample = now;
      emit('frame', points, demoTime, 850 / 590, 'demo');
    }
  } else if (
    props.source === 'camera' &&
    props.playing &&
    engine &&
    modelReady.value &&
    video.value &&
    video.value.readyState >= 2 &&
    // Sample distinct camera frames at up to 30 Hz. A 50 ms RAF gate rounds
    // upward to a display tick and falls below the required 20 effective fps.
    now - lastSample >= 1000 / 30 &&
    video.value.currentTime !== lastVideo
  ) {
    lastSample = now;
    lastVideo = video.value.currentTime;
    try {
      inferenceTime = Math.max(inferenceTime + 1, performance.now());
      const result = engine.detectForVideo(video.value, inferenceTime);
      points =
        result.landmarks[0]?.map((p) => ({
          x: p.x,
          y: p.y,
          z: p.z,
          visibility: p.visibility ?? 0,
        })) ?? [];
      emit(
        'frame',
        points,
        video.value.currentTime,
        video.value.videoWidth / video.value.videoHeight,
        props.source,
      );
      if (!!points.length !== lastDetection) {
        lastDetection = !!points.length;
        emit('status', points.length ? '' : '未检测到完整人体，请保证单人全身入镜。');
      }
    } catch {
      cameraFailure('当前帧推理失败，已释放摄像头，请重置后重试。');
    }
  }
  if (canvas.value) {
    const aspect =
      props.source === 'demo'
        ? DEMO_SIZE.width / DEMO_SIZE.height
        : props.source === 'file'
          ? (offlineMetadata.value?.aspect ?? DEMO_SIZE.width / DEMO_SIZE.height)
          : video.value?.videoWidth && video.value.videoHeight
            ? video.value.videoWidth / video.value.videoHeight
            : DEMO_SIZE.width / DEMO_SIZE.height;
    const size = stageSize(aspect);
    if (canvas.value.width !== size.width || canvas.value.height !== size.height) {
      canvas.value.width = size.width;
      canvas.value.height = size.height;
    }
    const displayed = props.selectedPoints ?? points;
    // A paused synthetic frame has no asynchronously changing video background.
    // Retain its bitmap until the points/settings/size change, including seeks
    // from another page. Acquisition, inference and file/camera painting keep
    // their existing schedule.
    if (props.source === 'demo' && !props.playing) {
      const settings = JSON.stringify(props.settings);
      if (
        pausedDemoPaint?.points === displayed &&
        pausedDemoPaint.settings === settings &&
        pausedDemoPaint.width === size.width &&
        pausedDemoPaint.height === size.height
      )
        return;
      pausedDemoPaint = { points: displayed, settings, width: size.width, height: size.height };
    } else pausedDemoPaint = undefined;
    if (props.settings.trajectory && props.playing && lastTrailSample !== lastSample) {
      lastTrailSample = lastSample;
      trail.push(centerOfMass(displayed, props.settings.threshold));
      trail = trail.slice(-180);
    }
    renderPose(
      canvas.value,
      displayed,
      props.settings,
      props.source === 'demo'
        ? undefined
        : props.source === 'file' && !reviewing && preview
          ? preview
          : video.value,
      props.playing ? trail : [],
      aspect,
    );
  }
}
watch(
  () => props.playing,
  (value) => {
    if (value) void start();
    else {
      job?.pause();
      hiddenPause = false;
      video.value?.pause();
    }
  },
);
watch(
  () => props.source,
  () => {
    stop();
    file = undefined;
    filename.value = '';
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = '';
    video.value?.removeAttribute('src');
    if (props.source === 'demo') {
      demoTime = 8;
      filename.value = '';
    }
    if (props.playing) void start();
  },
);
watch(
  () => props.seekTime,
  (time) => {
    if (time !== undefined && props.source === 'demo') demoTime = time;
  },
);
function seekToTime(time: number) {
  if (props.source === 'file' && video.value && filename.value) {
    reviewing = true;
    video.value.currentTime = time;
    lastVideo = -1;
  }
}
watch(
  () => props.sessionId,
  () => {
    // Same-file reset invalidates any decoder results before the next event task.
    stop();
  },
  { flush: 'sync' },
);
function visibility() {
  if (props.source !== 'file' || !job) return;
  if (document.hidden && props.playing) {
    hiddenPause = true;
    job.pause();
    emit('status', '页面位于后台，离线分析已暂停；返回后自动继续。');
  } else if (!document.hidden && hiddenPause && props.playing) {
    hiddenPause = false;
    job.resume();
  }
}
onMounted(() => {
  raf = requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', visibility);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  stop();
  document.removeEventListener('visibilitychange', visibility);
  if (objectURL) URL.revokeObjectURL(objectURL);
});
function waitUntilRendered() {
  const token = generation;
  return new Promise<void>((resolve, reject) => {
    let waiting = 0;
    const timeout = setTimeout(() => {
      cancelAnimationFrame(waiting);
      reject(new Error('画面尚未就绪，请等待视频定位完成后重试。'));
    }, 5000);
    const check = () => {
      if (token !== generation) {
        clearTimeout(timeout);
        reject(new Error('来源已改变，请重新生成图片报告。'));
      } else if (
        props.source === 'file' &&
        (reviewing || !preview) &&
        (!video.value || video.value.seeking || video.value.readyState < 2)
      ) {
        waiting = requestAnimationFrame(check);
      } else {
        // tick was scheduled first: this RAF observes a canvas painted with the
        // settled media frame and current selected landmarks, not only Vue DOM.
        clearTimeout(timeout);
        resolve();
      }
    };
    waiting = requestAnimationFrame(check);
  });
}
defineExpose({
  canvas,
  seekToTime,
  waitUntilRendered,
  isEnded: () => ['completed', 'cancelled', 'truncated', 'failed'].includes(offlineState.value),
  chooseFile: () => input.value?.click(),
  reset: () => {
    stop();
    demoTime = 0;
    trail = [];
    lastVideo = -1;
    lastDetection = null;
    points = [];
    if (video.value && props.source === 'file') video.value.currentTime = 0;
  },
});
</script>
<template>
  <div class="pose-stage" @dragover.prevent @drop="drop">
    <canvas
      ref="canvas"
      :width="stageSize().width"
      :height="stageSize().height"
      aria-label="人体姿态骨骼与关键点可视化画布"
    />
    <video
      ref="video"
      playsinline
      muted
      @error="emit('status', '视频预览不可用；离线分析将独立检查 H.264 MP4 解码支持。')"
    />
    <input ref="input" type="file" accept="video/mp4,.mp4" hidden @change="fileChange" />
    <div class="stage-top"
      ><span class="stage-chip"
        ><i :class="{ live: playing }" />{{
          source === 'demo'
            ? '合成姿态演示'
            : source === 'camera'
              ? 'CAMERA · 本地摄像头'
              : 'VIDEO · 本地文件'
        }}</span
      ><span class="stage-chip subtle">{{
        source === 'demo' ? 'SYNTHETIC DATA' : 'LOCAL INFERENCE'
      }}</span></div
    >
    <div v-if="source === 'demo'" class="stage-axis"
      ><span>Y ↓</span><div>·</div><small>X →</small></div
    >
    <div
      v-if="(source === 'file' && !filename) || (source === 'camera' && !cameraConnected)"
      class="stage-empty"
      ><component :is="source === 'camera' ? Video : UploadCloud" :size="38" /><h3>{{
        source === 'camera' ? '连接你的摄像头' : '将视频拖到这里'
      }}</h3
      ><p>{{ source === 'camera' ? cameraHint : filename || '逐帧分析：H.264 MP4，最大 500 MB' }}</p
      ><el-button v-if="source === 'file'" @click="input?.click()">{{
        filename ? '重新选择视频' : '选择本地视频'
      }}</el-button></div
    >
    <div v-if="loading" class="model-loading"
      ><ScanLine class="spin" :size="24" /><span>正在准备本地推理引擎…</span></div
    >
    <div v-if="source === 'file' && filename" class="offline-progress" role="status">
      <button @click="input?.click()">更换视频</button>
      <span
        >{{
          {
            idle: '待分析',
            preparing: '准备中',
            running: '逐帧分析中',
            paused: '已暂停',
            completed: '全部完成',
            cancelled: '已取消 · 前缀',
            truncated: '上限截断',
            failed: '失败 · 前缀',
          }[offlineState]
        }}
        · {{ processed }} / {{ offlineMetadata?.total ?? '—' }} 帧</span
      >
      <progress :value="processed" :max="offlineMetadata?.total || 1" aria-label="逐帧分析进度" />
      <button
        v-if="['preparing', 'running', 'paused'].includes(offlineState)"
        @click="job?.cancel()"
        >取消解码</button
      >
    </div>
    <div class="stage-bottom"
      ><span
        ><ScanLine :size="13" />
        {{ source === 'demo' ? '33 LANDMARKS · 演示序列' : 'MEDIAPIPE POSE · 33 LANDMARKS' }}</span
      ><span>2D / SINGLE PERSON</span></div
    >
    <div class="corner tl" /><div class="corner tr" /><div class="corner bl" /><div
      class="corner br"
    />
  </div>
</template>
<style scoped>
.offline-progress {
  position: absolute;
  bottom: 42px;
  left: 16px;
  right: 16px;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 9px 12px;
  border-radius: 6px;
  background: #10262ee8;
  color: #dcf1eb;
  font-size: 12px;
  z-index: 3;
}
.offline-progress progress {
  flex: 1;
  min-width: 30px;
  height: 8px;
  accent-color: #62dbac;
}
.offline-progress button {
  border: 1px solid #698d85;
  color: inherit;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
