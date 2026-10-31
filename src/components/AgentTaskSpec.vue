<script setup lang="ts">
import type { TaskUnderstanding } from '../agent/taskSpec.ts';
defineProps<{ task: TaskUnderstanding }>();
const fields = {
  goalTypes: '目标类型',
  joint: '关节',
  channels: '侧别',
  basis: 'raw / filtered',
  interval: '统计区间 / 比较前段（秒）',
  comparison: '比较后段与差值方向',
  metrics: '所需统计项',
  time: '定位时间（秒）',
  deliveries: '视图 / 报告 / 导出要求',
} as const;
const origins = {
  explicit: '本轮明确要求（模型标注）',
  inherited: '继承参数',
  derived: '模型推导（待审阅）',
};
</script>
<template>
  <details open class="task-spec">
    <summary>任务规格 · 模型理解，已校验结构与来源</summary>
    <p
      >请对照用户原文审阅。此校验不能证明自然语言理解正确；缺失且必要的字段需澄清。更正规格请提交新目标。</p
    >
    <div class="task-table">
      <table>
        <thead
          ><tr><th>字段</th><th>模型理解的值</th><th>来源</th></tr></thead
        >
        <tbody>
          <tr v-for="(label, field) in fields" :key="field">
            <th>{{ label }}</th>
            <td
              ><code>{{
                task.spec[field] === null ? '未指定' : JSON.stringify(task.spec[field])
              }}</code></td
            >
            <td>
              <template
                v-for="source in task.spec.sources.filter(
                  (s) => s.field === field || s.field.startsWith(`${field}.`),
                )"
                :key="source.field"
              >
                <strong v-if="source.field !== field">{{ source.field }} · </strong>
                {{ origins[source.origin] }}<br />「{{ source.text }}」
                <p v-if="source.fromRunId">来源运行：{{ source.fromRunId }}</p>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="task.spec.unresolved.length">需澄清：{{ task.spec.unresolved.join('；') }}</p>
  </details>
</template>
<style scoped>
.task-spec {
  margin: 14px 0;
  font-size: 12px;
  line-height: 1.8;
}
summary {
  cursor: pointer;
}
p {
  color: #667d71;
  overflow-wrap: anywhere;
}
.task-table {
  overflow: auto;
  max-height: 360px;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  padding: 8px;
  border: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th {
  min-width: 100px;
}
code {
  white-space: pre-wrap;
}
</style>
