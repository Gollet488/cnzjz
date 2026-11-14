<script setup lang="ts">
import { computed } from 'vue';
import { MAX_FRAMES } from '../config';
import { nearestVideoFrame } from '../video/timeline';
import type { VideoClip } from '../video/protocol';

const props = defineProps<{
  timestamps: Float64Array;
  clip: VideoClip;
  index: number;
  rate: number;
  playing: boolean;
  previewAvailable: boolean;
  locked: boolean;
}>();
const emit = defineEmits<{
  seek: [index: number];
  clip: [clip: VideoClip, index: number];
  rate: [rate: number];
  play: [];
  analyze: [];
}>();
const last = computed(() => props.timestamps.length - 1);
const clipFrames = computed(() => props.clip.end - props.clip.start + 1);
const time = (index: number) => props.timestamps[index] / 1e6;
function setBound(bound: 'start' | 'end', index: number) {
  const other = bound === 'start' ? props.clip.end : props.clip.start;
  const start = bound === 'start' ? index : Math.min(other, index);
  const end = bound === 'end' ? index : Math.max(other, index);
  emit('clip', { start, end }, index);
}
function changeTime(bound: 'start' | 'end', event: Event) {
  const input = event.target as HTMLInputElement;
  if (Number.isFinite(input.valueAsNumber)) {
    const index = nearestVideoFrame(props.timestamps, Math.round(input.valueAsNumber * 1e6));
    setBound(bound, index);
    input.value = time(index).toFixed(6);
  } else {
    input.value = time(props.clip[bound]).toFixed(6);
  }
}
</script>

<template>
  <fieldset class="video-clip-controls" :disabled="locked">
    <legend>视频片段</legend>
    <div class="clip-scrubber">
      <input
        aria-label="源视频帧时间轴"
        type="range"
        min="0"
        :max="last"
        :value="index"
        :aria-valuetext="`第 ${index + 1} 帧，${time(index).toFixed(6)} 秒`"
        @input="emit('seek', ($event.target as HTMLInputElement).valueAsNumber)"
      />
      <output>{{ time(index).toFixed(6) }} s · {{ index + 1 }} / {{ last + 1 }} 帧</output>
    </div>
    <div class="clip-control-row">
      <button :disabled="index === 0" @click="emit('seek', index - 1)">上一帧</button>
      <button :disabled="index === last" @click="emit('seek', index + 1)">下一帧</button>
      <button :disabled="!previewAvailable" @click="emit('play')">{{
        playing ? '暂停预览' : '播放片段'
      }}</button>
      <label>
        预览倍速
        <select
          :value="rate"
          @change="emit('rate', Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="speed in [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]"
            :key="speed"
            :value="speed"
          >
            {{ speed }}×
          </option>
        </select>
      </label>
    </div>
    <div class="clip-control-row">
      <label>
        起点（秒）
        <input
          type="number"
          step="0.000001"
          :min="time(0)"
          :max="time(last)"
          :value="time(clip.start).toFixed(6)"
          @change="changeTime('start', $event)"
        />
      </label>
      <button @click="setBound('start', index)">设为起点</button>
      <label>
        终点（秒）
        <input
          type="number"
          step="0.000001"
          :min="time(0)"
          :max="time(last)"
          :value="time(clip.end).toFixed(6)"
          @change="changeTime('end', $event)"
        />
      </label>
      <button @click="setBound('end', index)">设为终点</button>
    </div>
    <div class="clip-control-row clip-action-row">
      <span
        >{{ clipFrames.toLocaleString() }} 帧 ·
        {{
          clipFrames > MAX_FRAMES ? `均匀采样 ${MAX_FRAMES.toLocaleString()} 帧` : '逐帧分析'
        }}</span
      >
      <button @click="emit('clip', { start: 0, end: last }, 0)">选择全片</button>
      <button class="clip-analyze" @click="emit('analyze')">分析所选范围</button>
    </div>
  </fieldset>
</template>

<style scoped>
.video-clip-controls {
  margin: 12px 18px;
  min-inline-size: 0;
  padding: 8px 12px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
}
.video-clip-controls legend {
  padding-inline: 5px;
  font-weight: 600;
}
.clip-scrubber,
.clip-control-row,
.clip-control-row label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.clip-scrubber,
.clip-control-row {
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.clip-action-row {
  margin-bottom: 0;
}
.clip-scrubber input {
  min-width: 110px;
  flex: 1;
  accent-color: var(--accent-mid);
}
.clip-scrubber output,
.clip-control-row label {
  font-variant-numeric: tabular-nums;
}
.clip-control-row span {
  flex: 1;
}
.clip-control-row input,
.clip-control-row select,
.clip-control-row button {
  min-height: 32px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 3px 8px;
  font: inherit;
}
.clip-control-row select option {
  color: var(--ink);
  background: var(--surface);
}
.clip-control-row input {
  width: 106px;
}
.clip-control-row button:enabled {
  cursor: pointer;
}
.clip-control-row button:disabled,
.clip-control-row input:disabled,
.clip-control-row select:disabled {
  opacity: 0.55;
}
.clip-control-row button:enabled:hover,
.clip-control-row button.clip-analyze {
  background: var(--accent-soft);
  border-color: var(--accent-mid);
}
</style>
