<script setup lang="ts">
import type { SessionInfo } from '../analysis/session.ts';
import { sourceClock, sourceLabel, sourceTimeSpan } from '../analysis/sourceDisplay.ts';

defineProps<{
  source: SessionInfo;
  evidence: {
    interval: [number, number];
    sampledRange: [number, number] | null;
    sampleCount: number;
    basis: 'raw' | 'filtered';
  };
  segment?: string;
  csv?: boolean;
}>();
</script>

<template>
  <p class="scope-source"
    >{{ sourceLabel(source)
    }}<span v-if="source.source !== 'demo' && source.synthetic"> · 合成素材</span> ·
    {{ sourceClock(source) }}</p
  >
  <p class="scope-samples">
    <strong v-if="segment">{{ segment }} · </strong>
    {{ evidence.interval[0] === evidence.interval[1] ? '请求时刻' : '请求区间' }}
    {{ sourceTimeSpan(evidence.interval) }} · 实际采样
    {{ sourceTimeSpan(evidence.sampledRange) }}（{{ evidence.sampleCount }} 帧） ·
    {{ csv ? 'raw / filtered' : evidence.basis }}
  </p>
</template>

<style scoped>
.scope-source,
.scope-samples {
  overflow-wrap: anywhere;
}
.scope-source {
  font-weight: 600;
}
.scope-samples {
  color: var(--muted);
}
</style>
