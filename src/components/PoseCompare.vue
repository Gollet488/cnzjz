<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch, onBeforeUnmount } from 'vue';
import { UploadCloud, Play, Pause, RotateCcw, ArrowUpRight } from 'lucide-vue-next';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { renderPose } from '../utils/renderer';
import {
  angleValue,
  centerOfMass,
  channels,
  filteredJointAngles,
  jointAngles,
  LandmarkFilter,
  poseDistance,
} from '../utils/poseMath';
import { JOINTS } from '../config';
import type { Angles, Settings, Landmark } from '../types';
import { stageSize } from '../utils/dimensions';
import { prepareVideo, VIDEO_ACCEPT } from '../video/prepare';
import { humanPose } from '../utils/humanPose';
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ error: [message: string] }>();
const videos: HTMLVideoElement[] = [];
const canvases: HTMLCanvasElement[] = [];
const files: HTMLInputElement[] = [];
const previews = ref<HTMLElement>();
const lanes = [0, 1] as const;
const laneLabels = ['参考视频', '待测视频'];
const starts = ref([0, 0]);
const durations = ref([0, 0]);
const names = ref(['', '']),
  running = ref(false),
  busy = ref(false),
  finished = ref(false);
const measurements = JOINTS.flatMap(({ key, label }) =>
  channels(key).map((side) => ({
    joint: key,
    side,
    label: side === 'midline' ? '脊柱中线' : `${side === 'left' ? '左' : '右'}${label}`,
  })),
);
interface Reading {
  reference: number | null;
  candidate: number | null;
  delta: number | null;
}
interface Sample {
  times: number[];
  elapsed: number;
  points: Landmark[][];
  angles: Angles[];
  readings: Reading[];
  distance: number | null;
}
const frame = shallowRef<Sample | null>(null);
const latest = shallowRef<Sample | null>(null);
const peaks = shallowRef<(Sample | undefined)[]>([]);
const reviewing = ref(false);
const showingPeak = computed(() => frame.value !== null && frame.value !== latest.value);
const time = computed(() => frame.value?.elapsed ?? 0);
const distance = computed(() => frame.value?.distance ?? null);
const comparable = computed(
  () => frame.value?.readings.filter(({ delta }) => delta !== null).length ?? 0,
);
const greatest = computed(() => {
  let best: { sample: Sample; index: number; magnitude: number } | undefined;
  peaks.value.forEach((sample, index) => {
    if (!sample) return;
    const magnitude = Math.abs(sample.readings[index].delta!);
    if (!best || magnitude > best.magnitude) best = { sample, index, magnitude };
  });
  return best;
});
const overlap = computed(() => Math.min(...durations.value.map((d, i) => d - starts.value[i])));
const sizes = ref([stageSize(), stageSize()]);
const models: PoseLandmarker[] = [];
const filters = [new LandmarkFilter(), new LandmarkFilter()];
const trails: ({ x: number; y: number } | null)[][] = [[], []];
const displayed: Landmark[][] = [[], []];
const displayedAngles: (Angles | undefined)[] = [];
const sampleTimes = [-1, -1];
const urls: string[] = [];
const preparations: (AbortController | undefined)[] = [];
const preparing = ref([false, false]);
const hints = ref(['', '']);
let raf = 0,
  last = 0,
  disposed = false,
  generation = 0;
let reviewController: AbortController | undefined;
function draw(index: number) {
  const video = videos[index];
  if (!canvases[index]) return;
  renderPose(
    canvases[index],
    displayed[index],
    props.settings,
    video?.readyState >= 2 ? video : undefined,
    trails[index],
    video?.videoWidth / video?.videoHeight,
    undefined,
    displayedAngles[index],
  );
}
function invalidate() {
  pause();
  reviewController?.abort();
  reviewController = undefined;
  reviewing.value = false;
  frame.value = null;
  latest.value = null;
  peaks.value = [];
  finished.value = false;
  last = 0;
  filters.forEach((filter, i) => {
    filter.clear();
    trails[i] = [];
    displayed[i] = [];
    displayedAngles[i] = undefined;
    sampleTimes[i] = -1;
    draw(i);
  });
}
function previewStarts() {
  videos.forEach((video, i) => {
    if (durations.value[i] && video.currentTime !== starts.value[i])
      video.currentTime = starts.value[i];
  });
}
watch(
  () => [props.settings.threshold, props.settings.window],
  () => {
    invalidate();
    previewStarts();
  },
  { flush: 'sync' },
);
watch(
  () => [
    props.settings.skeleton,
    props.settings.labels,
    props.settings.labelJoints,
    props.settings.trajectory,
  ],
  () => {
    if (!props.settings.trajectory)
      trails.forEach((trail) => {
        trail.length = 0;
      });
    canvases.forEach((_, i) => draw(i));
  },
  { deep: true },
);
async function load(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  invalidate();
  starts.value[index] = 0;
  durations.value[index] = 0;
  previewStarts();
  preparations[index]?.abort();
  const controller = new AbortController();
  preparations[index] = controller;
  preparing.value[index] = true;
  names.value[index] = '';
  hints.value[index] = '';
  videos[index].removeAttribute('src');
  videos[index].load();
  if (urls[index]) URL.revokeObjectURL(urls[index]);
  urls[index] = '';
  sizes.value[index] = stageSize();
  draw(index);
  try {
    const prepared = await prepareVideo(file, controller.signal, (message) => {
      if (!disposed && !controller.signal.aborted) hints.value[index] = message;
    });
    if (disposed || controller.signal.aborted) return;
    urls[index] = URL.createObjectURL(prepared.file);
    videos[index].src = urls[index];
    videos[index].load();
    names.value[index] = file.name;
    hints.value[index] = prepared.transcoded ? '已在本机转换，使用转换后时间轴。' : '';
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      hints.value[index] = error instanceof Error ? error.message : '视频读取失败。';
      emit('error', hints.value[index]);
    }
  } finally {
    if (preparations[index] === controller) {
      preparations[index] = undefined;
      preparing.value[index] = false;
    }
  }
}
function metadata(index: number) {
  const video = videos[index];
  durations.value[index] = Number.isFinite(video.duration) ? video.duration : 0;
  sizes.value[index] = stageSize(video.videoWidth / video.videoHeight);
}
function primePreview(index: number) {
  const video = videos[index];
  // A loaded but hidden video can still lack a drawable first frame until it seeks.
  if (!busy.value && !running.value && !video.seeking) video.currentTime = starts.value[index];
}
async function preview(index: number) {
  await nextTick();
  if (!disposed && !running.value && !reviewing.value && !frame.value && !videos[index].seeking)
    draw(index);
}
function maxStart(index: number) {
  return Math.max(0, Math.floor((durations.value[index] - 0.01) * 100) / 100);
}
function setStart(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  const start = Number.isFinite(value) ? Math.max(0, Math.min(value, maxStart(index))) : 0;
  input.value = String(start);
  if (start === starts.value[index]) return;
  invalidate();
  starts.value[index] = start;
  previewStarts();
}
function pause() {
  generation++;
  running.value = false;
  videos.forEach((v) => v.pause());
  cancelAnimationFrame(raf);
}
async function play(restart = true) {
  if (running.value) {
    pause();
    return;
  }
  if (
    disposed ||
    busy.value ||
    reviewing.value ||
    preparing.value.some(Boolean) ||
    !names.value.every(Boolean)
  )
    return;
  const resume = !restart && !finished.value ? latest.value : null;
  if (!resume) invalidate();
  else {
    last = 0;
    filters.forEach((filter, i) => {
      filter.clear();
      trails[i] = [];
      sampleTimes[i] = -1;
    });
  }
  const operation = generation;
  const current = () => !disposed && operation === generation;
  const created: PoseLandmarker[] = [];
  busy.value = true;
  try {
    if (models.length !== 2) {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      if (!current()) return;
      const assets = `${import.meta.env.BASE_URL}mediapipe/`;
      const wasm = await FilesetResolver.forVisionTasks(`${assets}wasm`);
      if (!current()) return;
      for (let i = 0; i < 2; i++) {
        const model = await PoseLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: `${assets}pose_landmarker_lite.task` },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        created.push(model);
        if (!current()) return;
      }
      models.push(...created);
      created.length = 0;
    }
    videos.forEach((v, i) => (v.currentTime = resume?.times[i] ?? starts.value[i]));
    // Pause each late play completion before it can leave a replaced source playing.
    const playback = await Promise.allSettled(
      videos.map(async (v) => {
        await v.play();
        if (!current()) v.pause();
      }),
    );
    if (!current()) return;
    if (playback.some((result) => result.status === 'rejected')) throw new Error('PLAY_FAILED');
    running.value = true;
    raf = requestAnimationFrame(tick);
  } catch {
    if (current()) {
      invalidate();
      emit('error', '对比模型或视频加载失败，请检查模型资源或重新选择视频。');
    }
  } finally {
    created.forEach((model) => model.close());
    busy.value = false;
  }
}
function tick(now: number) {
  if (!running.value) return;
  raf = requestAnimationFrame(tick);
  if (now - last < 100) return;
  last = now;
  const elapsed = Math.max(0, videos[0].currentTime - starts.value[0]);
  if (videos.some((v) => v.ended) || (overlap.value > 0 && elapsed >= overlap.value)) {
    pause();
    finished.value = true;
    return;
  }
  if (videos.some((v) => v.readyState < 2 || v.seeking || !v.videoWidth || !v.videoHeight)) return;
  const target = starts.value[1] + elapsed;
  if (Math.abs(target - videos[1].currentTime) > 0.12) {
    videos[1].currentTime = target;
    filters[1].clear();
    trails[1] = [];
    return;
  }
  if (videos.some((v, i) => v.currentTime === sampleTimes[i])) return;
  const points: Landmark[][] = [];
  const angles: Angles[] = [];
  const aspects = videos.map((video) => video.videoWidth / video.videoHeight);
  try {
    for (let i = 0; i < 2; i++) {
      sampleTimes[i] = videos[i].currentTime;
      const result = models[i].detectForVideo(videos[i], now);
      const p = humanPose(
        result.landmarks[0]?.map((v) => ({
          x: v.x,
          y: v.y,
          z: v.z,
          visibility: v.visibility ?? 0,
        })) ?? [],
        aspects[i],
      );
      result.close();
      if (!p.length) {
        filters[i].clear();
        trails[i] = [];
      }
      const filtered = p.length
        ? filters[i].apply(p, props.settings.window, props.settings.threshold)
        : [];
      points.push(filtered);
      displayed[i] = filtered;
      const threshold = props.settings.threshold;
      const measured = filteredJointAngles(
        filtered,
        jointAngles(p, threshold, aspects[i]),
        threshold,
        aspects[i],
      );
      angles.push(measured);
      displayedAngles[i] = measured;
      if (props.settings.trajectory) {
        trails[i].push(centerOfMass(filtered, props.settings.threshold));
        trails[i] = trails[i].slice(-120);
      }
      draw(i);
    }
    const readings = measurements.map(({ joint, side }): Reading => {
      const reference = angleValue(angles[0], joint, side);
      const candidate = angleValue(angles[1], joint, side);
      return {
        reference,
        candidate,
        delta: reference === null || candidate === null ? null : candidate - reference,
      };
    });
    const geometry = poseDistance(
      points[0],
      points[1],
      props.settings.threshold,
      aspects[0],
      aspects[1],
    );
    const sample = {
      times: [...sampleTimes],
      elapsed: Math.max(0, sampleTimes[0] - starts.value[0]),
      points,
      angles,
      readings,
      distance: geometry,
    };
    peaks.value = readings.map(({ delta }, i) => {
      const previous = peaks.value[i];
      return delta !== null &&
        (!previous || Math.abs(delta) > Math.abs(previous.readings[i].delta!))
        ? sample
        : previous;
    });
    latest.value = frame.value = sample;
  } catch {
    invalidate();
    emit('error', '对比推理失败，请检查视频后重试。');
  }
}
function seekFrame(video: HTMLVideoElement, target: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    };
    const ready = () => {
      if (video.seeking || video.readyState < 2) return;
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('无法定位到该时刻。'));
    };
    const timeout = setTimeout(failed, 8000);
    video.addEventListener('seeked', ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', failed);
    try {
      if (video.currentTime !== target) video.currentTime = target;
      ready();
    } catch {
      failed();
    }
  });
}
async function review(sample: Sample) {
  if (busy.value || reviewing.value) return;
  pause();
  if (frame.value === sample) {
    previews.value?.scrollIntoView({ block: 'start' });
    return;
  }
  const controller = new AbortController();
  reviewController = controller;
  reviewing.value = true;
  try {
    await Promise.all(
      videos.map((video, i) => seekFrame(video, sample.times[i], controller.signal)),
    );
    if (controller.signal.aborted) return;
    sample.points.forEach((points, i) => {
      displayed[i] = points;
      displayedAngles[i] = sample.angles[i];
      trails[i] = [];
      draw(i);
    });
    frame.value = sample;
    previews.value?.scrollIntoView({ block: 'start' });
  } catch {
    if (!controller.signal.aborted) emit('error', '回看定位失败，请重试。');
  } finally {
    if (reviewController === controller) {
      controller.abort();
      reviewController = undefined;
      reviewing.value = false;
    }
  }
}
function degrees(value: number | null, signed = false) {
  if (value === null) return '—';
  const magnitude = Math.abs(value).toFixed(1);
  const sign = Number(magnitude) === 0 ? '' : value < 0 ? '−' : signed ? '+' : '';
  return `${sign}${magnitude}°`;
}
onBeforeUnmount(() => {
  disposed = true;
  preparations.forEach((controller) => controller?.abort());
  invalidate();
  models.forEach((m) => m.close());
  urls.forEach((u) => URL.revokeObjectURL(u));
});
</script>
<template>
  <section class="panel comparison-panel" aria-labelledby="compare-input-heading">
    <div class="panel-heading">
      <div>
        <h2 id="compare-input-heading">选择视频并对齐起点</h2>
        <p>可对照示范与练习，或回看同一动作的两次练习。用滑块找到两段视频里同一个动作的起点。</p>
      </div>
    </div>
    <div ref="previews" class="comparison-grid">
      <div v-for="index in lanes" :key="index" class="compare-source">
        <div class="compare-title">
          <b>{{ laneLabels[index] }}</b>
          <span :title="names[index]">{{ names[index] || '尚未选择' }}</span>
        </div>
        <div class="compare-canvas">
          <video
            :ref="
              (el) => {
                if (el) videos[index] = el as HTMLVideoElement;
              }
            "
            playsinline
            muted
            hidden
            @loadedmetadata="metadata(index)"
            @loadeddata="primePreview(index)"
            @seeked="preview(index)"
          />
          <canvas
            :ref="
              (el) => {
                if (el) canvases[index] = el as HTMLCanvasElement;
              }
            "
            :width="sizes[index].width"
            :height="sizes[index].height"
            :aria-label="`${laneLabels[index]}画面`"
          />
          <button v-if="!names[index] && !preparing[index]" @click="files[index].click()">
            <UploadCloud :size="28" />选择{{ laneLabels[index] }}
          </button>
        </div>
        <input
          :ref="
            (el) => {
              if (el) files[index] = el as HTMLInputElement;
            }
          "
          type="file"
          :accept="VIDEO_ACCEPT"
          hidden
          @change="load(index, $event)"
        />
        <div v-if="names[index] || preparing[index]" class="compare-source-controls">
          <label v-if="names[index]" class="compare-alignment">
            <span
              >对齐起点 <b>{{ starts[index].toFixed(2) }} s</b></span
            >
            <input
              type="range"
              min="0"
              :max="maxStart(index)"
              step="0.01"
              :value="starts[index]"
              :disabled="running || busy || reviewing || !maxStart(index)"
              :aria-label="`${laneLabels[index]}对齐起点`"
              :aria-valuetext="`${starts[index].toFixed(2)} 秒`"
              @input="setStart(index, $event)"
            />
          </label>
          <el-button @click="files[index].click()" :aria-label="`更换${laneLabels[index]}`"
            >更换视频</el-button
          >
        </div>
        <p v-if="hints[index]" role="status" class="compare-hint">{{ hints[index] }}</p>
      </div>
    </div>
    <div class="compare-controls">
      <el-button
        type="primary"
        :disabled="!overlap || !names.every(Boolean) || preparing.some(Boolean) || reviewing"
        :loading="busy"
        @click="play(false)"
      >
        <component :is="running ? Pause : Play" :size="15" />
        {{ running ? '暂停对比' : finished ? '重新分析' : latest ? '继续分析' : '开始对比' }}
      </el-button>
      <el-button
        v-if="latest && !running && !finished"
        :disabled="busy || reviewing"
        @click="play()"
      >
        <RotateCcw :size="14" />从对齐点重来
      </el-button>
      <span v-if="frame" class="compare-playhead">
        {{
          reviewing
            ? '正在定位'
            : showingPeak
              ? '差异回看'
              : running
                ? '分析中'
                : finished
                  ? '对比结束'
                  : '已暂停'
        }}
        <b>对齐后 {{ time.toFixed(2) }} s</b>
        <span>参考 {{ frame.times[0].toFixed(2) }} s · 待测 {{ frame.times[1].toFixed(2) }} s</span>
      </span>
      <span v-else-if="running">正在分析画面…</span>
      <span v-else-if="finished">重叠区间内未取得同步画面，可将起点提前后重试。</span>
      <span v-else-if="overlap > 0">可对比 {{ overlap.toFixed(2) }} s</span>
      <span v-else>请先选择两段视频</span>
    </div>

    <section v-if="frame" class="compare-results" aria-labelledby="compare-result-heading">
      <div v-if="greatest" class="compare-peak">
        <div>
          <p>已分析画面中最大角度差</p>
          <strong
            >{{ measurements[greatest.index].label }}
            <span>{{ degrees(greatest.magnitude) }}</span></strong
          >
          <p
            >参考 {{ greatest.sample.times[0].toFixed(2) }} s · 待测
            {{ greatest.sample.times[1].toFixed(2) }} s</p
          >
        </div>
        <el-button
          :disabled="reviewing || busy || (frame === greatest.sample && !running)"
          @click="review(greatest.sample)"
        >
          {{ frame === greatest.sample && !running ? '当前画面' : '回看最大差异' }}
          <ArrowUpRight :size="14" />
        </el-button>
      </div>
      <div class="compare-result-heading">
        <h2 id="compare-result-heading">当前画面的关节角度</h2>
        <p>双路可比 {{ comparable }} / {{ measurements.length }} 项 · 角度差为待测减参考</p>
      </div>
      <p v-if="!comparable" class="compare-hint"
        >当前画面缺少两路都清晰可见的关节。可继续播放，或选择人物完整入镜的片段。</p
      >
      <div
        v-if="comparable || greatest"
        class="compare-table-wrap"
        tabindex="0"
        role="region"
        aria-label="关节角度差异表"
      >
        <table class="compare-table">
          <thead
            ><tr
              ><th scope="col">关节</th><th scope="col">参考</th><th scope="col">待测</th
              ><th scope="col">角度差</th><th scope="col">最大差异回看</th></tr
            ></thead
          >
          <tbody>
            <tr v-for="({ label }, index) in measurements" :key="label">
              <th scope="row">{{ label }}</th>
              <td>{{ degrees(frame.readings[index].reference) }}</td>
              <td>{{ degrees(frame.readings[index].candidate) }}</td>
              <td :class="{ 'compare-delta': frame.readings[index].delta !== null }">{{
                degrees(frame.readings[index].delta, true)
              }}</td>
              <td>
                <button
                  v-if="peaks[index]"
                  class="compare-jump"
                  :aria-label="`回看${label}最大差异`"
                  :disabled="reviewing || busy || (frame === peaks[index] && !running)"
                  @click="review(peaks[index]!)"
                  >{{ degrees(Math.abs(peaks[index]!.readings[index].delta!)) }}
                  <ArrowUpRight :size="12"
                /></button>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details class="compare-metric">
        <summary
          >全身几何距离 <b>{{ distance === null ? '—' : distance.toFixed(4) }}</b></summary
        >
        <p
          >将共同可信的关键点按躯干长度缩放、髋中心对齐后计算平均距离。数值越小，当前两帧的几何形状越接近。</p
        >
      </details>
    </section>
    <div class="info-line">
      尽量使用相近的拍摄视角和动作节奏。系统以约 10 Hz
      采样两段视频的重叠区间，按对齐后的时间比较二维投影角度。遮挡会减少可比关节，读数用于观察差异。
    </div>
  </section>
</template>
