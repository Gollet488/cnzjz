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
        }}<template v-if="call.name === 'get_quality_summary' && result(call).selection">
          · {{ joints[result(call).selection.joint] }}</template
        ><template v-else-if="call.name !== 'get_quality_summary'">
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
      <p v-for="row in result(call).channels" :key="`events-${row.channel}`">
        {{ channel(row.channel) }}角度极值（并列取首个源时间）：
        <template v-for="(event, kind) in row.events" :key="kind">
          <button
            v-if="event"
            :disabled="disabled"
            @click="emit('locate', call, false, [event.time, event.time])"
            >{{ kind === 'minimum' ? '最小' : '最大' }} {{ n(event.value) }} deg ·
            {{ n(event.time, 6) }} s · 定位</button
          >
        </template>
      </p>
    </template>
    <template v-else>
      <template v-if="result(call).selection">
        <p>选中关节角度可用性 · {{ result(call).selection.basis }} · 分母为区间全部已采样帧</p>
        <div class="evidence-table">
          <table>
            <thead
              ><tr
                ><th>侧别</th><th>有效 / 全部</th><th>帧覆盖率</th><th>未检出</th
                ><th>检出但角度无效</th></tr
              ></thead
            >
            <tbody
              ><tr v-for="row in result(call).selection.channels" :key="row.channel">
                <td>{{ channel(row.channel) }}</td
                ><td>{{ row.validSamples }} / {{ evidence(call).sampleCount }}</td>
                <td>{{ n(row.coverage * 100, 1) }}%</td><td>{{ row.notDetectedSamples }}</td
                ><td>{{ row.unusableSamples }}</td>
              </tr></tbody
            >
          </table>
        </div>
        <div v-for="row in result(call).selection.channels" :key="`ranges-${row.channel}`">
          <p>{{ channel(row.channel) }}连续段（按源时间跨度优先；每类最多 5 段）</p>
          <p v-for="group in row.missingIntervals" :key="`missing-${group.interval[0]}`">
            缺失
            <button :disabled="disabled" @click="emit('locate', call, false, group.interval)"
              >{{ interval(group.interval) }} · 定位</button
            >
            · {{ group.samples }} 帧
          </p>
          <p v-if="!row.missingIntervalCount">无选中角度缺失采样。</p>
          <p v-for="group in row.validIntervals" :key="`valid-${group.interval[0]}`">
            有效
            <button :disabled="disabled" @click="emit('locate', call, false, group.interval)"
              >{{ interval(group.interval) }} · 定位</button
            >
            · {{ group.samples }} 帧
          </p>
          <p v-if="row.omittedMissingIntervals || row.omittedValidIntervals"
            >另省略缺失 {{ row.omittedMissingIntervals }} 段、有效
            {{ row.omittedValidIntervals }} 段；缩小查询区间可核对。</p
          >
        </div>
        <p
          >连续段仅连接相邻有效采样；采样间隔大于
          {{ n(result(call).timing.continuityGapSeconds, 6) }} s
          时拆段。帧覆盖率不代表持续时间覆盖、人体精度或同一人物身份追踪。</p
        >
        <p>“检出但角度无效”可含局部置信不足或几何退化，不能仅凭该计数判断遮挡原因。</p>
      </template>
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
      <p v-for="gap in result(call).timing?.gapIntervals ?? []" :key="`gap-${gap.interval[0]}`">
        采样中断
        <button :disabled="disabled" @click="emit('locate', call, false, gap.interval)"
          >{{ interval(gap.interval) }} · 定位</button
        >
        · 间隔 {{ n(gap.seconds, 6) }} s（不证明中间有追踪数据）
      </p>
      <p v-if="result(call).timing?.omittedGapIntervals"
        >另省略 {{ result(call).timing.omittedGapIntervals }} 个采样中断。</p
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
  color: var(--accent);
  font-size: 11px;
}
.evidence-meta,
footer {
  display: block;
  color: var(--muted);
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
  background: var(--surface-muted);
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
  color: var(--accent);
}
.quality-values span {
  color: var(--muted);
}
</style>
