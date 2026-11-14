<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <button type="button" class="icon-button" :aria-label="label">
    <span class="icon-button-icon" aria-hidden="true"><slot /></span>
    <span class="icon-button-label" aria-hidden="true"
      ><span>{{ label }}</span></span
    >
  </button>
</template>

<style scoped>
.icon-button {
  --icon-button-size: 48px;
  display: inline-grid;
  grid-template-columns: var(--icon-button-size) minmax(0, 0fr);
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
  opacity: 0;
  transition: opacity 0.12s ease;
}
.icon-button-label > span {
  padding-inline-end: 14px;
}
.icon-button:focus-visible {
  grid-template-columns: var(--icon-button-size) minmax(0, 1fr);
  background-color: var(--accent-soft);
  box-shadow: var(--control-hover-edge);
}
.icon-button:focus-visible .icon-button-label {
  opacity: 1;
  transition-delay: 80ms;
}
@media (hover: hover) {
  .icon-button:enabled:hover {
    grid-template-columns: var(--icon-button-size) minmax(0, 1fr);
    background-color: var(--accent-soft);
    box-shadow: var(--control-hover-edge);
  }
  .icon-button:enabled:hover .icon-button-label {
    opacity: 1;
    transition-delay: 80ms;
  }
}
.icon-button:enabled:active {
  box-shadow:
    var(--control-hover-edge),
    inset 0 2px 4px var(--shadow-soft);
}
</style>
