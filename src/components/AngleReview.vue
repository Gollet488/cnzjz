<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, watchEffect } from 'vue';
import type { SessionInfo } from '../analysis/session';
import { sourceClock, sourceLabel } from '../analysis/sourceDisplay';
import { JOINTS } from '../config';
import type { Channel, Joint, PoseFrame, Side } from '../types';
import { download } from '../utils/download';
import { angle, angleValue, type Point2D } from '../utils/poseMath';

const props = defineProps<{
  image: ImageBitmap;
  sample: PoseFrame;
  session: SessionInfo;
  joint: Joint;
}>();
const landmarks: Record<Joint, [string, string, string]> = {
  shoulder: ['肘', '肩', '髋'],
  elbow: ['肩', '肘', '腕'],
  hip: ['肩', '髋', '膝'],
  knee: ['髋', '膝', '踝'],
  ankle: ['膝', '踝', '前脚掌点'],
  spine: ['双肩中点', '双髋中点', '双踝中点'],
  wrist: ['肘', '腕', '食指点'],
};
const canvas = ref<HTMLCanvasElement>();
const picture = ref<HTMLElement>();
const cursor = ref<Point2D | null>(null);
const side = ref<Side>('left');
const zoom = ref(1);
const channel = computed(() => (props.joint === 'spine' ? 'midline' : side.value));
type Draft = { points: Point2D[]; history: Point2D[][] };
const drafts = reactive<Record<Channel, Draft>>({
  left: { points: [], history: [] },
  right: { points: [], history: [] },
  midline: { points: [], history: [] },
});
const draft = computed(() => drafts[channel.value]);
const points = computed(() => draft.value.points);
const editing = ref<number | null>(null);
const activePoint = computed(
  () => editing.value ?? (points.value.length < 3 ? points.value.length : null),
);
const instructions = computed(() => landmarks[props.joint]);
const label = computed(() => JOINTS.find(({ key }) => key === props.joint)!.label);
const source = computed(() => sourceLabel(props.session));
const clock = computed(() => sourceClock(props.session));
const raw = computed(() => angleValue(props.sample.rawAngles, props.joint, channel.value));
const filtered = computed(() => angleValue(props.sample.angles, props.joint, channel.value));
const aspect = computed(() => props.session.parameters.aspect);
const imageAspect = computed(() => props.image.width / props.image.height);
const position = ({ x, y }: Point2D) => ({ left: `${x * 100}%`, top: `${y * 100}%` });
const segments = computed(() =>
  points.value.slice(1).map((point, index) => {
    const start = points.value[index];
    const dx = point.x - start.x;
    const dy = (point.y - start.y) / imageAspect.value;
    return {
      ...position(start),
      width: `${Math.hypot(dx, dy) * 100}%`,
      transform: `rotate(${Math.atan2(dy, dx)}rad)`,
    };
  }),
);
const measured = computed(() => {
  const [a, b, c] = points.value;
  return a && b && c ? angle(a, b, c, aspect.value) : null;
});
const status = computed(() => {
  const index = activePoint.value;
  if (index !== null)
    return `${editing.value === null ? '请选择' : '正在调整'}第 ${index + 1} 点（${instructions.value[index]}）`;
  return measured.value === null ? '肢段投影过短，请调整点位' : '三点测量完成';
});
const degrees = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}°`);
const zoomLevels = [
  { value: 1, label: '适应画面' },
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
];
const arrows: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const center = { x: 0.5, y: 0.5 };

function commit(next: Point2D[]) {
  draft.value.history.push(points.value);
  draft.value.points = next;
  editing.value = null;
}
function pick(point: Point2D) {
  const index = activePoint.value;
  if (index === null) return;
  const next = points.value.slice();
  next[index] = point;
  commit(next);
}
function pickPointer(event: MouseEvent) {
  if (activePoint.value === null) return;
  const bounds = canvas.value!.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) pick({ x, y });
  cursor.value = null;
}
function showPoint(point: Point2D, centered = false) {
  const viewport = picture.value;
  const image = canvas.value?.getBoundingClientRect();
  if (!viewport || !image) return;
  const bounds = viewport.getBoundingClientRect();
  const x = image.left - bounds.left + point.x * image.width;
  const y = image.top - bounds.top + point.y * image.height;
  const left = centered
    ? viewport.clientWidth / 2
    : Math.max(14, Math.min(viewport.clientWidth - 14, x));
  const top = centered
    ? viewport.clientHeight / 2
    : Math.max(14, Math.min(viewport.clientHeight - 14, y));
  viewport.scrollBy({ left: x - left, top: y - top });
}
async function changeZoom(level: number) {
  if (zoom.value === level) return;
  const viewport = picture.value;
  const image = canvas.value?.getBoundingClientRect();
  if (!viewport || !image) return;
  const bounds = viewport.getBoundingClientRect();
  const anchor = cursor.value ?? {
    x: clamp((bounds.left + viewport.clientWidth / 2 - image.left) / image.width),
    y: clamp((bounds.top + viewport.clientHeight / 2 - image.top) / image.height),
  };
  zoom.value = level;
  await nextTick();
  showPoint(anchor, true);
}
function editPoint(index: number) {
  editing.value = index < points.value.length ? index : null;
  cursor.value = points.value[index] ?? null;
  canvas.value?.focus({ preventScroll: true });
  if (cursor.value) showPoint(cursor.value);
}
function moveCursor(event: KeyboardEvent) {
  const step = arrows[event.key];
  if (!step && event.key !== 'Enter') return;
  const index = activePoint.value;
  if (index === null) return;
  event.preventDefault();
  const current = cursor.value ?? points.value[index] ?? center;
  if (event.key === 'Enter') pick(current);
  else {
    const stride = event.shiftKey ? 10 : 1;
    cursor.value = {
      x: clamp(current.x + (step[0] * stride) / props.image.width),
      y: clamp(current.y + (step[1] * stride) / props.image.height),
    };
    showPoint(cursor.value);
  }
}
function undo() {
  const previous = draft.value.history.pop();
  if (previous) draft.value.points = previous;
  cancelEdit();
}
function cancelEdit() {
  editing.value = null;
  cursor.value = null;
}
function reset() {
  commit([]);
  cursor.value = null;
}
watch(channel, cancelEdit);

watchEffect(() => {
  canvas.value?.getContext('2d')?.drawImage(props.image, 0, 0);
});

function save() {
  if (measured.value === null) return;
  const record = {
    version: 1,
    basis: 'manual-points',
    sessionId: props.session.sessionId,
    revision: props.session.revision,
    source: props.session.source,
    fileName: props.session.fileName,
    synthetic: props.session.synthetic,
    acquisition: props.session.acquisition?.mode ?? null,
    timeSeconds: props.sample.time,
    joint: props.joint,
    channel: channel.value,
    frame: { width: props.image.width, height: props.image.height, aspect: aspect.value },
    points: points.value.map(({ x, y }, i) => ({ label: landmarks[props.joint][i], x, y })),
    angleDeg: measured.value,
    automatic: { rawAngleDeg: raw.value, filteredAngleDeg: filtered.value },
  };
  download(
    new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
    `angle-review-${Math.round(props.sample.time * 1e6)}-${props.joint}-${channel.value}.json`,
  );
}
</script>

<template>
  <section class="angle-review" aria-label="手动角度测量">
    <p class="review-source">
      <strong>{{ label }}</strong>
      <span
        >{{ source }} · {{ sample.time.toFixed(6) }} s（{{ clock }}）{{
          session.synthetic ? ' · 合成素材' : ''
        }}</span
      >
    </p>
    <div class="review-tools">
      <div v-if="joint !== 'spine'" class="review-options" role="group" aria-label="复核侧别">
        <button type="button" :aria-pressed="side === 'left'" @click="side = 'left'">左侧</button>
        <button type="button" :aria-pressed="side === 'right'" @click="side = 'right'">右侧</button>
      </div>
      <div class="review-options" role="group" aria-label="复核画面缩放">
        <button
          v-for="level in zoomLevels"
          :key="level.value"
          type="button"
          :aria-pressed="zoom === level.value"
          @click="changeZoom(level.value)"
        >
          {{ level.label }}
        </button>
      </div>
    </div>
    <div class="review-steps">
      <div class="review-points" role="group" aria-label="复核点位">
        <button
          v-for="(name, index) in instructions"
          :key="name"
          type="button"
          :aria-label="`第 ${index + 1} 点（${name}）`"
          :aria-pressed="activePoint === index"
          :data-set="index < points.length"
          :disabled="index > points.length"
          @click="editPoint(index)"
        >
          <span>{{ index + 1 }}</span
          >{{ name }}
        </button>
      </div>
      <div class="review-progress">
        <p class="review-status" role="status">{{ status }}</p>
        <button v-if="editing !== null" type="button" @click="cancelEdit">取消调整</button>
      </div>
      <p id="review-point-help">选中点位后在画面落点。方向键微调，Enter 确认。</p>
    </div>
    <div
      ref="picture"
      class="review-picture"
      tabindex="0"
      role="region"
      aria-label="可滚动的复核画面"
    >
      <div
        class="review-image"
        :style="{ width: `min(${100 * zoom}%, ${48 * imageAspect * zoom}dvh)` }"
      >
        <canvas
          ref="canvas"
          :width="image.width"
          :height="image.height"
          :data-picking="activePoint !== null"
          tabindex="0"
          aria-label="复核原始画面"
          aria-describedby="review-point-help"
          @click="pickPointer"
          @keydown="moveCursor"
        />
        <div class="review-overlay" aria-hidden="true">
          <i v-for="(segment, i) in segments" :key="i" :style="segment" class="review-segment" />
          <span
            v-for="(point, i) in points"
            :key="i"
            :style="position(point)"
            :data-editing="editing === i"
            class="review-marker"
            >{{ i + 1 }}</span
          >
          <i
            v-if="cursor && activePoint !== null"
            :style="position(cursor)"
            class="review-cursor"
          />
        </div>
      </div>
    </div>
    <div class="review-result">
      <dl class="review-values">
        <div class="review-manual"
          ><dt>手动夹角</dt><dd>{{ degrees(measured) }}</dd></div
        >
        <div
          ><dt>自动原始</dt><dd>{{ degrees(raw) }}</dd></div
        >
        <div
          ><dt>自动滤波</dt><dd>{{ degrees(filtered) }}</dd></div
        >
      </dl>
      <div class="review-actions">
        <el-button :disabled="!draft.history.length" @click="undo">撤销上一步</el-button>
        <el-button :disabled="!points.length" @click="reset">清空点位</el-button>
      </div>
      <el-button
        class="review-download"
        type="primary"
        :disabled="measured === null || editing !== null"
        @click="save"
        >下载复核记录</el-button
      >
    </div>
  </section>
</template>

<style scoped>
.angle-review {
  display: grid;
  grid-template-areas: 'source' 'tools' 'steps' 'picture' 'result';
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@media (min-width: 800px) {
  .angle-review {
    grid-template-areas: 'source source' 'tools steps' 'picture steps' 'picture result';
    grid-template-columns: minmax(0, 1fr) minmax(240px, 280px);
    grid-template-rows: auto auto auto 1fr;
    column-gap: 16px;
  }
}
.angle-review p {
  margin: 0;
}
.review-source {
  grid-area: source;
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
  align-items: baseline;
  overflow-wrap: anywhere;
}
.review-source strong {
  color: var(--ink);
}
.review-source span {
  color: var(--muted);
  font-size: 12px;
}
.review-tools {
  grid-area: tools;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
.review-options {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface-muted);
}
.review-options button,
.review-points button {
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.review-options button[aria-pressed='true'],
.review-points button[aria-pressed='true'] {
  background: var(--surface);
  border-color: var(--accent-mid);
  color: var(--accent-dark);
  font-weight: 600;
}
.review-steps {
  grid-area: steps;
  display: grid;
  gap: 6px;
}
.review-points {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}
.review-points button {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
  border-color: var(--line);
  background: var(--surface-muted);
  overflow-wrap: anywhere;
}
.review-points button span {
  flex: none;
  width: 16px;
  border-radius: 4px;
  background: var(--surface);
  font-variant-numeric: tabular-nums;
}
.review-points button[data-set='true'] span {
  color: var(--accent-dark);
}
.review-points button:disabled {
  opacity: 0.6;
  cursor: default;
}
.review-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}
.review-progress button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent-dark);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.review-status {
  color: var(--ink);
}
#review-point-help {
  color: var(--muted);
  font-size: 12px;
}
.review-picture:focus-visible,
.review-picture canvas:focus-visible,
.review-options button:focus-visible,
.review-points button:focus-visible {
  outline: 2px solid var(--accent-mid);
  outline-offset: -2px;
}
.review-picture {
  grid-area: picture;
  width: 100%;
  max-height: 53dvh;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--surface-muted);
  border-radius: 8px;
}
.review-image {
  position: relative;
  overflow: hidden;
  margin-inline: auto;
}
.review-picture canvas {
  display: block;
  width: 100%;
  height: auto;
}
.review-picture canvas[data-picking='true'] {
  cursor: crosshair;
}
.review-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.review-segment,
.review-marker,
.review-cursor {
  position: absolute;
}
.review-segment {
  height: 2px;
  margin-top: -1px;
  background: #ffe197;
  box-shadow: 0 0 0 1px #10202499;
  transform-origin: left center;
}
.review-marker {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid #102024;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  color: #102024;
  background: #ffe197;
  font-size: 10px;
  font-weight: 700;
}
.review-marker[data-editing='true'] {
  outline: 1px solid #ffe197;
  outline-offset: 3px;
}
.review-cursor {
  width: 23px;
  height: 23px;
  transform: translate(-50%, -50%);
  background:
    linear-gradient(#ffe197, #ffe197) center / 1px 100% no-repeat,
    linear-gradient(#ffe197, #ffe197) center / 100% 1px no-repeat;
  filter: drop-shadow(0 0 1px #102024);
}
.review-result {
  grid-area: result;
  display: grid;
  gap: 9px;
}
.review-values {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  font-size: 12px;
}
.review-values > div {
  padding: 8px 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  text-align: center;
}
.review-values .review-manual {
  background: var(--surface-muted);
}
.review-values dd {
  margin: 2px 0 0;
  color: var(--ink);
  font-size: clamp(15px, 4vw, 22px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.review-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.review-actions .el-button + .el-button {
  margin-left: 0;
}
.review-download {
  justify-self: stretch;
}
</style>
