<script setup lang="ts">
defineProps<{ value: string }>();
</script>

<template>
  <span class="rolling-number">
    <span class="rolling-text">{{ value }}</span>
    <span class="rolling-glyphs" aria-hidden="true">
      <span
        v-for="(character, index) in value"
        :key="index - value.length"
        :class="/[0-9]/.test(character) ? 'rolling-digit' : 'rolling-symbol'"
        :style="{ '--digit': character }"
        :data-character="character"
      />
    </span>
  </span>
</template>

<style scoped>
.rolling-number {
  position: relative;
  display: inline-flex;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.rolling-text {
  position: absolute;
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
  overflow: hidden;
}
.rolling-glyphs {
  display: inline-flex;
  align-items: center;
  line-height: 1.2;
}
.rolling-digit {
  display: inline-block;
  width: 1ch;
  height: 1.2em;
  overflow: hidden;
  text-align: center;
}
.rolling-digit::before {
  display: block;
  content: '0\a 1\a 2\a 3\a 4\a 5\a 6\a 7\a 8\a 9';
  white-space: pre;
  transform: translateY(calc(var(--digit) * -1.2em));
  transition: transform 130ms cubic-bezier(0.2, 0.65, 0.3, 1);
}
.rolling-symbol::before {
  content: attr(data-character);
}
</style>
