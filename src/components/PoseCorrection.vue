<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { JOINTS } from '../config';
import { angleValue } from '../utils/poseMath';
import { compareTarget, confirmCorrection } from '../utils/poseCorrection';
import type { LiveCorrection } from '../utils/poseCorrection';
import type { Joint, PoseFrame, Side } from '../types';

const props = defineProps<{
  frame?: PoseFrame;
  live: boolean;
  camera: Readonly<{ frame?: PoseFrame }>;
}>();
interface Rule {
  id: number;
  joint: Joint;
  side: Side;
  lower: number | '';
  upper: number | '';
}

let nextId = 0;
function newRule(): Rule {
  return { id: ++nextId, joint: 'knee', side: 'left', lower: '', upper: '' };
}

const rules = ref([newRule()]);
function clearTarget(rule: Rule) {
  rule.lower = '';
  rule.upper = '';
}
function deleteRule(index: number) {
  if (rules.value.length === 1) rules.value = [newRule()];
  else rules.value.splice(index, 1);
}

function readTarget({ lower, upper }: Rule) {
  if (lower === '' || upper === '') return { status: 'unset' } as const;
  if (
    !Number.isInteger(lower) ||
    !Number.isInteger(upper) ||
    lower < 0 ||
    upper > 180 ||
    lower > upper
  )
    return { status: 'invalid' } as const;
  return { status: 'valid', lower, upper } as const;
}

const frame = computed(() => (props.live ? props.camera.frame : props.frame));
const readings = computed(() =>
  rules.value.map((rule) => {
    const channel = rule.joint === 'spine' ? 'midline' : rule.side;
    const jointLabel = JOINTS.find((joint) => joint.key === rule.joint)!.label;
    const label =
      channel === 'midline'
        ? `${jointLabel}中线`
        : `${channel === 'left' ? '左侧' : '右侧'}${jointLabel}`;
    const angle = frame.value ? angleValue(frame.value.angles, rule.joint, channel) : null;
    const target = readTarget(rule);
    const measured =
      target.status === 'valid' && angle !== null
        ? compareTarget(angle, target.lower, target.upper)
        : null;
    return { rule, label, angle, target, measured };
  }),
);

const liveStates = shallowRef(new Map<number, LiveCorrection>());
watch(
  [() => props.live, rules],
  () => {
    liveStates.value = new Map();
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => props.camera.frame,
  (sample) => {
    if (!props.live || !sample) return;
    const next = new Map<number, LiveCorrection>();
    for (const { rule, target, measured } of readings.value) {
      if (target.status !== 'valid') continue;
      next.set(rule.id, confirmCorrection(liveStates.value.get(rule.id), measured, sample.time));
    }
    liveStates.value = next;
  },
  { flush: 'sync' },
);

const titles = {
  unset: '待设置目标',
  invalid: '目标范围无效',
  waiting: '等待采样',
  unavailable: '当前夹角不可用',
  pending: '等待读数稳定',
  below: '夹角偏小',
  above: '夹角偏大',
  within: '夹角在目标范围内',
};
type FeedbackStatus = keyof typeof titles;
const hints: Partial<Record<FeedbackStatus, string>> = {
  unset: '填写目标下限和上限后开始提示。',
  invalid: '请输入 0–180° 的整数，且下限不得超过上限。',
  waiting: '开始分析后查看该关节的夹角。',
  unavailable: '请让相关关节清晰入镜，或回看其他时刻。',
};

const feedback = computed(() =>
  readings.value.map((reading) => {
    const { rule, target, measured } = reading;
    const settled =
      measured && props.live ? (liveStates.value.get(rule.id)?.confirmed ?? null) : measured;
    let status: FeedbackStatus = target.status === 'valid' ? 'waiting' : target.status;
    if (target.status === 'valid' && frame.value) {
      if (!measured) status = 'unavailable';
      else status = settled?.status ?? 'pending';
    }
    const distance = settled?.distance.toFixed(1);
    const adjustment = settled?.status === 'below' || settled?.status === 'above';
    let hint = hints[status] ?? '读数变化，等待确认。';
    if (settled?.status === 'below') hint = `低于下限 ${distance}°，尝试增大夹角。`;
    if (settled?.status === 'above') hint = `高于上限 ${distance}°，尝试减小夹角。`;
    if (settled?.status === 'within') hint = `距最近边界 ${distance}°。`;
    return {
      ...reading,
      title: titles[status],
      hint,
      previous: settled && measured && settled.status !== measured.status,
      tone: adjustment ? 'adjust' : settled?.status,
      deviation: adjustment ? settled.distance : 0,
    };
  }),
);
const priority = computed(() => {
  let largest = 0;
  let id: number | undefined;
  for (const entry of feedback.value) {
    if (entry.deviation <= largest) continue;
    largest = entry.deviation;
    id = entry.rule.id;
  }
  return id;
});
</script>

<template>
  <section class="panel correction-panel" aria-labelledby="correction-heading">
    <div class="panel-heading">
      <div class="section-title">
        <span class="title-marker" />
        <h2 id="correction-heading">动作纠正提示</h2>
      </div>
      <button type="button" class="text-button" @click="rules.push(newRule())">添加规则</button>
    </div>
    <fieldset v-for="(entry, index) in feedback" :key="entry.rule.id" class="correction-rule">
      <legend>纠正规则 {{ index + 1 }}</legend>
      <div class="correction-body">
        <div class="correction-fields">
          <label>
            提示关节
            <select v-model="entry.rule.joint" @change="clearTarget(entry.rule)">
              <option v-for="item in JOINTS" :key="item.key" :value="item.key">{{
                item.label
              }}</option>
            </select>
          </label>
          <label>
            侧别
            <select
              v-if="entry.rule.joint !== 'spine'"
              v-model="entry.rule.side"
              @change="clearTarget(entry.rule)"
            >
              <option value="left">左侧</option>
              <option value="right">右侧</option>
            </select>
            <select v-else disabled
              ><option>中线</option></select
            >
          </label>
          <label>
            目标下限（°）
            <input
              v-model.number="entry.rule.lower"
              type="number"
              min="0"
              max="180"
              step="1"
              placeholder="未设置"
            />
          </label>
          <label>
            目标上限（°）
            <input
              v-model.number="entry.rule.upper"
              type="number"
              min="0"
              max="180"
              step="1"
              placeholder="未设置"
            />
          </label>
          <div class="correction-actions">
            <button
              v-if="entry.rule.lower !== '' || entry.rule.upper !== ''"
              type="button"
              class="text-button"
              @click="clearTarget(entry.rule)"
              >清除目标</button
            >
            <button type="button" class="text-button" @click="deleteRule(index)">删除规则</button>
          </div>
        </div>
        <div
          class="correction-feedback"
          :class="[entry.tone, { priority: priority === entry.rule.id }]"
        >
          <div class="correction-reading">
            <span>{{ entry.label }}</span>
            <strong v-if="priority === entry.rule.id" class="correction-priority">优先提示</strong>
            <span v-if="frame"
              >{{ frame.time.toFixed(2) }} s ·
              {{ entry.angle === null ? '—' : `${entry.angle.toFixed(1)}°` }}</span
            >
          </div>
          <span v-if="entry.previous">当前读数待确认 · 上次稳定状态 · </span>
          <strong role="status" :aria-label="entry.label">{{ entry.title }}</strong>
          <p>
            <template v-if="entry.target.status === 'valid'"
              >目标 {{ entry.target.lower }}–{{ entry.target.upper }}°。 </template
            >{{ entry.hint }}
          </p>
        </div>
      </div>
    </fieldset>
    <p class="correction-note"
      >按自定范围对照滤波后的二维夹角，供相对比较。遮挡和视角会影响读数。</p
    >
  </section>
</template>

<style scoped>
.correction-panel {
  margin-bottom: 20px;
}
.correction-panel .panel-heading {
  padding-bottom: 12px;
}
.correction-rule {
  min-width: 0;
  margin: 0 20px 10px;
  padding: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
}
.correction-rule legend {
  padding: 0 4px;
  color: var(--muted);
  font-size: 12px;
}
.correction-body {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  font-size: 12px;
}
.correction-fields {
  flex: 1 1 360px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  align-content: center;
}
.correction-fields label {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--muted);
}
.correction-fields :is(select, input) {
  width: 100%;
  height: 32px;
  padding: 0 7px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: #fff;
  color: var(--ink);
  font: inherit;
}
.correction-fields select:disabled {
  background: var(--surface-muted);
}
.correction-actions {
  display: flex;
  flex-wrap: wrap;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
}
.correction-feedback {
  flex: 1 1 240px;
  padding: 9px 11px;
  border-radius: 5px;
  background: var(--surface-muted);
  color: var(--text);
  line-height: 1.6;
}
.correction-feedback.within {
  background: #e9f5ec;
  color: #2c6743;
}
.correction-feedback.adjust {
  background: #fff3e2;
  color: #804c20;
}
.correction-feedback.priority {
  outline: 1px solid currentColor;
}
.correction-reading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
  font-variant-numeric: tabular-nums;
}
.correction-priority {
  margin-right: auto;
}
.correction-note {
  margin: 10px 20px 14px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
@media (max-width: 520px) {
  .correction-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
