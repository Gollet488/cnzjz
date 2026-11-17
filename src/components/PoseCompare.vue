<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, triggerRef, watch, onBeforeUnmount } from 'vue';
import { UploadCloud, Upload, ScanLine, RotateCcw, ArrowUpRight, Download } from 'lucide-vue-next';
import { MAX_FRAMES } from '../config';
import { SampleContinuity } from '../analysis/sampleTiming';
import { renderPose } from '../utils/renderer';
import {
  centerOfMass,
  filteredJointAngles,
  jointAngles,
  LandmarkFilter,
  poseDistance,
  reliable,
} from '../utils/poseMath';
import type { Angles, Settings, Landmark } from '../types';
import { download } from '../utils/download';
import { stageSize } from '../utils/dimensions';
import { prepareVideo, VIDEO_ACCEPT, type PreparedVideo } from '../video/prepare';
import { OfflineVideoJob, readVideoStill } from '../video/job';
import {
  COMPARISON_MAX_SKEW,
  comparisonCSV,
  comparisonMeasurements as measurements,
  comparisonPairs,
  comparisonReadings,
  comparisonSchedule,
  ComparisonSeries,
  type ComparisonSample as Sample,
} from '../video/comparison';
import PlaybackTransport from './PlaybackTransport.vue';
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ error: [message: string] }>();
const videos: HTMLVideoElement[] = [];
const canvases: HTMLCanvasElement[] = [];
const files: HTMLInputElement[] = [];
const preparedVideos: (PreparedVideo | undefined)[] = [];
const previews = ref<HTMLElement>();
const lanes = [0, 1] as const;
const laneLabels = ['参考视频', '待测视频'];
const starts = ref([0, 0]);
const durations = ref([0, 0]);
const transcoded = ref([false, false]);
const names = ref(['', '']),
  running = ref(false),
  finished = ref(false),
  failed = ref(false);
const invalidVideos = ref([false, false]);
const frame = shallowRef<Sample | null>(null);
const latest = shallowRef<Sample | null>(null);
const series = shallowRef(new ComparisonSeries());
const peaks = computed(() => series.value.peaks);
const sampleCount = computed(() => series.value.samples.length);
const frameIndex = computed(() =>
  frame.value === latest.value || !frame.value
    ? sampleCount.value - 1
    : series.value.samples.indexOf(frame.value),
);
const reviewing = ref(false);
const exporting = ref(false);
const showingPeak = computed(() => frame.value !== null && frame.value !== latest.value);
const time = computed(() => frame.value?.elapsed ?? 0);
const comparable = computed(
  () => frame.value?.readings.filter(({ delta }) => delta !== null).length ?? 0,
);
const greatest = computed(() => {
  let best: { sample: Sample; index: number; magnitude: number } | undefined;
  series.value.peaks.forEach((sample, index) => {
    if (!sample) return;
    const magnitude = Math.abs(sample.readings[index].delta!);
    if (!best || magnitude > best.magnitude) best = { sample, index, magnitude };
  });
  return best;
});
const overlap = computed(() =>
  Math.max(0, Math.min(...durations.value.map((d, i) => d - starts.value[i]))),
);
const schedule = computed(() => comparisonSchedule(overlap.value));
const reachedSlots = computed(() =>
  finished.value ? schedule.value.slots : (latest.value?.slot ?? -1) + 1,
);
const missed = computed(() => reachedSlots.value - sampleCount.value);
const meanDistance = computed(() =>
  series.value.distanceCount ? series.value.distanceSum / series.value.distanceCount : null,
);
const distance = computed(() => frame.value?.distance ?? null);
const progress = computed(() => {
  if (overlap.value <= 0) return 0;
  if (finished.value && !showingPeak.value) return 1;
  return Math.min(1, time.value / overlap.value);
});
const sizes = ref([stageSize(), stageSize()]);
const trails: ({ x: number; y: number } | null)[][] = [[], []];
const displayed: Landmark[][] = [[], []];
const displayedAngles: (Angles | undefined)[] = [];
const displayedImages: (ImageBitmap | undefined)[] = [];
const sourceAspects: number[] = [];
interface TrackedFrame {
  image: ImageBitmap;
  points: Landmark[];
  rawAngles: Angles;
  angles: Angles;
  reliablePoints: number;
  acknowledge?: () => void;
}
const activeRun = shallowRef<{
  jobs: OfflineVideoJob[];
  waiting: (TrackedFrame | undefined)[];
}>();
const urls: string[] = [];
const preparations: (AbortController | undefined)[] = [];
const preparing = ref([false, false]);
const hints = ref(['', '']);
let disposed = false;
let reviewController: AbortController | undefined;
let exportController: AbortController | undefined;
function draw(index: number) {
  const video = videos[index];
  if (!canvases[index]) return;
  renderPose(
    canvases[index],
    displayed[index],
    props.settings,
    displayedImages[index] ?? (video?.readyState >= 2 ? video : undefined),
    trails[index],
    sourceAspects[index] ||
      (video?.videoWidth && video.videoWidth / video.videoHeight) ||
      undefined,
    undefined,
    displayedAngles[index],
  );
}
function cancelRun() {
  const run = activeRun.value;
  activeRun.value = undefined;
  running.value = false;
  run?.jobs.forEach((job) => job.cancel());
  run?.waiting.forEach((item) => {
    item?.image.close();
    item?.acknowledge?.();
  });
}
function invalidate() {
  cancelRun();
  reviewController?.abort();
  reviewController = undefined;
  reviewing.value = false;
  exportController?.abort();
  frame.value = null;
  latest.value = null;
  series.value = new ComparisonSeries();
  finished.value = false;
  failed.value = false;
  lanes.forEach((i) => {
    trails[i] = [];
    displayed[i] = [];
    displayedAngles[i] = undefined;
    displayedImages[i]?.close();
    displayedImages[i] = undefined;
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
  preparedVideos[index] = undefined;
  sourceAspects[index] = 0;
  starts.value[index] = 0;
  durations.value[index] = 0;
  transcoded.value[index] = false;
  invalidVideos.value[index] = false;
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
    preparedVideos[index] = prepared;
    urls[index] = URL.createObjectURL(prepared.file);
    videos[index].src = urls[index];
    videos[index].load();
    names.value[index] = file.name;
    transcoded.value[index] = prepared.transcoded;
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
function videoError(index: number) {
  const video = videos[index];
  if (!video.error || !names.value[index]) return;
  invalidVideos.value[index] = true;
  reviewController?.abort();
  hints.value[index] = '浏览器无法播放此视频，请更换文件。';
  stopWithError(hints.value[index]);
}
function primePreview(index: number) {
  const video = videos[index];
  // A loaded but hidden video can still lack a drawable first frame until it seeks.
  if (!activeRun.value && !reviewing.value && !frame.value && !video.seeking)
    video.currentTime = starts.value[index];
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
  running.value = false;
  activeRun.value?.jobs.forEach((job) => job.pause());
}

function play(restart = true) {
  if (running.value) {
    pause();
    return;
  }
  const [reference, candidate] = preparedVideos;
  if (
    disposed ||
    reviewing.value ||
    exporting.value ||
    preparing.value.some(Boolean) ||
    overlap.value <= 0 ||
    invalidVideos.value.some(Boolean) ||
    !reference ||
    !candidate
  )
    return;
  if (!restart && activeRun.value) {
    running.value = true;
    activeRun.value.jobs.forEach((job) => job.resume());
    return;
  }

  invalidate();
  const sources = [reference, candidate];
  const origins = [...starts.value];
  const pairs = comparisonPairs(
    sources.map(({ probe }) => probe.timestamps),
    origins,
    overlap.value,
  );
  if (!pairs.length) {
    finished.value = true;
    return;
  }

  const run = { jobs: [] as OfflineVideoJob[], waiting: [] as (TrackedFrame | undefined)[] };
  activeRun.value = run;
  running.value = true;
  const current = () => activeRun.value === run;
  const { threshold, window } = props.settings;
  let completed = 0;
  try {
    for (const i of lanes) {
      const { file, probe } = sources[i];
      const filter = new LandmarkFilter();
      const continuity = new SampleContinuity();
      let previous: number | undefined;
      let received = 0;
      const lastFrame = pairs.at(-1)!.frames[i];
      // Match the acquisition module's full-file sampling schedule above its frame limit.
      const clip = probe.timestamps.length <= MAX_FRAMES ? { start: 0, end: lastFrame } : undefined;
      run.jobs.push(
        new OfflineVideoJob(
          file,
          MAX_FRAMES,
          {
            metadata({ aspect }) {
              if (!current()) return;
              sourceAspects[i] = aspect;
              sizes.value[i] = stageSize(aspect);
            },
            frame(value) {
              if (!current()) return false;
              const gap =
                previous !== undefined && continuity.observe(value.time - previous, false);
              previous = value.time;
              const raw = value.points;
              if (!raw.length || gap) filter.clear();
              const aspect = sourceAspects[i];
              const points = raw.length ? filter.apply(raw, window, threshold, true, aspect) : [];
              const pair = pairs[received];
              if (!pair || value.time < pair.times[i]) {
                value.preview?.close();
                return;
              }
              if (value.time !== pair.times[i] || !value.preview)
                throw new Error('对比未取得所选源帧及其预览。');

              received++;
              const rawAngles = jointAngles(raw, threshold, aspect);
              const waiting: TrackedFrame = {
                image: value.preview,
                points,
                rawAngles,
                angles: filteredJointAngles(points, rawAngles, threshold, aspect),
                reliablePoints: raw.filter((point) => reliable(point, threshold)).length,
              };
              run.waiting[i] = waiting;
              const [left, right] = run.waiting;
              if (!left || !right) {
                return new Promise<void>((resolve) => {
                  waiting.acknowledge = resolve;
                });
              }

              publishPair(pair, [left, right], origins, threshold);
              run.waiting.length = 0;
              left.acknowledge?.();
              right.acknowledge?.();
            },
            state(state, detail) {
              if (!current() || state === 'preparing' || state === 'paused' || state === 'running')
                return;
              if ((state !== 'completed' && state !== 'sampled') || received !== pairs.length) {
                stopWithError(`${laneLabels[i]}逐帧分析中断：${detail || '未取得全部计划源帧。'}`);
                return;
              }
              if (++completed === lanes.length) {
                cancelRun();
                finished.value = true;
              }
            },
          },
          clip,
          'analysis',
          pairs.map(({ frames }) => probe.timestamps[frames[i]]),
        ),
      );
    }
  } catch (error) {
    stopWithError(error instanceof Error ? error.message : '无法启动对比分析。');
  }
}

function publishPair(
  pair: Pick<Sample, 'slot' | 'frames' | 'times'>,
  tracked: TrackedFrame[],
  origins: number[],
  threshold: number,
) {
  const points = tracked.map((value) => value.points);
  const angles = tracked.map((value) => value.angles);
  const elapsed = Math.max(0, pair.times[0] - origins[0]);
  const sample: Sample = {
    ...pair,
    elapsed,
    skew: pair.times[1] - origins[1] - elapsed,
    points,
    angles,
    rawAngles: tracked.map((value) => value.rawAngles),
    reliablePoints: tracked.map((value) => value.reliablePoints),
    readings: comparisonReadings(angles),
    distance: poseDistance(points[0], points[1], threshold, sourceAspects[0], sourceAspects[1]),
  };
  for (const i of lanes) {
    const latestPoint = centerOfMass(points[i], threshold);
    if (props.settings.trajectory) trails[i] = [...trails[i], latestPoint].slice(-120);
    showFrame(i, sample, tracked[i].image);
  }
  series.value.append(sample);
  triggerRef(series);
  latest.value = frame.value = sample;
}

function showFrame(index: number, sample: Sample, image: ImageBitmap) {
  displayedImages[index]?.close();
  displayedImages[index] = image;
  displayed[index] = sample.points[index];
  displayedAngles[index] = sample.angles[index];
  draw(index);
}

function stopWithError(message: string) {
  cancelRun();
  finished.value = false;
  failed.value = true;
  emit('error', message);
}

async function review(sample: Sample, scroll = true) {
  if (reviewing.value) return;
  pause();
  if (frame.value === sample) {
    if (scroll) previews.value?.scrollIntoView({ block: 'start' });
    return;
  }
  const controller = new AbortController();
  reviewController = controller;
  reviewing.value = true;
  const images = await Promise.allSettled(
    lanes.map((i) =>
      readVideoStill(
        preparedVideos[i]!.file,
        sample.frames[i],
        sample.times[i],
        controller.signal,
      ).catch((error) => {
        if (!controller.signal.aborted) emit('error', '回看定位失败，请重试。');
        controller.abort();
        throw error;
      }),
    ),
  );
  if (
    !controller.signal.aborted &&
    images[0].status === 'fulfilled' &&
    images[1].status === 'fulfilled'
  ) {
    trails.forEach((trail) => {
      trail.length = 0;
    });
    showFrame(0, sample, images[0].value);
    showFrame(1, sample, images[1].value);
    frame.value = sample;
    if (scroll) previews.value?.scrollIntoView({ block: 'start' });
  } else {
    for (const image of images) if (image.status === 'fulfilled') image.value.close();
  }
  if (reviewController === controller) {
    reviewController = undefined;
    reviewing.value = false;
  }
}
function reviewAt(event: Event) {
  const slider = event.target as HTMLInputElement;
  const sample = series.value.samples[Number(slider.value) - 1];
  slider.value = String(frameIndex.value + 1);
  if (sample) void review(sample, false);
}
function percentage(count: number, total: number) {
  return total ? `${((count / total) * 100).toFixed(1)}%` : '—';
}
async function exportSamples() {
  if (!reachedSlots.value || exporting.value || running.value || reviewing.value) return;
  const controller = new AbortController();
  exportController = controller;
  exporting.value = true;
  try {
    const blob = await comparisonCSV(
      {
        ...schedule.value,
        reachedSlots: reachedSlots.value,
        samples: series.value.samples,
        overlap: overlap.value,
        status: failed.value ? 'failed' : finished.value ? 'completed' : 'paused',
        threshold: props.settings.threshold,
        window: props.settings.window,
        sources: lanes.map((index) => ({
          name: names.value[index],
          start: starts.value[index],
          duration: durations.value[index],
          width: videos[index].videoWidth,
          height: videos[index].videoHeight,
          transcoded: transcoded.value[index],
        })),
      },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    download(blob, 'kinetic-video-comparison.csv');
  } catch {
    if (!controller.signal.aborted) emit('error', '对比数据导出失败，请重试。');
  } finally {
    exportController = undefined;
    exporting.value = false;
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
        <div class="pose-stage compare-canvas">
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
            @error="videoError(index)"
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
          <div v-if="preparing[index]" class="model-loading">
            <ScanLine class="spin" :size="24" aria-hidden="true" />正在准备视频…
          </div>
          <div v-else-if="!names[index]" class="stage-empty">
            <UploadCloud :size="28" aria-hidden="true" />
            <el-button @click="files[index].click()">选择{{ laneLabels[index] }}</el-button>
          </div>
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
              :disabled="running || reviewing || !maxStart(index)"
              :aria-label="`${laneLabels[index]}对齐起点`"
              :aria-valuetext="`${starts[index].toFixed(2)} 秒`"
              @input="setStart(index, $event)"
            />
          </label>
          <button
            type="button"
            class="text-button"
            :aria-label="`更换${laneLabels[index]}`"
            @click="files[index].click()"
            ><Upload :size="14" aria-hidden="true" />更换视频</button
          >
        </div>
        <p v-if="hints[index]" role="status" class="compare-hint">{{ hints[index] }}</p>
      </div>
    </div>
    <div class="transport compare-transport">
      <PlaybackTransport
        label="对比播放器"
        progress-label="对比进度"
        :toggle-label="
          running
            ? '暂停对比'
            : finished || failed
              ? '重新分析'
              : activeRun
                ? '继续分析'
                : '开始对比'
        "
        :playing="running"
        :busy="false"
        :disabled="
          overlap <= 0 ||
          !names.every(Boolean) ||
          preparing.some(Boolean) ||
          reviewing ||
          exporting ||
          invalidVideos.some(Boolean)
        "
        :time="time"
        :progress="progress"
        @toggle="play(false)"
      />
      <div class="transport-main compare-controls">
        <button
          v-if="activeRun && !running"
          type="button"
          class="text-button"
          :disabled="reviewing || exporting"
          @click="play()"
        >
          <RotateCcw :size="14" aria-hidden="true" />从对齐点重来
        </button>
        <span v-if="frame" class="compare-playhead">
          {{
            reviewing
              ? '正在定位'
              : showingPeak
                ? '采样回看'
                : running
                  ? '分析中'
                  : finished
                    ? '对比结束'
                    : failed
                      ? '分析中断'
                      : '已暂停'
          }}
          <b>对齐后 {{ time.toFixed(2) }} s</b>
          <span
            >参考 {{ frame.times[0].toFixed(2) }} s · 待测 {{ frame.times[1].toFixed(2) }} s</span
          >
        </span>
        <span v-else-if="running">正在逐帧分析视频…</span>
        <span v-else-if="finished">重叠区间内未取得同步画面，可将起点提前后重试。</span>
        <span v-else-if="failed">分析中断，请重试或更换视频。</span>
        <span v-else-if="overlap > 0">可对比 {{ overlap.toFixed(2) }} s</span>
        <span v-else>请先选择两段视频</span>
      </div>
    </div>

    <section
      v-if="frame || reachedSlots"
      class="compare-results"
      aria-labelledby="compare-data-heading"
    >
      <div class="compare-data">
        <div class="compare-data-heading">
          <h2 id="compare-data-heading">对比区间数据</h2>
          <el-button :disabled="running || reviewing" :loading="exporting" @click="exportSamples">
            <Download :size="14" aria-hidden="true" />下载对比 CSV
          </el-button>
        </div>
        <dl class="compare-summary">
          <div>
            <dt>配对样本 / 计划采样点</dt>
            <dd>{{ sampleCount }} / {{ schedule.slots }}</dd>
          </div>
          <div>
            <dt>未配对采样点</dt>
            <dd>{{ missed }}</dd>
          </div>
          <div>
            <dt>有可比角度的样本</dt>
            <dd
              >{{ series.comparable }}
              <span>· {{ percentage(series.comparable, sampleCount) }}</span></dd
            >
          </div>
          <div>
            <dt>平均全身几何距离</dt>
            <dd
              >{{ meanDistance === null ? '—' : meanDistance.toFixed(4) }}
              <span>· {{ series.distanceCount }} 个有效样本</span></dd
            >
          </div>
        </dl>
        <p class="compare-hint">
          参考与待测分别有 {{ series.poses[0] }} 和 {{ series.poses[1] }} 个样本通过人体检测。
          计划间隔 {{ schedule.interval.toFixed(3) }} s，两路对齐时间差最多
          {{ (COMPARISON_MAX_SKEW * 1000).toFixed(0) }} ms。覆盖率以配对样本为分母。
        </p>
        <label v-if="sampleCount > 1" class="compare-alignment compare-sample-seek">
          <span
            >回看已采样画面 <b>{{ frameIndex + 1 }} / {{ sampleCount }}</b></span
          >
          <input
            type="range"
            min="1"
            :max="sampleCount"
            :value="frameIndex + 1"
            :disabled="running || reviewing"
            aria-label="回看已采样画面"
            :aria-valuetext="`第 ${frameIndex + 1} 个样本，对齐后 ${time.toFixed(2)} 秒`"
            @change="reviewAt"
          />
        </label>
      </div>
      <template v-if="frame">
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
            :disabled="reviewing || (frame === greatest.sample && !running)"
            @click="review(greatest.sample)"
          >
            {{ frame === greatest.sample && !running ? '当前画面' : '回看最大差异' }}
            <ArrowUpRight :size="14" />
          </el-button>
        </div>
        <div class="compare-result-heading">
          <h2 id="compare-result-heading">当前画面的关节角度</h2>
          <p>
            双路可比 {{ comparable }} / {{ measurements.length }} 项 · 可信关键点 参考
            {{ frame.reliablePoints[0] }}/33、待测 {{ frame.reliablePoints[1] }}/33 · 配对时间差
            {{ Math.abs(frame.skew * 1000).toFixed(0) }} ms · 角度差为待测减参考
          </p>
        </div>
        <p v-if="!comparable" class="compare-hint"
          >当前画面缺少两路都清晰可见的关节。可继续播放，或选择人物完整入镜的片段。</p
        >
        <div class="compare-table-wrap" tabindex="0" role="region" aria-label="关节角度差异表">
          <table class="compare-table">
            <thead
              ><tr
                ><th scope="col">关节</th><th scope="col">参考</th><th scope="col">待测</th
                ><th scope="col">角度差</th><th scope="col">双路有效样本</th>
                <th scope="col">平均绝对差</th><th scope="col">最大差异回看</th></tr
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
                <td
                  :title="`参考有效 ${series.joints[index].reference} · 待测有效 ${series.joints[index].candidate}`"
                >
                  {{ series.joints[index].paired }} / {{ sampleCount }}
                </td>
                <td>{{
                  degrees(
                    series.joints[index].paired
                      ? series.joints[index].absoluteSum / series.joints[index].paired
                      : null,
                  )
                }}</td>
                <td>
                  <button
                    v-if="peaks[index]"
                    class="compare-jump"
                    :aria-label="`回看${label}最大差异`"
                    :disabled="reviewing || (frame === peaks[index] && !running)"
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
      </template>
    </section>
    <div class="info-line">
      尽量使用相近的拍摄视角和动作节奏。系统先按源帧时间逐帧追踪，再在重叠区间按最多约 10 Hz
      配对比较二维投影角度。超长视频沿用采集模块的帧数上限与全段抽样。遮挡会减少可比关节，缺失角度留空。
    </div>
  </section>
</template>
