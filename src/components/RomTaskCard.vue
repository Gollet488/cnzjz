<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRaw, watch } from 'vue';
import type { AnalysisSession, SessionInfo, SessionReference } from '../analysis/session.ts';
import type { ModelProvider } from '../agent/provider.ts';
import {
  draftRomCard,
  emptyRomCard,
  reviewRomCard,
  ROM_INTERVAL_LABELS,
  ROM_RANGE_LABELS,
  ROM_SIDE_LABELS,
} from '../agent/romTaskCard.ts';
import type {
  RomCardExecution,
  RomCardInput,
  RomConfirmation,
  RomDraftAudit,
} from '../agent/romTaskCard.ts';
import { resolveFreeRom } from '../agent/freeRomReview.ts';
import type { FreeRomConfirmation, FreeRomInput, FreeRomReview } from '../agent/freeRomReview.ts';
import { JOINTS } from '../config.ts';
import { download } from '../utils/download.ts';

const props = defineProps<{
  provider?: ModelProvider;
  session: AnalysisSession;
  info: SessionInfo;
  running: boolean;
  freeReview?: FreeRomReview;
  last?: RomCardExecution & { runId: string };
}>();
const emit = defineEmits<{
  confirm: [confirmation: RomConfirmation];
  confirmFree: [confirmation: FreeRomConfirmation];
  cancelFree: [];
  pause: [];
}>();
const card = ref(emptyRomCard());
const freeCard = ref<FreeRomInput>();
const form = computed(() => freeCard.value ?? card.value);
const locked = computed(() => (props.running && !freeCard.value) || drafting.value);
const open = ref(false);
const showPrompt = ref(false);
const goal = ref('');
const entry = ref<RomConfirmation['entry']>('manual');
const draft = shallowRef<RomDraftAudit>();
const attempt = shallowRef<RomDraftAudit>();
let auditedAttempt: RomDraftAudit | undefined;
const drafting = ref(false);
const draftError = ref('');
const reviewed = shallowRef<SessionReference>();
let activeDraft: { controller: AbortController; reference: SessionReference } | undefined;

const fields = ['first', 'second', 'chart'] as const;
const labels = { ...ROM_RANGE_LABELS, exportRange: 'CSV 范围' };
const displayedFields = computed(
  () =>
    [
      'first',
      'second',
      ...(!freeCard.value || freeCard.value.showChart ? ['chart'] : []),
      ...(freeCard.value?.csv ? ['exportRange'] : []),
    ] as (keyof typeof labels)[],
);
const publishedReference = computed(() => ({
  sessionId: props.info.sessionId,
  revision: props.info.revision,
}));
const sameVersion = (a: SessionReference, b: SessionReference) =>
  a.sessionId === b.sessionId && a.revision === b.revision;
const reviewOutdated = computed(
  () => reviewed.value && !sameVersion(reviewed.value, publishedReference.value),
);
const freeRanges = computed(
  () => freeCard.value && resolveFreeRom(freeCard.value, props.info, props.session.frames),
);
const review = computed(
  () => freeRanges.value ?? reviewRomCard(card.value, props.info, props.session.frames),
);
const reviewReady = computed(
  () =>
    review.value.resolved &&
    !freeRanges.value?.chartError &&
    !freeRanges.value?.csvError &&
    !freeRanges.value?.timeError,
);
function fieldValue(field: keyof typeof labels) {
  return field === 'exportRange' ? freeCard.value!.exportRange : form.value[field];
}
function fieldError(field: keyof typeof labels) {
  if (field === 'exportRange') return freeRanges.value?.csvError;
  if (field === 'chart' && freeRanges.value) return freeRanges.value.chartError;
  return review.value.errors[field];
}
function fieldRange(field: keyof typeof labels) {
  return field === 'exportRange' ? freeRanges.value?.csvRange : review.value.ranges[field];
}
const staleDraft = '草拟期间采样会话已更新，草稿已失效。';
const seconds = (value: number | null) =>
  value === null ? '待填' : String(Number(value.toPrecision(14)));
const rangeLabel = (value: [number, number]) => `${seconds(value[0])}–${seconds(value[1])} s`;
const jointLabel = (key: string) => JOINTS.find((joint) => joint.key === key)?.label ?? key;
const independentChart = computed(() => {
  const view = props.freeReview?.proposed.deliveries.view;
  if (!view || !freeCard.value?.showChart || freeCard.value.linkChart) return '';
  return [
    jointLabel(view.joint),
    view.channels.map((side) => ROM_SIDE_LABELS[side]).join(' / '),
    view.basis,
  ].join(' · ');
});
const enabled = (value: boolean) => (value ? '启用' : '关闭');
const describeRange = (value: RomCardInput['chart']) => {
  const label = ROM_INTERVAL_LABELS[value.mode];
  if (value.mode === 'cover' || value.mode === 'sampled') return label;
  if (value.mode === 'absolute') return `${label} ${seconds(value.start)}–${seconds(value.end)} s`;
  return `${label} ${seconds(value.seconds)} s`;
};
const changes = computed(() => {
  if (!props.last) return [];
  const before = props.last.input;
  const after = card.value;
  const result: string[] = [];
  const add = (label: string, from: string, to: string) => {
    if (from !== to) result.push(`${label}：${from} → ${to}`);
  };
  add('关节', jointLabel(before.joint), jointLabel(after.joint));
  add('侧别', ROM_SIDE_LABELS[before.side], ROM_SIDE_LABELS[after.side]);
  add('口径', before.basis, after.basis);
  for (const field of fields) {
    add(labels[field], describeRange(before[field]), describeRange(after[field]));
    const previous = props.last.resolved?.[field];
    const current = review.value.ranges[field];
    if (
      after[field].mode !== 'absolute' &&
      previous &&
      current &&
      (previous[0] !== current[0] || previous[1] !== current[1])
    )
      add(`${labels[field]}实际区间`, rangeLabel(previous), rangeLabel(current));
  }
  add('报告', enabled(before.report), enabled(after.report));
  add('CSV', enabled(before.csv), enabled(after.csv));
  return result;
});

function changeMode(field: keyof typeof labels, mode: RomCardInput['chart']['mode']) {
  if (mode === 'cover') {
    if (field === 'chart') form.value.chart = { mode };
    return;
  }
  const value =
    mode === 'absolute'
      ? ({ mode, start: null, end: null } as const)
      : mode === 'sampled'
        ? ({ mode } as const)
        : { mode, seconds: null };
  if (field === 'exportRange') freeCard.value!.exportRange = value;
  else form.value[field] = value;
}
function setNumber(field: keyof typeof labels, key: 'start' | 'end' | 'seconds', event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  const interval = fieldValue(field);
  const number = Number.isFinite(value) ? value : null;
  if (interval.mode === 'absolute' && key !== 'seconds') interval[key] = number;
  else if ((interval.mode === 'start' || interval.mode === 'end') && key === 'seconds')
    interval.seconds = number;
}
function setSeek(event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  freeCard.value!.time = Number.isFinite(value) ? value : null;
}
function cancelDraft(reason?: string) {
  activeDraft?.controller.abort(reason);
}
function manual() {
  cancelDraft();
  showPrompt.value = false;
  if (!open.value) reviewed.value = publishedReference.value;
  open.value = true;
}
async function reviewCurrent() {
  emit('pause');
  await nextTick();
  reviewed.value = publishedReference.value;
}
function restoreLast() {
  if (!props.last) return;
  manual();
  card.value = structuredClone(toRaw(props.last.input));
  draft.value = undefined;
  entry.value = 'manual';
  draftError.value = '';
}
async function generate() {
  if (!props.provider || !goal.value.trim() || drafting.value || props.running) return;
  const controller = new AbortController();
  const reference = publishedReference.value;
  activeDraft = { controller, reference };
  drafting.value = true;
  draftError.value = '';
  try {
    const { draft: candidate, audit } = await draftRomCard(
      props.provider,
      goal.value,
      controller.signal,
    );
    audit.reference = reference;
    attempt.value = audit;
    if (!candidate) {
      draftError.value = audit.request.error ?? '模型未返回草稿。';
      return;
    }
    // A sample can arrive before its batched publication reaches the card.
    if (!sameVersion(reference, props.session.info())) {
      audit.request.error = draftError.value = staleDraft;
      return;
    }
    const errors = reviewRomCard(candidate, props.info, props.session.frames).errors;
    // Shape errors and unavailable ranges leave any existing edits intact.
    if (Object.keys(errors).length) {
      draftError.value = Object.entries(errors)
        .map(
          ([field, error]) =>
            `${field === 'side' ? '侧别' : ROM_RANGE_LABELS[field as keyof typeof ROM_RANGE_LABELS]}：${error}`,
        )
        .join(' ');
      audit.request.error = draftError.value;
      return;
    }
    card.value = structuredClone(candidate);
    reviewed.value = reference;
    draft.value = audit;
    entry.value = 'model-draft';
    open.value = true;
  } finally {
    activeDraft = undefined;
    drafting.value = false;
  }
}
function saveDraftAudit() {
  if (!attempt.value) return;
  download(
    new Blob([JSON.stringify(attempt.value, null, 2)], { type: 'application/json' }),
    'rom-task-draft-audit.json',
  );
}
function confirm() {
  if (freeCard.value && props.freeReview) {
    if (!reviewReady.value || !sameVersion(props.freeReview.reference, publishedReference.value))
      return;
    emit('confirmFree', {
      input: structuredClone(toRaw(freeCard.value)),
      reviewed: props.freeReview.reference,
      confirmedAt: Date.now(),
    });
    return;
  }
  if (
    !reviewed.value ||
    reviewOutdated.value ||
    !review.value.resolved ||
    props.running ||
    drafting.value
  )
    return;
  emit('confirm', {
    entry: entry.value,
    draft: draft.value,
    draftAttempt:
      attempt.value !== draft.value && attempt.value !== auditedAttempt ? attempt.value : undefined,
    previousRunId: props.last?.runId,
    confirmedAt: Date.now(),
    input: structuredClone(toRaw(card.value)),
    reviewed: reviewed.value,
  });
}
watch(
  () => props.last?.runId,
  () => {
    auditedAttempt = attempt.value;
    draft.value = undefined;
    entry.value = 'manual';
  },
);
watch(
  () => props.provider,
  () => cancelDraft('模型连接已断开，草拟已取消。'),
);
watch(publishedReference, (current) => {
  if (activeDraft && !sameVersion(activeDraft.reference, current)) cancelDraft(staleDraft);
});
watch(
  () => props.freeReview,
  (review) => {
    if (review) cancelDraft();
    freeCard.value = review ? structuredClone(review.input) : undefined;
  },
);
onBeforeUnmount(() => cancelDraft());
</script>

<template>
  <section class="panel rom-card" aria-labelledby="rom-card-title">
    <h2 id="rom-card-title">两段 ROM 比较任务卡</h2>
    <p>按当前会话审阅前后两段。确认后在浏览器比较、绘图，并准备选中的成果。</p>
    <div class="card-actions">
      <el-button :disabled="running" @click="manual">手动填写</el-button>
      <el-button :disabled="running || drafting" @click="showPrompt = true"
        >用当前模型草拟</el-button
      >
      <el-button v-if="last" :disabled="running || drafting" @click="restoreLast"
        >修改已确认参数</el-button
      >
    </div>
    <form v-if="showPrompt" class="draft-form" @submit.prevent="generate">
      <label for="rom-draft-goal">模型草拟指令</label>
      <textarea
        id="rom-draft-goal"
        v-model="goal"
        :disabled="drafting"
        maxlength="2000"
        rows="2"
        placeholder="例如：比较左右膝 filtered ROM 的 0–5 秒与 15–20 秒，图表覆盖两段"
      />
      <p v-if="!provider" role="status">模型未连接，可继续手动填写。</p>
      <div class="card-actions">
        <el-button native-type="submit" :disabled="!provider || !goal.trim() || drafting || running"
          >生成待审阅草稿</el-button
        >
        <el-button v-if="drafting" @click="cancelDraft()">取消草拟</el-button>
      </div>
    </form>
    <p v-if="draftError" class="field-error" role="alert"
      >{{ draftError }} 已填参数保留，可继续手动编辑。</p
    >
    <details v-if="attempt" class="draft-audit">
      <summary>模型草拟审计</summary>
      <p
        >{{ attempt.provider }} / {{ attempt.model }} ·
        {{ (attempt.elapsedMs / 1000).toFixed(1) }} s</p
      >
      <pre>{{ JSON.stringify(attempt.request.reply?.calls ?? [], null, 2) }}</pre>
      <el-button @click="saveDraftAudit">保存模型草拟审计</el-button>
    </details>

    <form v-if="open || freeCard" class="card-form" @submit.prevent="confirm">
      <p>{{
        freeCard
          ? freeReview?.parameterSource === 'local'
            ? '自由目标 · 请核对或编辑本地绑定参数后确认'
            : '自由目标 · 请核对或编辑模型声明后确认'
          : entry === 'model-draft'
            ? '模型草稿 · 请核对或编辑后确认'
            : '手动填写 · 请核对后确认'
      }}</p>
      <template v-if="freeReview">
        <p>用户目标 {{ freeReview.goal }}</p>
        <p>比较指标 {{ freeReview.proposed.metrics.join('、') }} · 后段减前段</p>
        <p>审阅会话版本 {{ freeReview.reference.revision }}</p>
      </template>
      <p>当前采样范围 {{ info.range ? rangeLabel(info.range) : '暂无采样' }}</p>
      <p v-if="!freeCard && reviewOutdated" role="status"
        >采样会话已更新。请按当前会话重新审阅展开区间后确认。</p
      >
      <fieldset :disabled="locked" class="card-controls">
        <legend>比较选择</legend>
        <div class="card-fields">
          <label
            >关节<select
              v-model="form.joint"
              aria-label="关节"
              @change="
                form.side =
                  form.joint === 'spine' ? 'midline' : form.side === 'midline' ? 'both' : form.side
              "
            >
              <option v-for="joint in JOINTS" :key="joint.key" :value="joint.key">{{
                joint.label
              }}</option>
            </select></label
          >
          <label
            >侧别<select
              v-model="form.side"
              aria-label="侧别"
              :aria-invalid="Boolean(review.errors.side)"
            >
              <option
                v-for="(label, value) in ROM_SIDE_LABELS"
                :key="value"
                :value="value"
                :disabled="(form.joint === 'spine') !== (value === 'midline')"
                >{{ label }}</option
              > </select
            ><small v-if="review.errors.side" class="field-error">{{
              review.errors.side
            }}</small></label
          >
          <label
            >口径<select v-model="form.basis" aria-label="口径">
              <option value="filtered">filtered（滤波）</option>
              <option value="raw">raw（原始）</option>
            </select></label
          >
        </div>
      </fieldset>
      <fieldset v-if="freeCard" :disabled="locked" class="card-controls">
        <legend>待执行操作</legend>
        <label class="checkbox"
          ><input v-model="freeCard.separateMetrics" type="checkbox" />单独统计前段</label
        >
        <label class="checkbox"
          ><input v-model="freeCard.quality" type="checkbox" />检查前段样本质量</label
        >
        <label class="checkbox"
          ><input v-model="freeCard.showChart" type="checkbox" />应用图表</label
        >
        <label v-if="freeCard.showChart && freeReview?.proposed.deliveries.view" class="checkbox">
          <input v-model="freeCard.linkChart" type="checkbox" />图表沿用比较的关节、侧别和口径
        </label>
        <p v-if="independentChart">图表选择 {{ independentChart }}</p>
        <label
          >定位秒数（留空则不定位）
          <input type="number" step="any" min="0" :value="freeCard.time" @input="setSeek" />
        </label>
        <p v-if="freeRanges?.timeError" class="field-error">{{ freeRanges.timeError }}</p>
      </fieldset>
      <div class="card-fields">
        <fieldset v-for="field in displayedFields" :key="field" :disabled="locked">
          <legend>{{ labels[field] }}</legend>
          <label
            >区间类型<select
              :aria-label="`${labels[field]}类型`"
              :value="fieldValue(field).mode"
              @change="
                changeMode(
                  field,
                  ($event.target as HTMLSelectElement).value as RomCardInput['chart']['mode'],
                )
              "
            >
              <option
                v-for="(label, mode) in ROM_INTERVAL_LABELS"
                v-show="(mode !== 'cover' || field === 'chart') && (mode !== 'sampled' || freeCard)"
                :key="mode"
                :value="mode"
                >{{ label }}</option
              >
            </select></label
          >
          <template v-for="value in [fieldValue(field)]" :key="value.mode">
            <template v-if="value.mode === 'absolute'">
              <label
                >开始秒<input
                  type="number"
                  step="any"
                  min="0"
                  :aria-label="`${labels[field]}开始秒`"
                  :value="value.start"
                  @input="setNumber(field, 'start', $event)"
              /></label>
              <label
                >结束秒<input
                  type="number"
                  step="any"
                  min="0"
                  :aria-label="`${labels[field]}结束秒`"
                  :value="value.end"
                  @input="setNumber(field, 'end', $event)"
              /></label>
            </template>
            <label v-else-if="value.mode === 'start' || value.mode === 'end'"
              >时长（秒）<input
                type="number"
                step="any"
                min="0"
                :aria-label="`${labels[field]}时长`"
                :value="value.seconds"
                @input="setNumber(field, 'seconds', $event)"
            /></label>
          </template>
          <p v-if="fieldError(field)" class="field-error">{{ fieldError(field) }}</p>
          <p v-else-if="fieldRange(field)" :data-rom-range="field"
            >实际区间 {{ rangeLabel(fieldRange(field)!) }}</p
          >
        </fieldset>
      </div>
      <fieldset :disabled="locked" class="card-controls">
        <legend>成果选项</legend>
        <label class="checkbox"><input v-model="form.report" type="checkbox" />准备比较报告</label>
        <label class="checkbox"
          ><input v-model="form.csv" type="checkbox" />{{
            freeCard ? '准备 CSV（独立区间，含完整列）' : '准备 CSV（与图表同区间，含完整列）'
          }}</label
        >
      </fieldset>
      <div v-if="last && !freeCard" class="card-changes">
        <strong>与上次确认相比</strong>
        <ul v-if="changes.length"
          ><li v-for="change in changes" :key="change">{{ change }}</li></ul
        >
        <p v-else>参数和当前展开范围相同。</p>
      </div>
      <div class="card-actions">
        <el-button v-if="freeCard" @click="emit('cancelFree')">取消本次审阅</el-button>
        <el-button v-else-if="reviewOutdated" :disabled="running || drafting" @click="reviewCurrent"
          >按当前会话重新审阅</el-button
        >
        <el-button v-else :disabled="running" @click="emit('pause')">暂停采集以核对范围</el-button>
        <el-button
          type="primary"
          native-type="submit"
          :disabled="(!freeCard && reviewOutdated) || !reviewReady || locked"
          >确认并运行比较</el-button
        >
      </div>
    </form>
  </section>
</template>

<style scoped>
.rom-card {
  padding: 24px;
}
.rom-card h2 {
  margin-top: 0;
  font-size: 18px;
}
.card-actions,
.card-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.card-actions {
  align-items: center;
}
.card-actions :deep(.el-button) {
  margin-left: 0;
}
.card-fields > * {
  flex: 1 1 180px;
}
.card-form,
.draft-form {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}
.card-form p,
.draft-form p {
  margin: 0;
}
fieldset {
  min-inline-size: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 10px;
}
legend {
  font-weight: 600;
}
label {
  display: grid;
  gap: 4px;
  margin-bottom: 6px;
}
.checkbox {
  display: flex;
  align-items: center;
}
input:not([type='checkbox']),
select,
textarea {
  width: 100%;
  padding: 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font: inherit;
}
.field-error {
  color: var(--el-color-danger);
}
.draft-audit {
  margin-top: 12px;
}
.draft-audit pre {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
}
.card-changes ul {
  margin: 6px 0;
  padding-left: 20px;
}
</style>
