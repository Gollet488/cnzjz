<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { UploadCloud, Play, Pause, ArrowLeftRight } from 'lucide-vue-next';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { renderPose } from '../utils/renderer';
import { centerOfMass, LandmarkFilter, poseDistance } from '../utils/poseMath';
import type { Settings, Landmark } from '../types';
import { stageSize } from '../utils/dimensions';
import { prepareVideo, VIDEO_ACCEPT } from '../video/prepare';
const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ error: [message: string] }>();
const videos: HTMLVideoElement[] = [];
const canvases: HTMLCanvasElement[] = [];
const files: HTMLInputElement[] = [];
const names = ref(['', '']),
  running = ref(false),
  busy = ref(false),
  distance = ref<number | null>(null),
  time = ref(0);
const sizes = ref([stageSize(), stageSize()]);
const models: PoseLandmarker[] = [];
const filters = [new LandmarkFilter(), new LandmarkFilter()];
const trails: ({ x: number; y: number } | null)[][] = [[], []];
const displayed: Landmark[][] = [[], []];
const sampleTimes = [-1, -1];
const urls: string[] = [];
const preparations: (AbortController | undefined)[] = [];
const preparing = ref([false, false]);
const hints = ref(['', '']);
let raf = 0,
  last = 0,
  disposed = false,
  generation = 0;
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
  );
}
function invalidate() {
  pause();
  distance.value = null;
  time.value = 0;
  last = 0;
  filters.forEach((filter, i) => {
    filter.clear();
    trails[i] = [];
    displayed[i] = [];
    sampleTimes[i] = -1;
    draw(i);
  });
}
watch(() => [props.settings.threshold, props.settings.window], invalidate, { flush: 'sync' });
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
function pause() {
  generation++;
  running.value = false;
  videos.forEach((v) => v.pause());
  cancelAnimationFrame(raf);
}
async function play() {
  if (running.value) {
    pause();
    return;
  }
  if (disposed || busy.value || preparing.value.some(Boolean) || !names.value.every(Boolean))
    return;
  invalidate();
  const operation = generation;
  const current = () => !disposed && operation === generation;
  const created: PoseLandmarker[] = [];
  busy.value = true;
  try {
    if (models.length !== 2) {
      const wasm = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      if (!current()) return;
      for (let i = 0; i < 2; i++) {
        const model = await PoseLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: `${assets}pose_landmarker_lite.task` },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        created.push(model);
        if (!current()) return;
      }
      models.push(...created);
      created.length = 0;
    }
    videos.forEach((v) => (v.currentTime = 0));
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
  if (videos.some((v) => v.ended)) {
    pause();
    return;
  }
  if (videos.some((v) => v.readyState < 2 || v.seeking || !v.videoWidth || !v.videoHeight)) return;
  if (Math.abs(videos[0].currentTime - videos[1].currentTime) > 0.12) {
    videos[1].currentTime = videos[0].currentTime;
    return;
  }
  if (videos.some((v, i) => v.currentTime === sampleTimes[i])) return;
  const points: Landmark[][] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const result = models[i].detectForVideo(videos[i], now);
      const p =
        result.landmarks[0]?.map((v) => ({
          x: v.x,
          y: v.y,
          z: v.z,
          visibility: v.visibility ?? 0,
        })) ?? [];
      if (!p.length) {
        filters[i].clear();
        trails[i] = [];
      }
      const filtered = p.length
        ? filters[i].apply(p, props.settings.window, props.settings.threshold)
        : [];
      points.push(filtered);
      displayed[i] = filtered;
      sampleTimes[i] = videos[i].currentTime;
      if (props.settings.trajectory) {
        trails[i].push(centerOfMass(filtered, props.settings.threshold));
        trails[i] = trails[i].slice(-120);
      }
      draw(i);
    }
    distance.value = poseDistance(
      points[0],
      points[1],
      props.settings.threshold,
      videos[0].videoWidth / videos[0].videoHeight,
      videos[1].videoWidth / videos[1].videoHeight,
    );
    time.value = videos[0].currentTime;
  } catch {
    invalidate();
    emit('error', '对比推理失败，请检查视频后重试。');
  }
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
  <section class="panel comparison-panel"
    ><div class="panel-heading"
      ><div
        ><h3>让两段姿态，在同一时间相遇</h3
        ><p>参考由你选择，距离使用两路独立滑动滤波后的关键点。</p></div
      ><ArrowLeftRight :size="23"
    /></div>
    <div class="comparison-grid"
      ><div v-for="(_, index) in names" :key="index" class="compare-source"
        ><div class="compare-title"
          ><b>{{ index === 0 ? '参考视频' : '待测视频' }}</b
          ><span>{{ names[index] || '尚未选择' }}</span></div
        ><div
          class="compare-canvas"
          :style="{ aspectRatio: `${sizes[index]!.width}/${sizes[index]!.height}` }"
          ><video
            :ref="
              (el) => {
                if (el) videos[index] = el as HTMLVideoElement;
              }
            "
            playsinline
            muted
            hidden
            @loadedmetadata="
              sizes[index] = stageSize(videos[index]!.videoWidth / videos[index]!.videoHeight)
            "
          /><canvas
            :ref="
              (el) => {
                if (el) canvases[index] = el as HTMLCanvasElement;
              }
            "
            :width="sizes[index]!.width"
            :height="sizes[index]!.height"
          /><button v-if="!names[index]" @click="files[index].click()"
            ><UploadCloud :size="32" /><span>选择本地视频</span></button
          ></div
        ><input
          :ref="
            (el) => {
              if (el) files[index] = el as HTMLInputElement;
            }
          "
          type="file"
          :accept="VIDEO_ACCEPT"
          hidden
          @change="load(index, $event)"
        /><el-button @click="files[index].click()">{{
          names[index] || preparing[index] ? '更换视频' : '上传视频'
        }}</el-button
        ><p v-if="hints[index]" role="status">{{ hints[index] }}</p></div
      ></div
    >
    <div class="compare-controls"
      ><el-button
        type="primary"
        :disabled="!names.every(Boolean) || preparing.some(Boolean)"
        :loading="busy"
        @click="play"
        ><component :is="running ? Pause : Play" :size="15" />{{
          running ? '暂停对比' : '从头同步分析'
        }}</el-button
      ><span>{{
        running ? '对比中' : distance !== null ? '已暂停 · 最后有效值' : '待开始 / 暂无有效距离'
      }}</span
      ><span
        >预览时间 <b>{{ time.toFixed(2) }} s</b></span
      ><span
        >归一化距离 <b>{{ distance === null ? '—' : distance.toFixed(4) }}</b></span
      ></div
    >
    <div class="info-line"
      >距离越小表示两帧几何姿态越接近，不代表动作正确或错误。已按各视频源宽高比校正几何坐标；请使用接近的视角与起始时刻。约
      10 Hz
      同步预览，未实现严格逐帧或动作序列配准；任一路结束时暂停。阈值或窗口变化会暂停并清空旧结果，需从头重新分析。</div
    ></section
  >
</template>
