<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import type { Marker } from '../types';
import { groupMarkers } from '../utils/visualization';
const props = defineProps<{
  markers: Marker[];
  domain: [number, number];
  selection?: [number, number] | null;
}>();
const emit = defineEmits<{ seek: [time: number] }>();
const root = ref<HTMLElement>(),
  width = ref(300),
  opened = ref<number | null>(null);
let observer: ResizeObserver;
const groups = computed(() => groupMarkers(props.markers, props.domain, width.value));
const percent = (time: number) =>
  Math.max(
    0,
    Math.min(100, ((time - props.domain[0]) / (props.domain[1] - props.domain[0] || 1)) * 100),
  );
onMounted(() => {
  observer = new ResizeObserver(() => {
    width.value = root.value?.clientWidth ?? 300;
  });
  observer.observe(root.value!);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div ref="root" class="marker-timeline" aria-label="可定位标记与片段">
    <div class="marker-rail">
      <div
        v-if="selection"
        class="marker-selection"
        :style="{
          left: percent(selection[0]) + '%',
          width: Math.max(0, percent(selection[1]) - percent(selection[0])) + '%',
        }"
      />
      <button
        v-for="(group, index) in groups"
        :key="index"
        class="marker-pin"
        :style="{ left: Math.max(2, Math.min(98, group.position * 100)) + '%' }"
        :title="group.markers.map((m) => `${m.label} · ${m.time.toFixed(2)} s`).join('\n')"
        :aria-label="
          group.markers.length > 1
            ? `${group.markers.length} 个重叠标记，展开选择`
            : `定位 ${group.markers[0]!.label} · ${group.markers[0]!.time.toFixed(2)} s`
        "
        :aria-expanded="group.markers.length > 1 ? opened === index : undefined"
        @click="
          group.markers.length > 1
            ? (opened = opened === index ? null : index)
            : emit('seek', group.markers[0]!.time)
        "
      >
        {{ group.markers.length > 1 ? group.markers.length : '◆' }}
      </button>
    </div>
    <div v-if="opened !== null && groups[opened]?.markers.length" class="marker-choices">
      <button
        v-for="(marker, i) in groups[opened]!.markers"
        :key="i"
        @click="
          emit('seek', marker.time);
          opened = null;
        "
        >{{ marker.label }} · {{ marker.time.toFixed(2) }} s</button
      >
    </div>
    <div v-if="selection" class="marker-clip"
      >当前区间 {{ selection[0].toFixed(2) }}–{{ selection[1].toFixed(2) }} s</div
    >
  </div>
</template>
<style scoped>
.marker-timeline {
  min-width: 0;
  width: 100%;
}
.marker-rail {
  position: relative;
  height: 22px;
  margin: 0 5px;
  border-top: 2px solid #edf2ec;
}
.marker-pin {
  position: absolute;
  top: -8px;
  transform: translateX(-50%);
  background: #edf7f0;
  border: 1px solid #a0c9b6;
  color: #277d65;
  border-radius: 4px;
  min-width: 20px;
  height: 20px;
  padding: 0 3px;
  cursor: pointer;
  font-size: 10px;
}
.marker-pin:focus-visible {
  outline: 2px solid #18977e;
  outline-offset: 2px;
}
.marker-selection {
  position: absolute;
  top: -2px;
  height: 4px;
  background: #e3bd76;
}
.marker-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
}
.marker-choices button {
  background: #f4f8f5;
  color: #397b64;
  border: 1px solid #dce8e0;
  border-radius: 4px;
  padding: 5px 8px;
  cursor: pointer;
}
.marker-clip {
  font-size: 10px;
  color: #83968b;
  padding-bottom: 6px;
}
</style>
