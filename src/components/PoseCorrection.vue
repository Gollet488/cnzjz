<script setup lang="ts">
import { computed, ref } from 'vue';
import { JOINTS } from '../config';
import { angleValue } from '../utils/poseMath';
import type { Joint, PoseFrame, Side } from '../types';

const props = defineProps<{ frame?: PoseFrame }>();
const joint = ref<Joint>('knee');
const side = ref<Side>('left');
const lower = ref<number | ''>('');
const upper = ref<number | ''>('');

function clearTarget() {
  lower.value = '';
  upper.value = '';
}

const angle = computed(() => {
  if (!props.frame) return null;
  const value = angleValue(
    props.frame.angles,
    joint.value,
    joint.value === 'spine' ? 'midline' : side.value,
  );
  return value === null ? null : Math.round(value * 10) / 10;
});

const feedback = computed(() => {
  const min = lower.value;
  const max = upper.value;
  if (min === '' || max === '')
    return { title: '待设置目标', hint: '填写目标下限和上限后开始提示。' };
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 180 || min > max)
    return { title: '目标范围无效', hint: '请输入 0–180° 的整数，且下限不得超过上限。' };
  if (!props.frame) return { title: '等待采样', hint: '开始分析后查看该关节的夹角。' };
  const value = angle.value;
  if (value === null)
    return { title: '当前夹角不可用', hint: '请让相关关节清晰入镜，或回看其他时刻。' };
  if (value < min)
    return { title: '夹角偏小', hint: '对照目标，尝试增大该关节夹角。', tone: 'adjust' };
  if (value > max)
    return { title: '夹角偏大', hint: '对照目标，尝试减小该关节夹角。', tone: 'adjust' };
  return { title: '夹角在目标范围内', hint: '当前夹角符合你设定的范围。', tone: 'within' };
});
</script>

<template>
  <section class="panel correction-panel" aria-labelledby="correction-heading">
    <div class="panel-heading">
      <div class="section-title">
        <span class="title-marker" />
        <h2 id="correction-heading">动作纠正提示</h2>
      </div>
      <button
        v-if="lower !== '' || upper !== ''"
        type="button"
        class="text-button"
        @click="clearTarget"
        >清除目标</button
      >
    </div>
    <div class="correction-body">
      <div class="correction-fields">
        <label>
          提示关节
          <select v-model="joint" @change="clearTarget">
            <option v-for="item in JOINTS" :key="item.key" :value="item.key">{{
              item.label
            }}</option>
          </select>
        </label>
        <label>
          侧别
          <select v-if="joint !== 'spine'" v-model="side" @change="clearTarget">
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
            v-model.number="lower"
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
            v-model.number="upper"
            type="number"
            min="0"
            max="180"
            step="1"
            placeholder="未设置"
          />
        </label>
      </div>
      <div class="correction-feedback" :class="feedback.tone">
        <div class="correction-reading">
          <strong role="status">{{ feedback.title }}</strong>
          <span v-if="frame"
            >{{ frame.time.toFixed(2) }} s ·
            {{ angle === null ? '—' : `${angle.toFixed(1)}°` }}</span
          >
        </div>
        <p>{{ feedback.hint }}</p>
      </div>
    </div>
    <p class="correction-note">按自定范围对照当前帧的滤波后二维夹角。遮挡和视角会影响读数。</p>
  </section>
</template>

<style scoped>
.correction-panel {
  margin-bottom: 20px;
}
.correction-panel .panel-heading {
  padding-bottom: 12px;
}
.correction-body {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 0 20px;
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
  color: #52685b;
}
.correction-fields :is(select, input) {
  width: 100%;
  height: 32px;
  padding: 0 7px;
  border: 1px solid #d8e4db;
  border-radius: 5px;
  background: #fff;
  color: #304b3a;
  font: inherit;
}
.correction-fields select:disabled {
  background: #f4f7f4;
}
.correction-feedback {
  flex: 1 1 240px;
  padding: 9px 11px;
  border-radius: 5px;
  background: #f4f7f4;
  color: #41594a;
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
.correction-reading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 10px;
}
.correction-reading span {
  font-variant-numeric: tabular-nums;
}
.correction-note {
  margin: 10px 20px 14px;
  color: #52685b;
  font-size: 11px;
  line-height: 1.5;
}
@media (max-width: 520px) {
  .correction-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
