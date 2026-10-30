<script setup lang="ts">
import type { CallRecord } from '../agent/runtime.ts';
defineProps<{ call: CallRecord; disabled?: boolean }>();
const emit = defineEmits<{
  locate: [call: CallRecord, second?: boolean, interval?: [number, number]];
}>();
const result = (call: CallRecord): any => (call.output.ok ? call.output.result : null);
const metric = (call: CallRecord): any =>
  call.name === 'compare_intervals' ? result(call).first : result(call);
const evidence = (call: CallRecord): any =>
  call.name === 'compare_intervals' ? result(call).first.evidence : result(call).evidence;
const n = (value: number | null, digits = 3) =>
  value === null ? '缺失' : Number(value.toFixed(digits)).toString();
const interval = (v: number[]) => `${n(v[0])}–${n(v[1])} s`;
const channel = (s: string) => ({ left: '左侧', right: '右侧', midline: '中线' })[s] ?? s;
const joints: Record<string, string> = {
  knee: '膝',
  hip: '髋',
  shoulder: '肩',
  elbow: '肘',
  ankle: '踝',
  wrist: '腕',
  spine: '脊柱',
};
</script>

<template>
  <article v-if="call.output.ok && evidence(call)" class="evidence-card">
    <header>
      <strong
        >{{
          call.name === 'compare_intervals'
            ? '区间比较'
            : call.name === 'query_metrics'
              ? '指标查询'
              : '采样质量'
        }}<template v-if="call.name !== 'get_quality_summary'">
          · {{ joints[metric(call).joint] }}</template
        ></strong
      >
      <span>{{ evidence(call).synthetic ? 'SYNTHETIC · 合成数据' : '本地采集数据' }}</span>
    </header>
    <p class="evidence-meta"
      >{{ call.id }} · {{ evidence(call).basis }} · {{ interval(evidence(call).interval) }} ·
      {{ evidence(call).sampleCount }} 个采样 · 实际采样范围
      {{ interval(evidence(call).sampledRange) }}</p
    >
    <el-button size="small" :disabled="disabled" @click="emit('locate', call)"
      >定位图表 / 区间起点</el-button
    >
    <el-button
      v-if="call.name === 'compare_intervals'"
      size="small"
      :disabled="disabled"
      @click="emit('locate', call, true)"
      >定位后段</el-button
    >
    <template v-if="call.name === 'compare_intervals'">
      <p
        >第二段 {{ interval(result(call).second.evidence.interval) }} ·
        {{ result(call).second.evidence.sampleCount }} 个采样 · 实际采样范围
        {{ interval(result(call).second.evidence.sampledRange) }}；差值 = 第二段 − 第一段</p
      >
      <div class="evidence-table"
        ><table
          ><thead
            ><tr
              ><th>侧别</th><th>前段 ROM · deg</th><th>后段 ROM · deg</th><th>差值 · deg</th
              ><th>有效角度样本 前 / 后</th><th>覆盖率 前 / 后</th></tr
            ></thead
          >
          <tbody
            ><tr v-for="(row, i) in result(call).first.channels" :key="row.channel">
              <td>{{ channel(row.channel) }}</td
              ><td>{{ n(row.rom) }}</td
              ><td>{{ n(result(call).second.channels[i].rom) }}</td
              ><td>{{ n(result(call).differences[i].rom) }}</td>
              <td
                >{{ row.angle.sampleCount }} /
                {{ result(call).second.channels[i].angle.sampleCount }}</td
              ><td
                >{{ n(row.coverage * 100, 1) }}% /
                {{ n(result(call).second.channels[i].coverage * 100, 1) }}%</td
              >
            </tr></tbody
          ></table
        ></div
      >
      <p class="evidence-limit">{{
        result(call).comparable
          ? '满足本地样本可比条件；不保证动作阶段、视角等价或统计显著性。'
          : `可比性不足：${result(call).reasons.join('；')}`
      }}</p>
    </template>
    <template v-else-if="call.name === 'query_metrics'">
      <div class="evidence-table"
        ><table
          ><thead
            ><tr
              ><th>侧别</th><th>ROM · deg</th><th>均值 · deg</th><th>角度方差 · deg²</th
              ><th>速度绝对峰值 · deg/s</th><th>有效角度 / 速度样本</th><th>覆盖率</th></tr
            ></thead
          >
          <tbody
            ><tr v-for="row in result(call).channels" :key="row.channel"
              ><td>{{ channel(row.channel) }}</td
              ><td>{{ n(row.rom) }}</td
              ><td>{{ n(row.angle.mean) }}</td
              ><td>{{ n(row.angle.populationVariance) }}</td
              ><td>{{ n(row.peakAbsoluteVelocity) }}</td
              ><td>{{ row.angle.sampleCount }} / {{ row.velocity.sampleCount }}</td
              ><td>{{ n(row.coverage * 100, 1) }}%</td></tr
            ></tbody
          ></table
        ></div
      >
      <p
        >坐标窗口方差均值
        {{ n(result(call).coordinateVariance.windows.mean, 8) }} normalized_coordinate² ·
        {{ result(call).coordinateVariance.windows.sampleCount }} 个有效窗口</p
      >
    </template>
    <template v-else>
      <div class="quality-values"
        ><div
          ><b>{{ n(result(call).effectiveRate * 100, 1) }}%</b><span>全点可靠采样率</span></div
        ><div
          ><b>{{ result(call).missingSamples }}</b
          ><span>未检测采样</span></div
        ><div
          ><b>{{ n(result(call).maxSampleGapSeconds) }} s</b><span>最大采样间隔</span></div
        ></div
      >
      <p
        >{{ result(call).detectedSamples }} 个检测采样 ·
        {{ result(call).fullyReliableSamples }} 个全点可靠采样 · 平均置信度
        {{ n(result(call).meanConfidence) }}</p
      >
      <div v-if="result(call).lowConfidenceIntervals.length" class="evidence-table"
        ><table
          ><thead
            ><tr><th>低置信 / 缺失区间</th><th>采样数</th></tr></thead
          ><tbody
            ><tr v-for="(group, i) in result(call).lowConfidenceIntervals" :key="i"
              ><td
                ><button :disabled="disabled" @click="emit('locate', call, false, group.interval)"
                  >{{ interval(group.interval) }} · 定位</button
                ></td
              ><td>{{ group.samples }}</td></tr
            ></tbody
          ></table
        ></div
      >
      <p v-else>查询区间内没有全点低置信或缺失的采样段。</p>
      <p v-if="result(call).omittedIntervals"
        >另有 {{ result(call).omittedIntervals }} 段未展示。</p
      >
    </template>
    <footer>
      <p
        >session {{ evidence(call).sessionId }} / revision {{ evidence(call).revision }} · threshold
        {{ evidence(call).parameters.threshold }} · window {{ evidence(call).parameters.window }} 帧
        · aspect {{ n(evidence(call).parameters.aspect) }} · metric
        {{ evidence(call).parameters.metricVersion }}</p
      >
      <p v-for="line in evidence(call).limitations" :key="line">{{ line }}</p>
    </footer>
  </article>
</template>

<style scoped>
.evidence-card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 18px;
  background: #fff;
  margin-top: 12px;
  font-size: 12px;
  line-height: 1.8;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
header strong {
  font-size: 15px;
}
header span {
  color: var(--green);
  font-size: 11px;
}
.evidence-meta,
footer {
  display: block;
  color: #73857c;
  overflow-wrap: anywhere;
}
.evidence-table {
  overflow-x: auto;
  margin: 12px 0;
  max-height: 300px;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  white-space: nowrap;
}
th,
td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
th {
  background: #f4f8f6;
  font-weight: 500;
}
footer {
  border-top: 1px solid var(--line);
  margin-top: 12px;
  padding: 10px 0 0;
  font-size: 11px;
}
.evidence-limit {
  color: #846524;
}
.quality-values {
  display: flex;
  gap: 32px;
  margin: 16px 0;
  flex-wrap: wrap;
}
.quality-values b {
  display: block;
  font-size: 23px;
  color: var(--green);
}
.quality-values span {
  color: #73857c;
}
</style>
