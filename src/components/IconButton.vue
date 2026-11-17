<script setup lang="ts">
defineProps<{ label: string; expandStart?: boolean }>();
</script>

<template>
  <button
    type="button"
    class="icon-button"
    :class="{ 'icon-button--expand-start': expandStart }"
    :aria-label="label"
  >
    <span class="icon-button-icon" aria-hidden="true"><slot /></span>
    <span class="icon-button-label" aria-hidden="true"
      ><span>{{ label }}</span></span
    >
  </button>
</template>

<style scoped>
.icon-button {
  --icon-button-size: 48px;
  --icon-button-reveal: 0fr;
  display: inline-grid;
  grid-template-columns: var(--icon-button-size) minmax(0, var(--icon-button-reveal));
  flex: none;
  align-items: center;
  height: var(--icon-button-size);
  padding: 0;
  border-radius: 999px;
  color: var(--accent-dark);
  background-color: var(--icon-button-background, var(--accent-soft));
  box-shadow: var(--control-edge);
  font-size: 11px;
  font-weight: 600;
  transition:
    grid-template-columns 0.24s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}
.icon-button--expand-start {
  grid-template-columns: minmax(0, var(--icon-button-reveal)) var(--icon-button-size);
}
.icon-button--expand-start .icon-button-icon {
  grid-area: 1 / 2;
}
.icon-button--expand-start .icon-button-label {
  display: flex;
  grid-area: 1 / 1;
  justify-content: flex-end;
}
.icon-button-icon {
  display: grid;
  place-items: center;
}
.icon-button-icon :slotted(svg) {
  width: 18px;
  height: 18px;
}
.icon-button-label {
  overflow: hidden;
  white-space: nowrap;
  opacity: var(--icon-button-label-opacity, 0);
  transition: opacity 0.12s ease;
  transition-delay: var(--icon-button-label-delay, 0ms);
}
.icon-button-label > span {
  padding-inline-end: var(--icon-button-label-padding, 14px);
}
.icon-button--expand-start .icon-button-label > span {
  flex: none;
  padding-inline: var(--icon-button-label-padding, 14px) 0;
}
.icon-button:focus-visible {
  --icon-button-reveal: var(--icon-button-focus-reveal, 1fr);
  --icon-button-label-opacity: var(--icon-button-focus-opacity, 1);
  --icon-button-label-delay: 80ms;
  background-color: var(--accent-soft);
  box-shadow: var(--control-hover-edge);
}
@media (hover: hover) {
  .icon-button:enabled:hover {
    --icon-button-reveal: 1fr;
    --icon-button-label-opacity: 1;
    --icon-button-label-delay: 80ms;
    background-color: var(--accent-soft);
    box-shadow: var(--control-hover-edge);
  }
}
.icon-button:enabled:active {
  box-shadow:
    var(--control-hover-edge),
    inset 0 2px 4px var(--shadow-soft);
}
</style>
