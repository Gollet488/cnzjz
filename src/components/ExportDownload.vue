<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, Download, FileImage, FileSpreadsheet } from 'lucide-vue-next';

const props = defineProps<{
  format: 'CSV' | 'PNG';
  state: 'idle' | 'writing' | 'completed' | 'cancelled' | 'failed';
  percent?: number;
  message: string;
  frameCount: number;
  label: string;
}>();
const emit = defineEmits<{ download: []; cancel: [] }>();
const phase = ref<'idle' | 'gathering' | 'progress' | 'success'>('idle');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const percent = computed(() => (props.state === 'completed' ? 100 : props.percent));
const locked = computed(
  () => props.state === 'writing' || (props.format === 'CSV' && phase.value !== 'idle'),
);
const fileDescription = computed(() => (props.format === 'CSV' ? 'UTF-8 CSV' : 'PNG 图片'));
const feedback = computed(() => {
  if (phase.value === 'success' || props.state === 'writing') return props.message;
  if (props.state === 'failed' || props.state === 'cancelled') return props.message;
  if (phase.value !== 'idle') return '正在完成导出…';
  return '';
});

watch(
  () => props.state,
  (state) => {
    if (state === 'writing') phase.value = reducedMotion.matches ? 'progress' : 'gathering';
    else if (state !== 'completed') phase.value = 'idle';
  },
  { immediate: true },
);
watch(
  phase,
  (value, _, onCleanup) => {
    if (value === 'progress' || value === 'idle') return;
    const timer = setTimeout(
      () => (phase.value = value === 'gathering' ? 'progress' : 'idle'),
      value === 'gathering' ? 420 : 1200,
    );
    onCleanup(() => clearTimeout(timer));
  },
  { immediate: true },
);
watch([phase, () => props.state], ([current, state], _, onCleanup) => {
  if (current !== 'progress' || state !== 'completed') return;
  const timer = setTimeout(() => (phase.value = 'success'), reducedMotion.matches ? 0 : 460);
  onCleanup(() => clearTimeout(timer));
});
</script>

<template>
  <div class="export-download" :data-format="format" :data-phase="phase">
    <div class="download-well">
      <div class="download-visual">
        <div class="download-slot" aria-hidden="true" />
        <div class="download-sheets" aria-hidden="true">
          <span class="download-sheet sheet-left"><i /><i /><i /></span>
          <span class="download-sheet sheet-right"><i /><i /><i /></span>
          <span class="download-sheet sheet-front">
            <component :is="format === 'CSV' ? FileSpreadsheet : FileImage" :size="21" />
            <b>{{ format }}</b>
          </span>
        </div>
        <div class="download-meter" :aria-hidden="phase !== 'progress'">
          <span class="download-percent" aria-hidden="true">{{
            percent === undefined ? '生成中' : `${percent}%`
          }}</span>
          <div
            class="download-track"
            role="progressbar"
            :class="{ 'is-indeterminate': percent === undefined }"
            :aria-label="`${format} 导出进度`"
            :aria-valuenow="percent"
          >
            <span :style="{ '--fill': phase === 'progress' ? (percent ?? 0) / 100 : 0 }" />
          </div>
        </div>
        <span class="download-check" aria-hidden="true"
          ><Check :size="25" :stroke-width="2.5"
        /></span>
      </div>
      <div class="download-controls">
        <button
          class="download-trigger"
          type="button"
          :disabled="!frameCount"
          :aria-disabled="locked || undefined"
          @click="!locked && emit('download')"
          ><Download :size="16" aria-hidden="true" />{{ label }}</button
        >
        <span class="download-meta"
          >{{ frameCount.toLocaleString() }} 帧 · {{ fileDescription }}</span
        >
      </div>
    </div>
    <div class="download-feedback">
      <p role="status" :class="{ 'download-error': state === 'failed' }">{{ feedback }}</p>
      <button v-if="format === 'CSV' && state === 'writing'" type="button" @click="emit('cancel')"
        >取消导出</button
      >
    </div>
  </div>
</template>

<style scoped>
.export-download {
  min-width: 0;
}
.download-well {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr));
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: linear-gradient(145deg, var(--page-edge), var(--surface-muted));
  box-shadow:
    inset 5px 6px 13px var(--shadow-soft),
    inset -5px -5px 12px var(--surface);
}
.download-visual {
  position: relative;
  display: grid;
  place-items: center;
  isolation: isolate;
  min-height: 104px;
}
.download-slot {
  position: absolute;
  bottom: 15px;
  width: 83px;
  height: 10px;
  border: 1px solid var(--stage-line);
  border-radius: 999px;
  background: var(--stage-button);
  box-shadow:
    inset 0 3px 5px var(--shadow-deep),
    0 2px 1px var(--surface);
  transition: opacity 0.19s ease;
}
.download-sheets {
  position: absolute;
  inset: 0 0 20px;
  display: grid;
  place-items: end center;
  overflow: clip;
}
.download-sheet {
  grid-area: 1 / 1;
  width: 43px;
  height: 57px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--surface);
  border-radius: 7px 11px 5px 5px;
  box-shadow: 2px 3px 7px var(--shadow-deep);
  color: var(--accent-dark);
  transform: var(--rest);
  transition:
    transform 0.44s var(--control-spring) var(--return-delay),
    opacity 0.18s ease var(--return-delay);
}
.sheet-left {
  --rest: translate(-22px, -5px) rotate(-17deg);
  --gather-delay: 0.16s;
  --return-delay: 0ms;
  background: linear-gradient(145deg, var(--surface-muted), var(--accent-line));
}
.sheet-right {
  --rest: translate(22px, -8px) rotate(18deg);
  --gather-delay: 80ms;
  --return-delay: 50ms;
  background: linear-gradient(145deg, var(--surface), var(--page-edge));
}
.sheet-front {
  --rest: translateY(-4px);
  --gather-delay: 0ms;
  --return-delay: 0.1s;
  background: linear-gradient(145deg, var(--surface-raised), var(--surface-muted));
}
.download-sheet i {
  width: 18px;
  height: 2px;
  border-radius: 2px;
  background: var(--line-strong);
}
.download-sheet b {
  font-size: 9px;
  letter-spacing: 0.09em;
}
.export-download:not([data-phase='idle']) .download-sheet {
  opacity: 0;
  transform: translateY(39px) scale(0.65);
  transition:
    transform 245ms cubic-bezier(0.46, 0.05, 0.85, 0.44) var(--gather-delay),
    opacity 0.16s ease-in calc(var(--gather-delay) + 85ms);
}
.export-download:is([data-phase='progress'], [data-phase='success']) .download-slot {
  opacity: 0;
}
.download-meter {
  display: grid;
  justify-items: center;
  gap: 7px;
  width: min(108px, 88%);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.download-percent {
  color: var(--accent-dark);
  font-size: 17px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.download-track {
  width: 100%;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line);
  box-shadow:
    inset 1px 2px 3px var(--shadow-deep),
    0 1px 1px var(--highlight);
  transform: scaleX(0.24);
  transition: transform 0.23s var(--control-spring);
}
.download-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent-mid), var(--action));
  transform: scaleX(var(--fill));
  transform-origin: left;
  transition: transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.export-download[data-phase='progress'] .download-meter {
  opacity: 1;
}
.export-download[data-phase='progress'] .download-track {
  transform: scaleX(1);
}
.download-track.is-indeterminate span {
  width: 40%;
  transform: translateX(-100%);
  animation: download-flow 1.2s ease-in-out infinite;
}
@keyframes download-flow {
  to {
    transform: translateX(250%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .download-track.is-indeterminate span {
    transform: none;
  }
}
.download-check {
  position: absolute;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border: 1px solid var(--surface);
  border-radius: 50%;
  color: var(--success);
  background: linear-gradient(145deg, var(--surface), var(--success-soft));
  box-shadow:
    3px 4px 8px var(--shadow-deep),
    -3px -3px 7px var(--surface);
  opacity: 0;
  transform: scale(0.68);
  transition:
    opacity 0.18s ease,
    transform 0.42s var(--control-spring);
}
.export-download[data-phase='success'] .download-check {
  opacity: 1;
  transform: scale(1);
}
.download-controls {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 5px 0 7px;
}
.download-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--accent-line);
  border-radius: 10px;
  color: var(--action-ink);
  background: linear-gradient(150deg, var(--action-hover), var(--action));
  box-shadow:
    2px 4px 8px var(--shadow-deep),
    inset 0 1px 1px var(--highlight);
  font-size: 12px;
  font-weight: 650;
  transition:
    transform var(--control-release) var(--control-spring),
    box-shadow 0.15s ease;
}
.download-trigger:not(:disabled, [aria-disabled='true']):hover {
  background: var(--action-hover);
}
.download-trigger:not(:disabled, [aria-disabled='true']):active,
.download-trigger[aria-disabled='true'] {
  transform: translateY(1px) scale(0.97);
  box-shadow: inset 1px 2px 5px var(--shadow-deep);
}
.download-trigger[aria-disabled='true'] {
  cursor: wait;
}
.download-trigger svg {
  flex-shrink: 0;
}
.download-meta,
.download-feedback {
  color: var(--muted);
  font-size: 11px;
}
.download-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
  gap: 2px 8px;
  padding: 3px 2px 0;
  line-height: 1.5;
}
.download-feedback p {
  flex: 1 1 170px;
}
.download-feedback .download-error {
  color: var(--field-danger);
}
.download-feedback button {
  min-height: 28px;
  margin-left: auto;
  padding: 0 4px;
  color: var(--accent-dark);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
