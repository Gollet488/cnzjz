<script setup lang="ts">
import { computed } from 'vue';
import { LoaderCircle, Pause, Play } from 'lucide-vue-next';
import RollingNumber from './RollingNumber.vue';

const props = withDefaults(
  defineProps<{
    playing: boolean;
    busy: boolean;
    disabled?: boolean;
    time: number;
    progress: number | null;
    label?: string;
    toggleLabel?: string;
    progressLabel?: string;
  }>(),
  { label: '采集播放器', progressLabel: '本地视频分析进度' },
);
const emit = defineEmits<{ toggle: [] }>();
const clock = computed(() => {
  const centiseconds = Math.round(props.time * 100);
  const minutes = String(Math.floor(centiseconds / 6000)).padStart(2, '0');
  const seconds = String(Math.floor(centiseconds / 100) % 60).padStart(2, '0');
  return `${minutes}:${seconds}.${String(centiseconds % 100).padStart(2, '0')}`;
});
const peaks = [
  0.31, 0.47, 0.69, 0.53, 0.82, 0.67, 1, 0.76, 0.93, 0.61, 0.78, 0.49, 0.59, 0.4, 0.29,
];
</script>

<template>
  <div class="playback" :class="{ 'is-playing': playing }" role="group" :aria-label="label">
    <button
      type="button"
      class="playback-toggle button-glow"
      :disabled="busy || disabled"
      :aria-busy="busy"
      @click="emit('toggle')"
    >
      <component
        :is="busy ? LoaderCircle : playing ? Pause : Play"
        :size="16"
        :class="{ spin: busy }"
        :fill="busy ? 'none' : 'currentColor'"
        aria-hidden="true"
      />
      <span>{{ toggleLabel ?? (playing ? '暂停分析' : '开始分析') }}</span>
    </button>
    <div class="playback-meter">
      <div class="playback-display">
        <div class="playback-spectrum" aria-hidden="true">
          <span
            v-for="(peak, index) in peaks"
            :key="index"
            :style="{
              '--peak': peak,
              '--bar-period': `${510 + (index % 5) * 93}ms`,
              '--bar-delay': `${-index * 109}ms`,
            }"
          />
        </div>
        <span class="playback-time"><RollingNumber :value="clock" /></span>
      </div>
      <div
        class="playback-progress"
        :class="{ 'is-indeterminate': progress === null }"
        :role="progress === null ? undefined : 'progressbar'"
        :aria-hidden="progress === null ? 'true' : undefined"
        :aria-label="progress === null ? undefined : progressLabel"
        :aria-valuenow="progress === null ? undefined : Math.round(progress * 100)"
        ><span :style="{ '--progress': progress ?? 0 }"
      /></div>
    </div>
  </div>
</template>

<style scoped>
.playback {
  --playback-surface: var(--surface-muted);
  display: flex;
  align-items: center;
  gap: clamp(14px, 3vw, 24px);
  padding: 12px 16px;
  border: 1px solid var(--surface);
  border-radius: 14px;
  background: var(--playback-surface);
  box-shadow:
    3px 4px 9px var(--shadow-soft),
    -3px -4px 9px var(--highlight);
}
.playback-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  flex-shrink: 0;
  padding: 0 13px;
  min-height: 40px;
  border: 1px solid var(--surface);
  border-radius: 999px;
  color: var(--accent-dark);
  background: linear-gradient(145deg, var(--surface), var(--page-edge));
  box-shadow:
    3px 4px 7px var(--shadow-deep),
    -3px -4px 8px var(--highlight);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
  transition:
    scale var(--control-release) var(--control-spring),
    box-shadow 0.15s ease;
}
.playback-toggle:hover:enabled {
  color: var(--accent);
  background: var(--accent-soft);
}
.playback-toggle:active:enabled {
  scale: 0.97;
  box-shadow:
    inset 2px 2px 5px var(--shadow-deep),
    inset -2px -2px 5px var(--highlight);
}
.playback-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.playback-toggle:disabled {
  cursor: default;
  opacity: 0.68;
}
.playback-toggle[aria-busy='true'] {
  cursor: progress;
}
.playback-meter {
  flex: 1;
  min-width: 0;
}
.playback-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 26px;
}
.playback-spectrum {
  display: flex;
  align-items: center;
  gap: clamp(2px, 0.45vw, 4px);
  height: 22px;
  max-width: 100%;
  opacity: 0.48;
  transform: scaleY(0.16);
  transition:
    transform 0.24s cubic-bezier(0.22, 0.7, 0.3, 1),
    opacity 0.2s ease;
}
.is-playing .playback-spectrum {
  opacity: 1;
  transform: scaleY(1);
}
.playback-spectrum span {
  width: clamp(2px, 0.42vw, 4px);
  height: calc(22px * var(--peak));
  border-radius: 999px;
  background: linear-gradient(180deg, var(--action), var(--accent-mid));
  animation: playback-beat var(--bar-period) var(--bar-delay) ease-in-out infinite alternate paused;
}
.is-playing .playback-spectrum span {
  animation-play-state: running;
}
@keyframes playback-beat {
  0% {
    transform: scaleY(0.35);
  }
  to {
    transform: scaleY(1);
  }
}
.playback-time {
  margin-left: auto;
  color: var(--accent-dark);
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.playback-progress {
  height: 5px;
  margin-top: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line);
  box-shadow: inset 1px 1px 3px var(--shadow-soft);
}
.playback-progress span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent-mid), var(--action));
  transform: scaleX(var(--progress));
  transform-origin: left;
  transition: transform 0.14s linear;
}
.playback-progress.is-indeterminate span {
  width: 35%;
  background: linear-gradient(90deg, transparent, var(--accent-mid), var(--action), transparent);
  opacity: 0;
  animation: playback-flow 2.4s linear infinite paused;
  transition: opacity 0.2s ease;
}
.is-playing .playback-progress.is-indeterminate span {
  opacity: 1;
  animation-play-state: running;
}
@keyframes playback-flow {
  0% {
    transform: translate(-100%);
  }
  to {
    transform: translate(290%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .is-playing .playback-progress.is-indeterminate span {
    width: 100%;
    transform: none;
  }
}
@media (max-width: 480px) {
  .playback {
    padding: 10px;
    gap: 12px;
  }
  .playback-display {
    flex-wrap: wrap;
    column-gap: 5px;
    row-gap: 0;
  }
}
</style>
