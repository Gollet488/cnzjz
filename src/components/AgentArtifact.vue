<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentRun, CallRecord } from '../agent/runtime';
import type { createToolRegistry } from '../analysis/tools';
import AgentEvidence from './AgentEvidence.vue';
import AgentEvidenceScope from './AgentEvidenceScope.vue';
import { download } from '../utils/download';
const props = defineProps<{
  call: CallRecord;
  run: AgentRun;
  reportedModels: string[];
  stale: boolean;
  tools: ReturnType<typeof createToolRegistry>;
}>();
const emit = defineEmits<{
  export: [handle: string];
  locate: [call: CallRecord, second?: boolean, interval?: [number, number]];
}>();
const error = ref('');
const reportDownloadStarted = ref(false);
const result = computed<any>(() => (props.call.output.ok ? props.call.output.result : null));
const sections = computed<CallRecord[]>(() => {
  if (props.call.name !== 'prepare_report' || !result.value) return [];
  return [
    ['query_metrics', result.value.facts],
    ['compare_intervals', result.value.comparison],
    ['get_quality_summary', result.value.quality],
    ['get_quality_summary', result.value.comparisonQuality],
  ]
    .filter(([, value]) => value)
    .map(([name, value], i) => ({
      id: `${props.call.id}-section-${i}`,
      name: name as string,
      arguments: null,
      output: { ok: true, tool: name as string, result: value },
    }));
});
function save() {
  try {
    const artifact = props.tools.getArtifact(result.value.handle);
    if (artifact.kind === 'csv') emit('export', result.value.handle);
    else {
      const { id, provider, model, startedAt } = props.run;
      const report = {
        ...artifact,
        analysis: {
          runId: id,
          startedAt: new Date(startedAt).toISOString(),
          provider,
          requestedModel: model,
          reportedModels: props.reportedModels,
        },
      };
      download(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }),
        `analysis-report-${artifact.reference.sessionId.slice(0, 8)}-r${artifact.reference.revision}.json`,
      );
      reportDownloadStarted.value = true;
    }
  } catch (e) {
    error.value = String(e);
  }
}
</script>
<template>
  <section v-if="result" class="artifact-card">
    <h3
      >{{ call.name === 'prepare_report' ? '分析报告 · 已准备' : 'CSV · 已准备'
      }}{{ stale ? '（旧版本）' : '' }}</h3
    >
    <AgentEvidenceScope
      :source="run.reference"
      :evidence="result.evidence"
      :segment="result.comparison ? '前段' : undefined"
      :csv="call.name === 'prepare_export'"
    />
    <p>会话 {{ result.evidence.sessionId }} / 版本 {{ result.evidence.revision }}</p>
    <template v-if="call.name === 'prepare_report'">
      <h4>事实 · 本地工具统计</h4>
      <AgentEvidence
        v-for="section in sections"
        :key="section.id"
        :call="section"
        :source="run.reference"
        :disabled="stale"
        @locate="(_, second, interval) => emit('locate', section, second, interval)"
      />
      <h4>区间差异</h4><p v-for="line in result.trends" :key="line">{{ line }}</p> <h4>缺失</h4
      ><p v-for="line in result.missing" :key="line">{{ line }}</p> <h4>限制</h4
      ><p v-for="line in result.limitations" :key="line">{{ line }}</p>
    </template>
    <p v-else
      >{{ result.rows }} 行 / {{ result.columns }} 列 · 含 raw/filtered、参数和采集状态。保存时显示
      CSV 写入或浏览器下载进度。</p
    >
    <el-button :disabled="stale" @click="save">{{
      call.name === 'prepare_report' ? '保存报告 JSON' : '保存 CSV'
    }}</el-button>
    <p v-if="reportDownloadStarted" role="status">已发起报告的浏览器下载。</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.artifact-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 18px;
  margin-top: 14px;
}
h4 {
  margin-top: 18px;
}
p {
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
</style>
