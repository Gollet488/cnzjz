<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { AnalysisSession, SessionInfo } from '../analysis/session.ts';
import type { createToolRegistry } from '../analysis/tools.ts';
import { sourceClock, sourceLabel, sourceTimeSpan } from '../analysis/sourceDisplay.ts';
import { OllamaProvider } from '../agent/provider.ts';
import { cloudProviderIds, cloudProviders, modelNotes } from '../agent/modelCatalog.ts';
import type { ProviderId } from '../agent/modelCatalog.ts';
import { choiceKey, providerNames, useAgentModels } from '../agent/useAgentModels.ts';
import { CloudPageProvider, modelError } from '../agent/providers/cloudPage.ts';
import type { ModelReply } from '../agent/provider.ts';
import { AgentRuntime } from '../agent/runtime.ts';
import type { AgentRun } from '../agent/runtime.ts';
import AgentEvidence from './AgentEvidence.vue';
import AgentArtifact from './AgentArtifact.vue';
import AgentTaskSpec from './AgentTaskSpec.vue';
import RomTaskCard from './RomTaskCard.vue';
import { executeRomCard } from '../agent/romTaskCard.ts';
import type { FreeRomConfirmation, FreeRomReview } from '../agent/freeRomReview.ts';
import type { RomCardExecution, RomConfirmation } from '../agent/romTaskCard.ts';
import type { CallRecord } from '../agent/runtime.ts';
import { readRunAudit, saveRunAudit } from '../agent/audit.ts';
import { download } from '../utils/download.ts';

const props = defineProps<{
  session: AnalysisSession;
  tools: ReturnType<typeof createToolRegistry>;
  info: SessionInfo;
  active: boolean;
  waitForApplication?: (run: AgentRun) => Promise<void>;
}>();
const emit = defineEmits<{ pause: []; export: [handle: string]; invalidateView: []; manual: [] }>();
const {
  addressInput,
  cloudError,
  localError,
  envFile,
  refreshing,
  loaded,
  settings,
  settingsProvider,
  settingsConfig,
  settingsOptions,
  testModel,
  target,
  testResult,
  testing,
  settingsStatus,
  choice,
  selected,
  selectedConfigured,
  ready,
  temporaryKey,
  keyValid,
  customModel,
  customModelValid,
  selectCustom,
  createProvider,
  options,
  cloudOptions,
  select,
  openSettings,
  refresh,
  applyAddress,
  recordResult,
  testConnection,
  cancelTest,
  dispose,
} = useAgentModels();
const localOptions = computed(() => options.value.filter((item) => item.provider === 'ollama'));
const activeCloud = computed(() => {
  const provider = selected.value?.provider;
  return provider && provider !== 'ollama' ? cloudProviders[provider] : undefined;
});
const running = ref(false);
let submissionCheck: AbortController | undefined;
watch(
  () => props.active,
  (active) => {
    if (active) void refresh();
  },
  { immediate: true },
);
function changeModel(event: Event) {
  const menu = event.target as HTMLSelectElement;
  if (menu.value.startsWith('settings:')) {
    openSettings(menu.value.slice('settings:'.length) as ProviderId);
    menu.value = choice.value ? choiceKey(choice.value) : '';
  } else {
    select(menu.value);
    if (!running.value) error.value = '';
  }
}
function testSelected() {
  const item = selected.value;
  if (!item || !ready.value || running.value || testing.value) return;
  openSettings(item.provider);
  void testConnection();
}
const exampleGoal = '比较已采样数据前后各 5 秒的左右膝 filtered ROM，并展示覆盖两段的图表';
const goal = ref(exampleGoal);
const runs = shallowRef<AgentRun[]>([]);
const responseMetadata = shallowRef<Record<string, NonNullable<ModelReply['response']>[]>>({});
const error = ref('');
const dismissedRuns = new Set<string>();
const draftProvider = computed(() => {
  const item = selected.value;
  if (!item || !ready.value) return undefined;
  if (item.provider === 'ollama') return new OllamaProvider(item.address!, item.model);
  return createProvider(item);
});
const lastRomCard = shallowRef<RomCardExecution & { runId: string }>();
const freeReview = shallowRef<FreeRomReview>();
let confirmFree: ((confirmation: FreeRomConfirmation) => void) | undefined;
async function requestRomReview(review: FreeRomReview, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void;
  const confirmed = new Promise<FreeRomConfirmation>((resolve, reject) => {
    confirmFree = resolve;
    abort = () => reject(new Error(String(signal.reason)));
    signal.addEventListener('abort', abort, { once: true });
  });
  freeReview.value = review;
  void nextTick(() =>
    document.getElementById('rom-card-title')?.scrollIntoView({ block: 'start' }),
  );
  try {
    return await confirmed;
  } finally {
    signal.removeEventListener('abort', abort!);
    freeReview.value = undefined;
    confirmFree = undefined;
  }
}
const statusNames: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  needs_input: '需要信息',
  limited: '结果有限',
  partial: '部分结果',
  not_comparable: '不可比',
  cancelled: '已取消',
  timeout: '已超时',
  stale: '已过期',
  failed: '失败',
  limit: '已达上限',
};
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});
const reportedModels = (run: AgentRun) => [
  ...new Set(responseMetadata.value[run.id]?.map((response) => response.model)),
];
const stale = (run: AgentRun) =>
  run.reference.sessionId !== props.info.sessionId ||
  run.reference.revision !== props.info.revision;
const invalid = (run: AgentRun) =>
  stale(run) ||
  ['cancelled', 'stale', 'timeout'].includes(run.status) ||
  Boolean(run.romCard && (run.status === 'running' || run.status === 'failed'));
const evidenceCalls = (run: AgentRun) =>
  run.calls.filter(
    (c) =>
      c.output.ok && ['get_quality_summary', 'query_metrics', 'compare_intervals'].includes(c.name),
  );
const artifactCalls = (run: AgentRun) =>
  run.calls.filter((c) => c.output.ok && ['prepare_report', 'prepare_export'].includes(c.name));
const hasEvidenceCard = (run: AgentRun, id: string) =>
  evidenceCalls(run).some((call) => call.id === id) ||
  artifactCalls(run).some((call) => call.id === id);
function locate(call: CallRecord, second = false, interval?: [number, number]) {
  if (!call.output.ok) return;
  const result = call.output.result as any;
  const metric =
    call.name === 'compare_intervals' ? (second ? result.second : result.first) : result;
  const ev = metric.evidence;
  const selection = call.name === 'get_quality_summary' ? metric.selection : metric;
  const input = { sessionId: ev.sessionId, revision: ev.revision };
  const selectedInterval = interval ?? ev.interval;
  const outputs = [
    props.tools.execute('seek_to_time', {
      ...input,
      time: interval?.[0] ?? ev.sampledRange?.[0] ?? selectedInterval[0],
    }),
  ];
  if (selection?.joint)
    outputs.push(
      props.tools.execute('set_chart_view', {
        ...input,
        interval: selectedInterval,
        basis: ev.basis,
        joint: selection.joint,
        channels: selection.channels.map((c: any) => c.channel),
      }),
    );
  const failed = outputs.find((o) => !o.ok);
  error.value = failed && !failed.ok ? failed.error.message : '';
  if (!failed) document.getElementById('agent-chart-view')?.scrollIntoView({ block: 'center' });
}
const runtime = new AgentRuntime({
  session: props.session,
  registry: props.tools,
  reviewRom: requestRomReview,
  verifyApplication: props.waitForApplication,
  onAudit: async (audit) => {
    responseMetadata.value = {
      ...responseMetadata.value,
      [audit.run.id]: audit.requests.flatMap((r) => (r.reply?.response ? [r.reply.response] : [])),
    };
    await saveRunAudit(audit);
  },
  onReady: async (run) => {
    await nextTick();
    await props.waitForApplication?.(run);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  },
  onChange: (run) => {
    if (dismissedRuns.has(run.id)) return;
    if (['cancelled', 'stale', 'timeout'].includes(run.status)) emit('invalidateView');
    const index = runs.value.findIndex((r) => r.id === run.id);
    if (index < 0) runs.value = [run, ...runs.value].slice(0, 8);
    else runs.value = runs.value.map((r, i) => (i === index ? run : r));
  },
});
watch(
  () => [props.info.sessionId, props.info.revision],
  () => runtime.invalidate(),
  { flush: 'sync' },
);
async function submit() {
  const item = selected.value;
  const task = goal.value;
  if (!item || !ready.value || !task.trim() || running.value || testing.value) return;
  const submission = {
    submittedAt: Date.now(),
    monotonicAt: performance.now(),
    timeoutMs: item.provider === 'deepseek' ? 120_000 : undefined,
  };
  const controller = new AbortController();
  submissionCheck = controller;
  running.value = true;
  error.value = '';
  let provider: ReturnType<typeof createProvider> | undefined;
  try {
    provider = createProvider(item);
    if (provider instanceof OllamaProvider)
      await provider.checkConfiguration(
        AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      );
    controller.signal.throwIfAborted();
    emit('pause');
    await nextTick();
    controller.signal.throwIfAborted();
    const run = await runtime.run(task, submission, provider);
    if (run.status === 'cancelled' || run.status === 'stale') return;
    if (run.requests?.some((request) => request.status === 'failed')) {
      error.value =
        run.status === 'timeout'
          ? run.message
          : modelError(run.message, item.provider === 'ollama');
      recordResult(item, false, error.value);
    } else if (run.calls.length) {
      recordResult(item, true, '已在任务中收到结构化工具调用。');
      if (run.status === 'failed' || run.status === 'limit') {
        const last = run.calls.at(-1)?.output;
        const reason = last && !last.ok ? last.error.message : run.message;
        error.value = `任务未完成。${reason} 请调整任务或更换模型后重试。`;
      }
    } else if (run.rounds) {
      error.value = modelError('NO_TOOL', item.provider === 'ollama');
      recordResult(item, false, error.value);
    }
  } catch (reason) {
    error.value = controller.signal.aborted
      ? '已取消分析。'
      : modelError(reason, item.provider === 'ollama');
    if (!controller.signal.aborted) recordResult(item, false, error.value);
  } finally {
    if (provider instanceof CloudPageProvider) void provider.release();
    submissionCheck = undefined;
    running.value = false;
  }
}
async function runRomCard(confirmation: RomConfirmation) {
  if (running.value) return;
  running.value = true;
  error.value = '';
  try {
    emit('pause');
    const audit = executeRomCard(
      props.tools,
      props.session.info(),
      props.session.frames,
      confirmation,
    );
    const run = audit.run;
    const executedStatus = run.status;
    if (run.romCard?.resolved) lastRomCard.value = { ...run.romCard, runId: run.id };
    run.status = 'running';
    run.phase = '核对图表和准备成果';
    runs.value = [run, ...runs.value].slice(0, 8);
    try {
      await nextTick();
      if (executedStatus === 'completed' || executedStatus === 'not_comparable') {
        props.session.assertCurrent(run.reference);
        await props.waitForApplication?.(run);
        props.session.assertCurrent(run.reference);
      }
      run.status = executedStatus;
    } catch (e) {
      const info = props.session.info();
      run.status =
        info.sessionId !== run.reference.sessionId || info.revision !== run.reference.revision
          ? 'stale'
          : 'failed';
      run.message = e instanceof Error ? e.message : '图表或成果核对失败。';
    }
    run.phase = '本地执行结束';
    try {
      await saveRunAudit(audit);
      run.auditStatus = 'saved';
    } catch {
      run.auditStatus = 'failed';
    }
    runs.value = runs.value.map((item) => (item.id === run.id ? { ...run } : item));
  } catch (e) {
    error.value = e instanceof Error ? e.message : '任务卡启动失败。';
  } finally {
    running.value = false;
  }
}
function cancel() {
  submissionCheck?.abort();
  runtime.cancel();
}
function clearTemporaryKey() {
  temporaryKey.value = '';
}
watch(
  temporaryKey,
  (_, previous) => {
    if (previous.trim() && running.value) cancel();
    error.value = '';
  },
  { flush: 'sync' },
);
function clear() {
  for (const run of runs.value) if (run.status === 'running') dismissedRuns.add(run.id);
  runtime.clear();
  runs.value = [];
  error.value = '';
}
async function saveAudit(run: AgentRun) {
  try {
    const audit = await readRunAudit(run.id);
    // The immutable primary audit precedes its commit receipt. Export both;
    // never present the pre-commit snapshot as complete end-to-end timing.
    audit.run = structuredClone(run);
    download(
      new Blob([JSON.stringify(audit, null, 2)], { type: 'application/json' }),
      `agent-audit-${run.id}.json`,
    );
  } catch (e) {
    error.value = `审计读取失败：${e instanceof Error ? e.message : '未知错误'}`;
  }
}
onMounted(() => window.addEventListener('pagehide', clearTemporaryKey));
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', clearTemporaryKey);
  dispose();
  cancel();
  runtime.clear();
});
</script>

<template>
  <section class="agent-panel">
    <div class="panel agent-source">
      <h2>当前分析素材</h2>
      <p class="source-name"
        >{{ sourceLabel(info)
        }}<span v-if="info.source !== 'demo' && info.synthetic"> · 合成素材</span></p
      >
      <p
        >{{ sourceClock(info) }} ·
        <template v-if="info.range"
          >已采样 {{ sourceTimeSpan(info.range) }} · {{ info.sampleCount }} 帧</template
        >
        <template v-else>暂无采样</template></p
      >
    </div>
    <RomTaskCard
      :provider="draftProvider"
      :session="session"
      :info="info"
      :running="running"
      :last="lastRomCard"
      :free-review="freeReview"
      @confirm-free="confirmFree?.($event)"
      @cancel-free="runtime.cancel()"
      @pause="emit('pause')"
      @confirm="runRomCard"
    />

    <div class="panel goal-panel">
      <div class="agent-header"><h2>让工具完成分析目标</h2></div>
      <p
        >分析时自动暂停采集。支持接续修改区间或侧别；改变会话版本后重新取数。可定位图表、准备报告和
        CSV，成果卡保存文件；只分析不会下载。</p
      >
      <div class="goal-examples"
        ><button :disabled="running" @click="goal = exampleGoal">比较左右膝 ROM</button
        ><button
          :disabled="running"
          @click="goal = '哪些区间不适合比较？请查询整个已采样区间的质量与缺失情况'"
          >查询区间质量</button
        ><button
          :disabled="running"
          @click="
            goal =
              '查询整个已采样区间左右膝 filtered 角度的可用样本、覆盖率、连续缺失与可用时间段，保留限制'
          "
          >查询双膝可用性</button
        ><button :disabled="running" @click="goal = '只看右侧，第二段改成 12–17 秒'"
          >接续修改区间</button
        ><button
          :disabled="running"
          @click="goal = '为当前左右膝 filtered 指标准备有据报告，包含已比较的区间和限制'"
          >准备报告</button
        ><button :disabled="running" @click="goal = '为整个已采样区间准备 CSV 导出'"
          >准备 CSV</button
        ></div
      >
      <form @submit.prevent="submit"
        ><label for="agent-goal">分析目标或后续修改</label
        ><textarea id="agent-goal" v-model="goal" :disabled="running" maxlength="2000" rows="3" />
        <div class="goal-actions">
          <label class="agent-model-picker"
            >模型
            <select
              aria-label="模型"
              :value="choice ? choiceKey(choice) : ''"
              @change="changeModel"
            >
              <option value="">{{ choice ? '取消选择模型' : '请选择模型' }}</option>
              <option v-if="choice && !selected" :value="choiceKey(choice)" disabled>
                {{ choice.model }} · {{ providerNames[choice.provider] }}（{{
                  loaded ? '不可用' : '读取中'
                }}）
              </option>
              <optgroup label="本地">
                <option
                  v-for="item in localOptions"
                  :key="choiceKey(item)"
                  :value="choiceKey(item)"
                >
                  {{ item.model }} · Ollama
                </option>
                <option v-if="!localOptions.length" value="settings:ollama"
                  >Ollama · 查看配置</option
                >
              </optgroup>
              <optgroup
                v-for="provider in cloudProviderIds"
                :key="provider"
                :label="providerNames[provider]"
              >
                <option
                  v-for="item in cloudOptions.filter((item) => item.provider === provider)"
                  :key="choiceKey(item)"
                  :value="choiceKey(item)"
                >
                  {{ item.model }} · {{ providerNames[item.provider] }}
                </option>
              </optgroup>
            </select>
          </label>
          <el-button
            :aria-expanded="settings"
            aria-controls="agent-model-settings"
            @click="settings = !settings"
            >模型设置</el-button
          >
        </div>
        <details class="model-guide">
          <summary>首次连接？查看连接指南</summary>
          <ol v-if="selected?.provider !== 'ollama'">
            <li
              >在项目目录运行
              <code>pnpm dev</code
              >，用终端显示的本机地址打开页面。静态网页版可以采集和分析，云端模型需要本机服务。</li
            >
            <li
              >在上方选择云端模型，从
              <a
                v-if="activeCloud"
                :href="activeCloud.keys"
                target="_blank"
                rel="noopener noreferrer"
                >{{ activeCloud.name }} 控制台</a
              >
              <template v-else>所选供应商的开发者控制台</template>
              创建 API Key，确认账户有 API 额度和模型权限。</li
            >
            <li
              >将 Key 粘贴到下方，再点击「测试当前模型连接」。显示「已连接」后即可发送分析任务。</li
            >
          </ol>
          <ol v-else>
            <li>启动本机 Ollama，并用 <code>ollama list</code> 确认已安装支持工具的模型。</li>
            <li
              >在「模型设置」确认本机地址（默认
              <code>http://127.0.0.1:11434</code>），刷新列表后选中模型。</li
            >
            <li>点击「测试当前模型连接」。第一次载入模型可能需要等待片刻。</li>
          </ol>
        </details>
        <template v-if="selected && selected.provider !== 'ollama'">
          <p v-if="modelNotes[selected.model]">{{ modelNotes[selected.model] }}</p>
          <div class="agent-key">
            <label>
              {{ providerNames[selected.provider] }} 官方 API Key
              <input
                v-model="temporaryKey"
                aria-label="临时 API Key"
                aria-describedby="agent-key-note"
                type="password"
                autocomplete="off"
                spellcheck="false"
                :placeholder="selectedConfigured ? '可选，优先使用临时 Key' : '粘贴官方 API Key'"
                :disabled="running || testing || !!cloudError"
              />
            </label>
            <el-button :disabled="!temporaryKey" @click="clearTemporaryKey">清除 Key</el-button>
          </div>
          <p id="agent-key-note" class="agent-key-note">
            仅本页临时使用，刷新后清除。{{
              selectedConfigured ? '留空时使用已配置的服务密钥。' : ''
            }}
          </p>
          <p v-if="cloudError" class="agent-error" role="status">{{ cloudError }}</p>
          <p
            v-else-if="
              settingsConfig?.provider === selected.provider &&
              settingsConfig.missing.some((name) => name.endsWith('_ENDPOINT'))
            "
            class="agent-error"
            role="status"
          >
            官方端点配置无效。请在「模型设置 → 服务配置」查看需要修正的变量。
          </p>
          <p
            v-else-if="temporaryKey.trim() && (!keyValid || temporaryKey.trim() === selected.model)"
            class="agent-error"
            role="status"
            >请输入有效的官方 API Key。</p
          >
        </template>
        <div class="goal-actions">
          <el-button
            v-if="selected && !settings"
            :disabled="!ready || running || testing"
            @click="testSelected"
            >测试当前模型连接</el-button
          >
          <el-button :disabled="running || !runs.length" @click="clear">清空上下文</el-button>
          <el-button v-if="running" type="danger" @click="cancel">取消分析</el-button>
          <el-button
            v-else
            type="primary"
            native-type="submit"
            :disabled="!ready || !goal.trim() || testing"
            >发送</el-button
          >
        </div>
      </form>
      <p v-if="choice && !selected && loaded && !refreshing" class="agent-error" role="status">
        上次选择的模型当前不可用，请刷新模型列表或重新选择。
      </p>
      <p v-else-if="!selected && !refreshing && loaded && localError" class="connection-note">{{
        localError
      }}</p>
      <p
        v-else-if="!selected && !refreshing && loaded && !localOptions.length"
        class="connection-note"
      >
        Ollama 暂无可用模型。运行 <code>ollama list</code> 检查安装，然后在模型设置刷新列表。
      </p>
      <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
      <el-button v-if="!selected || error" text @click="emit('manual')">前往采集与分析</el-button>

      <section
        v-if="settings"
        id="agent-model-settings"
        class="agent-model-settings"
        aria-label="模型设置"
      >
        <div class="agent-header">
          <h3>模型设置</h3>
          <span
            class="connection-status"
            :class="{ connected: settingsStatus === '已连接' }"
            role="status"
            >{{ settingsStatus }}</span
          >
        </div>
        <div class="connection-form">
          <label
            >供应商
            <select
              aria-label="模型设置供应商"
              :value="settingsProvider"
              @change="openSettings(($event.target as HTMLSelectElement).value as ProviderId)"
            >
              <option v-for="(name, id) in providerNames" :key="id" :value="id">{{ name }}</option>
            </select>
          </label>
          <template v-if="settingsProvider === 'ollama'">
            <label
              >本地 Ollama 地址<input
                v-model="addressInput"
                aria-label="本地 Ollama 地址"
                type="url"
                @keydown.enter.prevent="applyAddress"
            /></label>
            <el-button @click="applyAddress">应用地址</el-button>
          </template>
          <template v-else>
            <label>
              自定义模型 ID
              <input
                v-model="customModel"
                maxlength="200"
                placeholder="输入官方模型 ID"
                @keydown.enter.prevent="selectCustom"
              />
            </label>
            <el-button :disabled="!customModelValid" @click="selectCustom">选择此模型</el-button>
          </template>
          <label v-if="settingsOptions.length"
            >模型 ID
            <select v-model="testModel" aria-label="设置中的模型 ID">
              <option value="">{{ target?.model }}（当前测试目标）</option>
              <option v-for="item in settingsOptions" :key="item.model" :value="item.model">{{
                item.model
              }}</option>
            </select>
          </label>
        </div>
        <p v-if="settingsProvider === 'ollama' && localError">{{ localError }}</p>
        <p v-else-if="settingsProvider === 'ollama' && loaded && !localOptions.length">
          未找到已安装的本地模型。运行 <code>ollama list</code> 检查，安装支持 tools 的模型后刷新。
        </p>
        <template v-if="settingsProvider !== 'ollama'">
          <p>
            预设为已适配接口的官方模型 ID，实际可用版本取决于 API Key 所属账户。
            也可填写支持工具调用的官方模型 ID 或快照 ID，再测试连接。
            <a
              :href="cloudProviders[settingsProvider].docs"
              target="_blank"
              rel="noopener noreferrer"
              >查看官方模型文档</a
            >
          </p>
          <p v-if="settingsConfig"
            >官方地址 <code>{{ settingsConfig.endpoint }}</code></p
          >
          <p v-if="cloudError">{{ cloudError }}</p>
          <details>
            <summary>服务配置（可选）</summary>
            <p v-if="settingsConfig?.missing.length"
              >请检查 <code>{{ settingsConfig.missing.join('、') }}</code
              >。</p
            >
            <p>
              在 <code>{{ envFile }}</code> 设置
              <code>{{ cloudProviders[settingsProvider].prefix }}_API_KEY</code> 与
              <code>{{ cloudProviders[settingsProvider].prefix }}_MODELS</code>（可选，多个模型 ID
              用逗号分隔；留空使用首个预设）。 若 Key 属于国际版智谱或
              Kimi，需配置对应地区的官方端点。变量为
              <code>{{ cloudProviders[settingsProvider].prefix }}_ENDPOINT</code>。 保存后重启本机
              Node 服务（<code>pnpm dev</code> 或 <code>pnpm preview</code>），然后刷新模型列表。
            </p>
          </details>
          <p
            >云端接收任务指令和必要的工具反馈。视频、原始关键点、计算、图表与导出留在本机。测试连接会调用所选模型，可能产生费用。</p
          >
        </template>
        <div class="goal-actions">
          <el-button :disabled="refreshing || testing" @click="refresh(true)">{{
            refreshing ? '正在刷新…' : '刷新模型列表'
          }}</el-button>
          <el-button v-if="testing" @click="cancelTest">取消测试</el-button>
          <el-button v-else :disabled="!target || running" @click="testConnection"
            >测试连接</el-button
          >
        </div>
        <p v-if="testResult" role="status">{{ testResult.message }}</p>
        <p v-else-if="settingsStatus === '可发送'"
          >配置已就绪。发送任务或测试连接可验证模型的工具能力。</p
        >
      </section>
    </div>

    <slot />
    <div v-if="!runs.length" class="agent-empty panel"
      ><h3>分析结果将包含可复核的本地证据</h3
      ><p>确认任务卡或发送分析目标后，在这里查看实际工具调用、区间比较、质量与数值引用。</p></div
    >
    <article
      v-for="run in runs"
      :key="run.id"
      class="panel run-panel"
      :class="{ 'stale-run': stale(run) }"
    >
      <div class="agent-header"
        ><h3>{{ run.goal }}</h3
        ><span :class="['run-status', run.status]">{{
          stale(run) ? '已过期 · 请重新取数' : statusNames[run.status]
        }}</span></div
      >
      <p class="run-meta"
        >{{
          providerNames[run.provider.replace(/-(local|api)$/, '') as ProviderId] ?? run.provider
        }}
        / {{ run.model }} · {{ run.rounds }} 轮 · {{ run.calls.length }} 次调用 ·
        {{ (run.elapsedMs / 1000).toFixed(1) }} s<template v-if="run.usage.reportedRequests">
          · API 已报告 token：输入 {{ run.usage.inputTokens ?? '未提供' }} / 输出
          {{ run.usage.outputTokens ?? '未提供' }}（{{
            run.usage.reportedRequests
          }}
          个请求）</template
        ></p
      >
      <p class="source-name"
        >{{ sourceLabel(run.reference)
        }}<span v-if="run.reference.source !== 'demo' && run.reference.synthetic"> · 合成素材</span>
        · {{ sourceClock(run.reference) }}</p
      >
      <p class="run-meta"
        >执行开始 {{ dateTime.format(run.startedAt) }}（本机时间） ·
        <template v-if="run.reference.range">
          当时已采样 {{ sourceTimeSpan(run.reference.range) }} · {{ run.reference.sampleCount }} 帧
        </template>
        <template v-else>当时暂无采样</template>
        · 版本 {{ run.reference.revision }}</p
      >
      <p v-if="reportedModels(run).length" class="run-meta"
        >API 返回模型 {{ reportedModels(run).join('、') }}</p
      >
      <p v-if="run.status === 'running'" role="status">{{ run.phase }}</p>
      <p v-if="run.conversationCosts" class="run-meta">
        本场累计（自最近清空起）：{{ run.conversationCosts.turns }} 次用户目标 /
        {{ run.conversationCosts.requests }} 次请求 /
        {{ run.conversationCosts.rounds }} 次模型响应轮次 /
        {{ (run.conversationCosts.elapsedMs / 1000).toFixed(1) }} s；输入 token
        {{ run.conversationCosts.inputTokens ?? '未知（部分请求未报告）' }} / 输出 token
        {{ run.conversationCosts.outputTokens ?? '未知（部分请求未报告）' }}。
      </p>
      <details v-if="run.requests?.length">
        <summary>单次请求大小与用量（UTF-8 字节不是 token）</summary>
        <p v-for="request in run.requests" :key="request.index">
          请求 {{ request.index }}：消息 {{ request.messageBytes }} B，工具定义
          {{ request.toolBytes }} B， 规范输入 {{ request.inputBytes }} B，实际 JSON 请求体
          {{ request.wireBytes ?? '未提供' }} B； API token {{ request.inputTokens ?? '未知' }} /
          {{ request.outputTokens ?? '未知' }}； {{ request.elapsedMs }} ms · {{ request.status }}
        </p>
      </details>
      <details v-if="responseMetadata[run.id]?.length">
        <summary>实际 API 模型与服务指纹（逐次响应）</summary>
        <p v-for="(response, index) in responseMetadata[run.id]" :key="index"
          >{{ index + 1 }}：{{ response.model }} ·
          {{ response.systemFingerprint ?? '未提供；不能声明冻结权重' }}</p
        >
      </details>
      <details v-if="run.context">
        <summary>本轮继承依据与上轮反馈（意图参数不代表测量结果）</summary>
        <AgentTaskSpec v-if="run.context.previousTask" :task="run.context.previousTask" />
        <p v-for="intent in run.context.pendingUserIntents" :key="intent.runId"
          >待确认用户原文：{{ intent.goal }}</p
        >
        <p v-if="run.context.referenceChanged">会话版本已变；所有证据需本轮重新查询。</p>
        <p v-if="run.context.unavailableFields.length"
          >旧区间不可用，需澄清：{{ run.context.unavailableFields.join('、') }}</p
        >
        <p v-if="run.context.recentFeedback"
          >上轮状态：{{ run.context.recentFeedback.status }}；待满足：{{
            run.context.recentFeedback.missing.join('、') || '无'
          }}</p
        >
      </details>
      <p v-if="run.auditStatus === 'failed'" class="agent-error"
        >完整审计写入本机失败；当前卡片记录仍在内存。</p
      >
      <el-button v-if="run.auditStatus === 'saved'" @click="saveAudit(run)"
        >保存完整本地审计</el-button
      >
      <AgentTaskSpec v-if="run.task" :task="run.task" />
      <p v-if="run.romCard" class="run-meta"
        >{{ run.romCard.entry === 'model-draft' ? '模型草拟，用户审阅确认' : '手动填写，用户确认' }}
        · 证据由浏览器本地工作流关联
        <template v-if="run.romCard.draft">
          · 草拟模型 {{ run.romCard.draft.model
          }}<template v-if="run.romCard.draft.request.reply?.response">
            · API 返回 {{ run.romCard.draft.request.reply.response.model }}</template
          >
        </template></p
      >
      <div v-if="run.completion" class="citation-list">
        <strong>本地完成检查 · {{ run.completion.state }}</strong>
        <p>已满足：{{ run.completion.satisfied.join('、') || '暂无' }}</p>
        <p>待满足或澄清：{{ run.completion.missing.join('、') || '无' }}</p>
        <p v-for="limitation in run.completion.limitations" :key="limitation">{{ limitation }}</p>
      </div>
      <ol v-if="run.steps.length" class="agent-steps"
        ><li v-for="(step, index) in run.steps" :key="index">{{ step }}</li></ol
      >
      <ul v-if="run.submissionGaps?.length" class="citation-list">
        <li v-for="(gap, i) in run.submissionGaps" :key="i">
          {{ gap.tool }} · {{ gap.labels.join(' / ') }} · {{ gap.reason }}
          <template v-if="gap.detail"> · {{ gap.detail }}</template>
        </li>
      </ul>
      <p v-if="run.message" class="run-message">{{ run.message }}</p>
      <div v-if="run.citations.length" class="citation-list"
        ><strong>{{
          run.romCard
            ? '本地工作流关联引用 · 值直接来自本地工具'
            : '已核验引用 · 值直接来自本地工具'
        }}</strong
        ><p v-for="(citation, i) in run.citations" :key="i">
          <a
            v-if="hasEvidenceCard(run, citation.callId)"
            :href="`#agent-evidence-${citation.callId}`"
            >{{ citation.callId }}</a
          >
          <span v-else>{{ citation.callId }}</span> {{ citation.path }} =
          {{ citation.value === null ? '缺失' : citation.value }}
        </p></div
      >
      <AgentEvidence
        v-for="call in evidenceCalls(run)"
        :key="call.id"
        :id="`agent-evidence-${call.id}`"
        :call="call"
        :source="run.reference"
        :disabled="invalid(run)"
        @locate="locate"
      />
      <AgentArtifact
        v-for="call in artifactCalls(run)"
        :key="call.id"
        :id="`agent-evidence-${call.id}`"
        :call="call"
        :run="run"
        :reported-models="reportedModels(run)"
        :stale="invalid(run)"
        :tools="tools"
        @export="emit('export', $event)"
        @locate="locate"
      />
      <details class="call-log"
        ><summary>实际调用记录（{{ run.calls.length }}）· 参数与结果</summary
        ><div v-for="call in run.calls" :key="call.id" class="call-record"
          ><strong
            >{{ call.id }} · {{ call.name }} · {{ call.output.ok ? '成功' : '已拒绝' }}</strong
          ><p>参数</p><pre>{{ JSON.stringify(call.arguments, null, 2) }}</pre
          ><p>真实返回</p><pre>{{ JSON.stringify(call.output, null, 2) }}</pre>
          <template v-if="call.evidenceCatalog">
            <p>本地引用目录 · 控制协议 {{ run.protocolVersion }}</p>
            <pre>{{ JSON.stringify(call.evidenceCatalog, null, 2) }}</pre>
          </template>
        </div></details
      >
    </article>
  </section>
</template>

<style scoped>
.agent-panel {
  display: grid;
  gap: 18px;
}
.goal-panel,
.run-panel,
.agent-source,
.agent-empty {
  padding: 24px;
}
.agent-source {
  padding-block: 16px;
}
.source-name {
  font-size: 14px;
  font-weight: 600;
  color: inherit;
  overflow-wrap: anywhere;
}
.agent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
h2 {
  font-size: 18px;
  margin-top: 5px;
}
h3 {
  font-size: 16px;
  overflow-wrap: anywhere;
}
p,
details {
  font-size: 12px;
  line-height: 1.9;
  color: var(--muted);
}
.connection-status,
.run-status {
  padding: 5px 10px;
  background: #f6eee0;
  border-radius: 5px;
  font-size: 12px;
  color: #8b6826;
}
.connected,
.completed {
  color: var(--success);
  background: #eaf6f0;
}
.connection-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
  margin: 20px 0 12px;
}
label {
  display: block;
  font-size: 12px;
  color: var(--text);
}
.connection-form label {
  flex: 1;
  min-width: 210px;
}
input,
select,
textarea {
  display: block;
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 7px;
  background: var(--surface);
  color: var(--ink);
  font-family: inherit;
  font-size: 13px;
}
textarea {
  resize: vertical;
}
.connection-note {
  color: var(--accent);
}
summary {
  cursor: pointer;
}
.goal-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0;
}
.goal-examples button {
  background: var(--accent-soft);
  padding: 7px 12px;
  font-size: 12px;
  border-radius: 5px;
  color: var(--accent);
}
.goal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.agent-model-picker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 240px;
  min-width: 0;
}
.agent-model-picker select {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}
.agent-key {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
  margin-top: 14px;
}
.agent-key label {
  flex: 1 1 220px;
  min-width: 0;
}
.agent-key-note {
  margin-top: 5px;
}
.model-guide {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--surface-muted);
  border-radius: 6px;
  font-size: 13px;
}
.model-guide summary {
  cursor: pointer;
  color: var(--ink);
}
.model-guide ol {
  margin: 8px 0 4px;
  padding-inline-start: 1.6em;
  line-height: 1.65;
}
.agent-model-settings {
  margin-top: 16px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  overflow-wrap: anywhere;
}
.goal-actions :deep(.el-button) {
  margin-left: 0;
}
.agent-error {
  color: #b34c40;
  margin-top: 14px;
}
.agent-empty {
  text-align: center;
  padding: 42px 24px;
}
.agent-empty p {
  margin-top: 10px;
}
.run-meta {
  font-size: 11px;
}
.agent-steps {
  font-size: 13px;
  line-height: 2;
  padding-left: 20px;
  background: var(--surface-muted);
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 5px;
}
.run-message {
  color: var(--ink);
  margin: 14px 0;
  white-space: pre-wrap;
}
.citation-list {
  font-size: 12px;
  background: var(--surface-muted);
  border-left: 3px solid var(--accent);
  padding: 12px 16px;
  overflow-wrap: anywhere;
}
.call-log {
  margin-top: 18px;
}
.call-record {
  margin-top: 15px;
}
pre {
  max-height: 280px;
  overflow: auto;
  background: var(--surface-muted);
  font-size: 11px;
  padding: 12px;
}
.stale-run {
  border-color: #d6b878;
}
.stale-run .run-message {
  color: #7c715a;
}
@media (max-width: 700px) {
  .goal-panel,
  .run-panel {
    padding: 16px;
  }
  .agent-model-picker {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
