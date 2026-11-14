<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps<{
  id?: string;
  label: string;
  error?: string;
  invalid?: boolean;
  describedBy?: string;
  validationAttempt?: number;
}>();
const generatedId = useId();
const id = computed(() => props.id ?? `field-${generatedId}`);
const errorId = computed(() => `${id.value}-error`);
const invalid = computed(() => Boolean(props.error || props.invalid));
const control = computed(() => ({
  id: id.value,
  placeholder: ' ',
  'aria-invalid': invalid.value ? ('true' as const) : undefined,
  'aria-describedby':
    [props.describedBy, props.error && errorId.value].filter(Boolean).join(' ') || undefined,
}));
const box = ref<HTMLElement>();
let shake: Animation | undefined;

watch(
  [invalid, () => props.validationAttempt],
  ([failed]) => {
    shake?.cancel();
    if (!failed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shake = box.value?.animate(
      [0, -5, 5, -4, 4, -2, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 360, easing: 'ease-out' },
    );
  },
  { flush: 'post' },
);
onBeforeUnmount(() => shake?.cancel());
</script>

<template>
  <div class="floating-field">
    <div ref="box" class="floating-field-box">
      <slot :control="control" />
      <label :for="id" class="floating-field-label">{{ label }}</label>
    </div>
    <Transition name="field-error">
      <div v-if="error" :id="errorId" class="field-error-message" role="status">{{ error }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.floating-field {
  display: grid;
  gap: 4px;
  min-inline-size: 0;
}
.floating-field-box {
  position: relative;
  min-inline-size: 0;
}
.floating-field-box > :slotted(:is(input, textarea)) {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 43px;
  padding: 18px 11px 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--control-radius);
  background: var(--surface);
  box-shadow: inset 0 1px 2px var(--shadow-soft);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}
.floating-field-box > :slotted(textarea) {
  resize: vertical;
}
@media (hover: hover) {
  .floating-field-box
    > :slotted(:is(input, textarea):enabled:hover:not(:focus, [aria-invalid='true'])) {
    border-color: var(--accent-mid);
  }
}
.floating-field-box > :slotted(:focus) {
  border-color: var(--accent);
  outline: 2px solid transparent;
  box-shadow: 0 0 0 2px var(--focus-halo);
}
.floating-field-box > :slotted(:disabled) {
  background: var(--surface-muted);
}
.floating-field-box > :slotted([aria-invalid='true']) {
  border-color: var(--field-danger);
}
.floating-field-box > :slotted([aria-invalid='true']:focus) {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--field-danger) 15%, transparent);
}
.floating-field-label {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 12px;
  width: max-content;
  max-width: calc(100% - 24px);
  overflow: hidden;
  color: var(--muted);
  font-size: 13px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
  transform: translateY(13px);
  transform-origin: left top;
  transition:
    transform 170ms ease,
    color 150ms ease;
}
.floating-field-box > :slotted(:is(:focus, :not(:placeholder-shown))) + .floating-field-label {
  transform: translateY(3px) scale(0.84);
}
.floating-field-box > :slotted(:focus) + .floating-field-label {
  color: var(--accent-dark);
}
.floating-field-box > :slotted([aria-invalid='true']) + .floating-field-label {
  color: var(--field-danger);
}
</style>
