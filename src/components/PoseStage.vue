<script setup lang="ts">
import { computed, ref, shallowReactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { UploadCloud, Video, ScanLine } from 'lucide-vue-next';
import type { Angles, Landmark, PoseFrame, Settings, Source } from '../types';
import { demoPose } from '../utils/demo';
import { renderPose } from '../utils/renderer';
import { PoseEngine } from '../utils/poseEngine';
import { OfflineVideoJob } from '../video/job';
import { MAX_VIDEO_BYTES, prepareVideo, VIDEO_ACCEPT } from '../video/prepare';
import type { OfflineMetadata, OfflineState } from '../video/protocol';
import { MAX_FRAMES } from '../config';
import { DEMO_SIZE, stageSize } from '../utils/dimensions';
import { centerOfMass } from '../utils/poseMath';
const props = defineProps<{
  source: Source;
  playing: boolean;
  settings: Settings;
  selectedFrame?: PoseFrame;
  sourceAspect: number;
  seekTime?: number;
  sessionId: string;
}>();
const emit = defineEmits<{
  frame: [
    points: Landmark[],
    time: number,
    aspect: number,
    source: Source,
    accept?: (frame?: PoseFrame) => void,
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
const sampled = computed(() => {
  const metadata = offlineMetadata.value;
  return !!metadata && metadata.sampleTotal < metadata.total;
});
const offlineEnded = () =>
  ['completed', 'sampled', 'cancelled', 'truncated', 'failed'].includes(offlineState.value);
const runningMessage = () =>
  sampled.value ? '正在抽样分析长视频，覆盖片头至片尾。' : '正在离线逐帧分析。';
const paintSettings = computed(() => JSON.stringify(props.settings));
const cameraConnected = ref(false);
const cameraHint = ref('点击开始分析，在浏览器提示中允许使用摄像头。');
// 96 reusable thumbnails, at most 96 × 384 × 384 × 4 bytes (54 MiB of RGBA pixels).
const CAMERA_HISTORY_FRAMES = 96;
const CAMERA_HISTORY_SIDE = 384;
const CAMERA_HISTORY_MISSING = '此采样的摄像头历史画面不可用，无法导出该时刻的 PNG。';
const cameraHistory = shallowReactive(new Map<number, HTMLCanvasElement>());
const cameraReviewTime = computed(() =>
  props.source === 'camera' && !props.playing ? props.selectedFrame?.time : undefined,
);
const cameraReviewImage = computed(() => cameraHistory.get(cameraReviewTime.value ?? -1));
let cameraInput: HTMLCanvasElement | undefined;
let cameraPreview: ImageBitmap | undefined;
let cameraRun = 0;
let cameraRecoveryAttempted = false;
let cameraPaintedSample = -1;
let measuredAngles: Angles | undefined;
let pausedDemoPaint:
  | { points: Landmark[]; settings: string; width: number; height: number }
  | undefined;
let filePaint:
  | {
      background?: HTMLVideoElement | ImageBitmap;
      mediaTime?: number;
      seeking?: boolean;
      points: Landmark[];
      settings: string;
      playing: boolean;
      aspect: number;
    }
  | undefined;
const processed = ref(0);
let file: File | undefined;
let filePreparation: AbortController | undefined;
let transcoded = false;
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
let engine: PoseEngine | undefined;
let cameraInFlight = false;
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
function copyCameraInput(video: HTMLVideoElement) {
  const input = (cameraInput ??= document.createElement('canvas'));
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  if (input.width !== width) input.width = width;
  if (input.height !== height) input.height = height;
  const ctx = input.getContext('2d', { alpha: false });
  if (!ctx || !input.width || !input.height) return;
  try {
    ctx.drawImage(video, 0, 0, width, height);
    return input;
  } catch {
    // Inference can continue from video if a still cannot be copied.
  }
}
function saveCameraImage(time: number, input: HTMLCanvasElement) {
  let image: HTMLCanvasElement;
  if (cameraHistory.size === CAMERA_HISTORY_FRAMES) {
    const [oldest, reusable] = cameraHistory.entries().next().value!;
    cameraHistory.delete(oldest);
    image = reusable;
  } else {
    image = document.createElement('canvas');
  }
  const scale = Math.min(1, CAMERA_HISTORY_SIDE / Math.max(input.width, input.height));
  const width = Math.max(1, Math.round(input.width * scale));
  const height = Math.max(1, Math.round(input.height * scale));
  if (image.width !== width) image.width = width;
  if (image.height !== height) image.height = height;
  const ctx = image.getContext('2d', { alpha: false });
  if (!ctx) return;
  try {
    ctx.drawImage(input, 0, 0, width, height);
    cameraHistory.set(time, image);
  } catch {
    // Only a successfully copied image may be associated with a sample.
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
    engine = new PoseEngine();
    await engine.ready();
    if (token === generation) {
      modelReady.value = true;
      emit('status', '本地推理已就绪');
      return true;
    }
  } catch {
    if (token === generation) {
      cameraFailure('模型加载失败或超时，请检查本地模型资源后重新开始。');
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
      emit('status', '请先选择本地视频。');
      emit('ended');
      return;
    }
    if (offlineEnded()) {
      emit('status', '本次分析已结束，可回看、重算指标或重新分析。');
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
    let detected = false;
    try {
      job = new OfflineVideoJob(file, MAX_FRAMES, {
        metadata(value) {
          if (current()) {
            offlineMetadata.value = { ...value, transcoded };
            emit('offline', offlineState.value, offlineMetadata.value);
          }
        },
        frame(value) {
          if (!current()) {
            return false;
          }
          if (offlineState.value === 'preparing') {
            offlineState.value = 'running';
            emit('offline', 'running', offlineMetadata.value);
            emit('status', runningMessage());
          }
          let accepted: PoseFrame | undefined;
          emit(
            'frame',
            value.points,
            value.time,
            offlineMetadata.value!.aspect,
            'file',
            (frame) => {
              accepted = frame;
            },
          );
          if (!accepted) {
            return false;
          }
          preview?.close();
          preview = value.preview;
          points = accepted.points;
          measuredAngles = accepted.angles;
          detected ||= value.points.length > 0;
          processed.value = value.index;
          lastSample = value.index;
          requestPaint();
          return true;
        },
        state(value, detail) {
          if (!current()) return;
          offlineState.value = value;
          emit('offline', value, offlineMetadata.value);
          if (value === 'preparing')
            emit('status', '正在读取 MP4 索引并准备本地 Worker，分析与播放独立。');
          if (value === 'running') emit('status', runningMessage());
          if (offlineEnded()) {
            const completion =
              value === 'completed'
                ? transcoded
                  ? '转换后视频的全部呈现帧已分析完成；时间轴与帧数以转换结果为准。'
                  : '已核对全部呈现帧及源 PTS，逐帧分析完成。'
                : value === 'sampled'
                  ? '长视频抽样分析完成，已覆盖片头至片尾。快速动作可能落在采样帧之间。'
                  : value === 'truncated'
                    ? `达到 ${MAX_FRAMES.toLocaleString()} 帧上限，结果已截断，未分析完整视频。`
                    : value === 'cancelled'
                      ? '已取消解码，保留已分析前缀；重新解码需显式重置。'
                      : `逐帧分析失败，已保留前缀：${detail}`;
            emit(
              'status',
              !detected && (value === 'completed' || value === 'sampled')
                ? `${completion} 未检测到可信人体姿态。`
                : completion,
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
    if (loading.value) return;
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
  if (selected.size > MAX_VIDEO_BYTES) {
    emit('status', '视频超过 500 MB，请先截取较短片段。');
    return;
  }
  filePreparation?.abort();
  job?.pause();
  emit('ended');
  const controller = new AbortController();
  filePreparation = controller;
  loading.value = true;
  emit('busy', true);
  try {
    const prepared = await prepareVideo(selected, controller.signal, (message) =>
      emit('status', message),
    );
    if (controller.signal.aborted) return;
    const nextURL = URL.createObjectURL(prepared.file);
    // ready resets the parent session synchronously, so finish preparation
    // before emitting it; the prepared file survives a same-source reset.
    filePreparation = undefined;
    stop();
    file = prepared.file;
    transcoded = prepared.transcoded;
    const previousURL = objectURL;
    objectURL = nextURL;
    filename.value = selected.name;
    video.value!.src = objectURL;
    video.value!.load();
    if (previousURL) URL.revokeObjectURL(previousURL);
    lastVideo = -1;
    points = [];
    trail = [];
    offlineMetadata.value = null;
    processed.value = 0;
    offlineState.value = 'idle';
    emit('ready', selected.name);
    emit(
      'status',
      transcoded
        ? '视频已在本机转换，点击「开始分析」；时间轴与帧数以转换后视频为准。'
        : '文件已选择，点击「开始分析」逐帧解码。',
    );
  } catch (error) {
    if (!controller.signal.aborted)
      emit('status', error instanceof Error ? error.message : '本地文件读取失败。');
  } finally {
    if (filePreparation === controller) {
      filePreparation = undefined;
      loading.value = false;
      emit('busy', false);
    }
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
function cancelPreparation() {
  filePreparation?.abort();
  emit('status', '已取消视频准备，请重新选择视频。');
}
function stop() {
  generation++;
  filePreparation?.abort();
  filePreparation = undefined;
  if (cameraRequest) {
    cameraRequest.expired = true;
    clearTimeout(cameraRequest.timer);
  }
  job?.cancel();
  job = undefined;
  preview?.close();
  preview = undefined;
  filePaint = undefined;
  offlineState.value = 'idle';
  processed.value = 0;
  hiddenPause = false;
  releaseCamera();
  for (const image of cameraHistory.values()) image.width = image.height = 0;
  cameraHistory.clear();
  if (cameraInput) cameraInput.width = cameraInput.height = 0;
  cameraInput = undefined;
  cameraPreview?.close();
  cameraPreview = undefined;
  cameraRecoveryAttempted = false;
  cameraPaintedSample = -1;
  points = [];
  trail = [];
  lastVideo = -1;
  lastDetection = null;
  engine?.close();
  engine = undefined;
  cameraInFlight = false;
  modelReady.value = false;
  loading.value = false;
  emit('busy', false);
  requestPaint();
}
async function sampleCamera(camera: HTMLVideoElement, time: number, model: PoseEngine) {
  const run = cameraRun;
  const current = () => engine === model && props.playing && run === cameraRun;
  cameraInFlight = true;
  const aspect = camera.videoWidth / camera.videoHeight;
  try {
    const input = copyCameraInput(camera);
    const bitmap = await createImageBitmap(input ?? camera);
    if (!current()) {
      bitmap.close();
      return;
    }
    inferenceTime = Math.max(inferenceTime + 1, performance.now());
    const result = await model.detect(bitmap, inferenceTime, true, aspect);
    if (!current()) {
      result.preview?.close();
      return;
    }
    cameraRecoveryAttempted = false;
    emit('frame', result.points, time, aspect, 'camera', (frame) => {
      if (!frame) {
        result.preview?.close();
        return;
      }
      points = frame.points;
      measuredAngles = frame.angles;
      cameraPreview?.close();
      cameraPreview = result.preview;
      cameraPaintedSample = time;
      if (input) saveCameraImage(frame.time, input);
    });
    if (!!result.points.length !== lastDetection) {
      lastDetection = !!result.points.length;
      emit(
        'status',
        lastDetection ? '' : '未检测到可信人体姿态。仍在采集，请让单人和待测关节入镜。',
      );
    }
  } catch {
    if (engine !== model) return;
    if (current() && Number.isFinite(aspect) && aspect > 0) {
      emit('frame', [], time, aspect, 'camera');
      points = [];
      cameraPreview?.close();
      cameraPreview = undefined;
      cameraPaintedSample = time;
    }
    if (cameraRecoveryAttempted) {
      cameraFailure('本地推理未能恢复，已释放摄像头。点击开始分析可继续采集。');
    } else {
      cameraRecoveryAttempted = true;
      model.close();
      engine = undefined;
      modelReady.value = false;
      cameraInFlight = false;
      if (props.playing) {
        emit('status', '当前帧未能分析，正在重新启动本地追踪…');
        await prepare();
      }
    }
  } finally {
    if (engine === model) cameraInFlight = false;
  }
}
function requestPaint() {
  if (!raf) raf = requestAnimationFrame(tick);
}
function tick(now: number) {
  raf = 0;
  const dt = previousNow ? Math.min((now - previousNow) / 1000, 0.15) : 0;
  const continuous = props.playing && props.source !== 'file';
  previousNow = continuous ? now : 0;
  if (continuous) requestPaint();
  const cameraVideo = props.source === 'camera' && props.playing ? video.value : undefined;
  const cameraTime = cameraVideo?.currentTime;
  if (props.source === 'demo') {
    if (props.playing) demoTime += dt;
    points = props.playing
      ? demoPose(demoTime)
      : (props.selectedFrame?.points ?? demoPose(demoTime));
    if (props.playing && now - lastSample >= 50) {
      lastSample = now;
      emit('frame', points, demoTime, 850 / 590, 'demo');
    }
  } else if (
    engine &&
    !cameraInFlight &&
    modelReady.value &&
    cameraVideo &&
    cameraVideo.readyState >= 2 &&
    // Sample distinct camera frames at up to 30 Hz. A 50 ms RAF gate rounds
    // upward to a display tick and falls below the required 20 effective fps.
    now - lastSample >= 1000 / 30 &&
    cameraTime !== undefined &&
    cameraTime !== lastVideo
  ) {
    lastSample = now;
    lastVideo = cameraTime;
    void sampleCamera(cameraVideo, cameraTime, engine);
  }
  paint();
}
function paint() {
  if (canvas.value) {
    const cameraReview = cameraReviewTime.value !== undefined;
    const aspect =
      props.source === 'demo'
        ? DEMO_SIZE.width / DEMO_SIZE.height
        : props.source === 'file'
          ? (offlineMetadata.value?.aspect ?? DEMO_SIZE.width / DEMO_SIZE.height)
          : cameraReview
            ? props.sourceAspect
            : video.value?.videoWidth && video.value.videoHeight
              ? video.value.videoWidth / video.value.videoHeight
              : DEMO_SIZE.width / DEMO_SIZE.height;
    const size = stageSize(aspect);
    if (canvas.value.width !== size.width || canvas.value.height !== size.height) {
      canvas.value.width = size.width;
      canvas.value.height = size.height;
    }
    const live = props.playing && props.source !== 'demo';
    const displayed = live ? points : (props.selectedFrame?.points ?? points);
    const angles = live
      ? measuredAngles
      : (props.selectedFrame?.angles ?? (props.source === 'demo' ? undefined : measuredAngles));
    // A paused synthetic frame has no asynchronously changing video background.
    // Retain its bitmap until the points/settings/size change, including seeks
    // from another page. Acquisition, inference and file/camera painting keep
    // their existing schedule.
    if (props.source === 'demo' && !props.playing) {
      const settings = paintSettings.value;
      if (
        pausedDemoPaint?.points === displayed &&
        pausedDemoPaint.settings === settings &&
        pausedDemoPaint.width === size.width &&
        pausedDemoPaint.height === size.height
      )
        return;
      pausedDemoPaint = { points: displayed, settings, width: size.width, height: size.height };
    } else pausedDemoPaint = undefined;
    const trailSample = props.source === 'camera' ? cameraPaintedSample : lastSample;
    if (props.settings.trajectory && props.playing && lastTrailSample !== trailSample) {
      lastTrailSample = trailSample;
      trail.push(centerOfMass(displayed, props.settings.threshold));
      trail = trail.slice(-180);
    }
    const background =
      props.source === 'demo'
        ? undefined
        : cameraReview
          ? cameraReviewImage.value
          : props.source === 'camera' && cameraPreview
            ? cameraPreview
            : props.source === 'file' && !reviewing && preview
              ? preview
              : video.value && video.value.readyState >= 2
                ? video.value
                : undefined;
    if (props.source === 'file') {
      const media = background === video.value ? video.value : undefined;
      const mediaTime = media?.currentTime;
      const seeking = media?.seeking;
      const settings = paintSettings.value;
      if (
        filePaint?.background === background &&
        filePaint?.mediaTime === mediaTime &&
        filePaint?.seeking === seeking &&
        filePaint?.points === displayed &&
        filePaint.settings === settings &&
        filePaint.playing === props.playing &&
        filePaint.aspect === aspect
      )
        return;
      filePaint = {
        background: background as HTMLVideoElement | ImageBitmap | undefined,
        mediaTime,
        seeking,
        points: displayed,
        settings,
        playing: props.playing,
        aspect,
      };
    }
    renderPose(
      canvas.value,
      displayed,
      props.settings,
      background,
      props.playing ? trail : [],
      aspect,
      props.source === 'demo',
      angles,
    );
  }
}
watch(
  () => props.playing,
  (value) => {
    if (value) void start();
    else {
      cameraRun++;
      job?.pause();
      hiddenPause = false;
      video.value?.pause();
    }
    previousNow = 0;
    requestPaint();
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
// Paused review and offline previews only repaint when their inputs change.
// The canvas stays mounted across tabs so PNG export can still use it.
watch(
  [() => props.selectedFrame, () => props.seekTime, () => props.sourceAspect, paintSettings],
  requestPaint,
);
function seekToTime(time: number) {
  if (props.source === 'file' && video.value && filename.value) {
    reviewing = true;
    video.value.currentTime = time;
    lastVideo = -1;
    requestPaint();
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
  requestPaint();
  document.addEventListener('visibilitychange', visibility);
});
onBeforeUnmount(() => {
  stop();
  cancelAnimationFrame(raf);
  document.removeEventListener('visibilitychange', visibility);
  if (objectURL) URL.revokeObjectURL(objectURL);
});
async function waitUntilRendered() {
  if (props.source === 'camera') {
    if (!cameraReviewImage.value) throw new Error(CAMERA_HISTORY_MISSING);
    paint();
    return;
  }
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
        clearTimeout(timeout);
        try {
          paint();
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    };
    waiting = requestAnimationFrame(check);
  });
}
defineExpose({
  canvas,
  seekToTime,
  waitUntilRendered,
  isEnded: offlineEnded,
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
      @loadeddata="requestPaint"
      @seeked="requestPaint"
      @emptied="requestPaint"
      @error="
        source === 'file' &&
        filename &&
        emit('status', '视频预览不可用；仍可尝试离线分析或更换视频。')
      "
    />
    <input ref="input" type="file" :accept="VIDEO_ACCEPT" hidden @change="fileChange" />
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
      v-if="cameraReviewTime !== undefined && !cameraReviewImage"
      class="camera-history-status"
      role="status"
      >{{ CAMERA_HISTORY_MISSING }}</div
    >
    <div
      v-if="(source === 'file' && !filename) || (source === 'camera' && !cameraConnected)"
      class="stage-empty"
      ><component :is="source === 'camera' ? Video : UploadCloud" :size="38" /><h3>{{
        source === 'camera' ? '连接你的摄像头' : '将视频拖到这里'
      }}</h3
      ><p>{{
        source === 'camera'
          ? cameraHint
          : filename || '支持 MP4、MOV、MKV、AVI、WebM 等视频，最大 500 MB'
      }}</p
      ><el-button v-if="source === 'file'" @click="input?.click()">{{
        filename ? '重新选择视频' : '选择本地视频'
      }}</el-button></div
    >
    <div v-if="loading" class="model-loading"
      ><ScanLine class="spin" :size="24" /><span>{{
        source === 'file' ? '正在检查并准备本地视频…' : '正在准备本地推理引擎…'
      }}</span
      ><button v-if="source === 'file'" @click="cancelPreparation">取消准备</button></div
    >
    <div v-if="source === 'file' && filename" class="offline-progress" role="status">
      <button @click="input?.click()">更换视频</button>
      <span
        >{{
          {
            idle: '待分析',
            preparing: '准备中',
            running: sampled ? '长视频抽样中' : '逐帧分析中',
            paused: '已暂停',
            completed: '全部完成',
            sampled: '全片抽样完成',
            cancelled: '已取消 · 前缀',
            truncated: '上限截断',
            failed: '失败 · 前缀',
          }[offlineState]
        }}
        · {{ processed }} / {{ offlineMetadata?.sampleTotal ?? '—' }} 帧
        <template v-if="sampled">（源视频 {{ offlineMetadata?.total }} 帧）</template></span
      >
      <progress
        :value="processed"
        :max="offlineMetadata?.sampleTotal || 1"
        aria-label="视频分析进度"
      />
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
.offline-progress,
.camera-history-status {
  position: absolute;
  bottom: 42px;
  left: 16px;
  right: 16px;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 9px 12px;
  border-radius: 6px;
  background: var(--stage-overlay);
  color: var(--stage-ink);
  font-size: 12px;
  z-index: 3;
}
.offline-progress progress {
  flex: 1;
  min-width: 30px;
  height: 8px;
  accent-color: var(--accent-mid);
}
.offline-progress button {
  border: 1px solid var(--stage-line);
  color: inherit;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
