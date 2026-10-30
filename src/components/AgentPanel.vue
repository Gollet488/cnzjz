<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { AnalysisSession, SessionInfo } from '../analysis/session.ts';
import type { createToolRegistry } from '../analysis/tools.ts';
import { OllamaProvider } from '../agent/provider.ts';
import { DeepSeekPageProvider } from '../agent/providers/deepseekPage.ts';
import type { ModelReply } from '../agent/provider.ts';
import { AgentRuntime } from '../agent/runtime.ts';
import type { AgentRun } from '../agent/runtime.ts';
import AgentEvidence from './AgentEvidence.vue';
import AgentArtifact from './AgentArtifact.vue';
import AgentTaskSpec from './AgentTaskSpec.vue';
import type { CallRecord } from '../agent/runtime.ts';
import { readRunAudit, saveRunAudit } from '../agent/audit.ts';
import { download } from '../utils/download.ts';

const props = defineProps<{
  session: AnalysisSession;
  tools: ReturnType<typeof createToolRegistry>;
  info: SessionInfo;
  waitForApplication?: (run: AgentRun) => Promise<void>;
}>();
const emit = defineEmits<{ pause: []; export: [handle: string]; invalidateView: [] }>();
const address = ref('http://127.0.0.1:11434'),
  model = ref(''),
  models = ref<string[]>([]);
const providerKind = ref<'ollama' | 'deepseek'>('ollama');
const probeResponse = ref<{ model: string; systemFingerprint: string | null } | null>(null);
const connected = ref(false),
  connecting = ref(false),
  running = ref(false),
  connectionMessage = ref('未连接 · 真实模型验收未完成');
const goal = ref('比较前后各 5 秒的左右膝 ROM，并展示差异');
const runs = shallowRef<AgentRun[]>([]);
const responseMetadata = shallowRef<Record<string, NonNullable<ModelReply['response']>[]>>({});
const error = ref('');
const dismissedRuns = new Set<string>();
let runtime: AgentRuntime | undefined;
let connection: AbortController | undefined;
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
const range = computed(() =>
  props.info.range
    ? `${props.info.range[0].toFixed(2)}–${props.info.range[1].toFixed(2)} s`
    : '暂无采样',
);
const stale = (run: AgentRun) =>
  run.reference.sessionId !== props.info.sessionId ||
  run.reference.revision !== props.info.revision;
const invalid = (run: AgentRun) =>
  stale(run) || ['cancelled', 'stale', 'timeout'].includes(run.status);
const evidenceCalls = (run: AgentRun) =>
  run.calls.filter(
    (c) =>
      c.output.ok && ['get_quality_summary', 'query_metrics', 'compare_intervals'].includes(c.name),
  );
const artifactCalls = (run: AgentRun) =>
  run.calls.filter((c) => c.output.ok && ['prepare_report', 'prepare_export'].includes(c.name));
function locate(call: CallRecord, second = false, interval?: [number, number]) {
  if (!call.output.ok) return;
  const result = call.output.result as any;
  const metric =
    call.name === 'compare_intervals' ? (second ? result.second : result.first) : result;
  const ev = metric.evidence;
  const input = { sessionId: ev.sessionId, revision: ev.revision };
  const selectedInterval = interval ?? ev.interval;
  const outputs = [props.tools.execute('seek_to_time', { ...input, time: selectedInterval[0] })];
  if (metric.joint)
    outputs.push(
      props.tools.execute('set_chart_view', {
        ...input,
        interval: selectedInterval,
        basis: ev.basis,
        joint: metric.joint,
        channels: metric.channels.map((c: any) => c.channel),
      }),
    );
  const failed = outputs.find((o) => !o.ok);
  error.value = failed && !failed.ok ? failed.error.message : '';
  if (!failed) document.getElementById('agent-chart-view')?.scrollIntoView({ block: 'center' });
}
function disconnect() {
  connection?.abort();
  runtime?.clear();
  runtime = undefined;
  connected.value = false;
  probeResponse.value = null;
  connectionMessage.value = '未连接 · 请重新验证模型连接';
}
watch([address, model, providerKind], disconnect);
watch(
  () => [props.info.sessionId, props.info.revision],
  () => runtime?.invalidate(),
  { flush: 'sync' },
);

async function connect(discover = false) {
  if (connecting.value) return;
  disconnect();
  connecting.value = true;
  error.value = '';
  const controller = new AbortController();
  connection = controller;
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    if (discover) {
      const discovered = await OllamaProvider.models(address.value, controller.signal);
      if (controller.signal.aborted) return;
      models.value = discovered;
      connectionMessage.value = models.value.length
        ? '已读取本地模型，请选择并验证结构化工具连接。'
        : '服务中没有本地模型，请先安装支持 tools 的模型。';
      return;
    }
    const provider =
      providerKind.value === 'deepseek'
        ? new DeepSeekPageProvider()
        : new OllamaProvider(address.value, model.value);
    connectionMessage.value = '正在验证模型能力与真实结构化工具调用…';
    const probe = await provider.probe(controller.signal);
    if (provider instanceof DeepSeekPageProvider) probeResponse.value = probe.response;
    if (controller.signal.aborted) return;
    runtime = new AgentRuntime({
      provider,
      session: props.session,
      registry: props.tools,
      limits: providerKind.value === 'deepseek' ? { timeoutMs: 120_000 } : undefined,
      onAudit: async (audit) => {
        responseMetadata.value = {
          ...responseMetadata.value,
          [audit.run.id]: audit.requests.flatMap((r) =>
            r.reply?.response ? [r.reply.response] : [],
          ),
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
    connected.value = true;
    connectionMessage.value = `已连接 ${providerKind.value === 'deepseek' ? 'DeepSeek 官方 API（本机代理）' : 'Ollama'} / ${probeResponse.value?.model ?? provider.model} · 结构化调用探测通过；目标验收见实际运行结果`;
  } catch (e) {
    connectionMessage.value = '未连接 · 真实模型验收未完成';
    error.value = controller.signal.aborted
      ? '连接已取消或超时。'
      : `连接失败：${e instanceof Error ? e.message : '未知错误'}。请确认服务、模型、跨域权限及浏览器本地网络权限。`;
  } finally {
    clearTimeout(timer);
    connecting.value = false;
    if (connection === controller) connection = undefined;
  }
}
async function submit() {
  if (!runtime || !connected.value || running.value) return;
  const submission = { submittedAt: Date.now(), monotonicAt: performance.now() };
  const activeRuntime = runtime;
  running.value = true;
  emit('pause');
  await nextTick();
  error.value = '';
  try {
    await activeRuntime.run(goal.value, submission);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '任务启动失败';
  } finally {
    running.value = false;
  }
}
function clear() {
  for (const run of runs.value) if (run.status === 'running') dismissedRuns.add(run.id);
  runtime?.clear();
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
onBeforeUnmount(() => {
  connection?.abort();
  runtime?.clear();
});
</script>

<template>
  <section class="agent-panel">
    <div class="panel connection-panel">
      <div class="agent-header"
        ><div><span class="eyebrow">GOAL → TOOLS → EVIDENCE</span><h2>AI Agent 分析</h2></div
        ><span :class="['connection-status', { connected }]" role="status">{{
          connected ? '模型已连接' : '模型未连接'
        }}</span></div
      >
      <p
        >视频、画面、完整关键点与姿态推理留在浏览器。所选模型会收到用户指令和现有有界工具反馈。
        DeepSeek 通过本机回环代理连接官方 API，密钥仅由 Node 读取；Ollama 保留本地连接。
        意图仅存内存；完整工具与请求审计保存在本机浏览器 IndexedDB，不自动恢复为模型上下文。</p
      >
      <form class="connection-form" @submit.prevent="connect()">
        <label
          >模型服务<select
            v-model="providerKind"
            aria-label="模型服务"
            :disabled="connecting || running"
          >
            <option value="ollama">Ollama（本地）</option>
            <option value="deepseek">DeepSeek 官方 API（本机代理）</option>
          </select></label
        >
        <p v-if="providerKind === 'deepseek'"
          >deepseek-flash · thinking disabled · temperature 0 · max_tokens 2048 · stream false ·
          tool_choice auto</p
        >
        <label v-if="providerKind === 'ollama'"
          >本地 Ollama 地址<input
            v-model="address"
            :disabled="connecting || running"
            aria-label="本地 Ollama 地址"
            type="url"
            required
        /></label>
        <label v-if="providerKind === 'ollama'"
          >模型名<input
            v-model="model"
            :disabled="connecting || running"
            aria-label="模型名"
            list="ollama-models"
            placeholder="选择已安装且支持 tools 的模型"
            required
            maxlength="200" /><datalist id="ollama-models"
            ><option v-for="name in models" :key="name" :value="name" /></datalist
        ></label>
        <el-button
          v-if="providerKind === 'ollama'"
          :disabled="connecting || running"
          @click="connect(true)"
          >读取模型</el-button
        >
        <el-button
          type="primary"
          native-type="submit"
          :disabled="connecting || running || (providerKind === 'ollama' && !model.trim())"
          >验证并连接</el-button
        >
        <el-button v-if="connecting" @click="connection?.abort()">取消连接</el-button>
        <el-button v-if="connected && !running" @click="disconnect">断开</el-button>
      </form>
      <p class="connection-note" role="status">{{ connectionMessage }}</p>
      <p v-if="probeResponse"
        >连接探测实际返回 model={{ probeResponse.model }} · system_fingerprint={{
          probeResponse.systemFingerprint ?? '服务未提供，不能据此冻结权重'
        }}；探测不计业务请求。</p
      >
      <details
        ><summary>连接要求</summary
        ><p
          >DeepSeek 需使用此项目的本机开发或生产预览服务，并在 Windows 用户环境或 Node 进程配置
          DEEPSEEK_API_KEY；页面不接收密钥。静态托管不包含代理。 Ollama
          服务需在此电脑运行，并声明模型 tools 能力。跨域受限时，在 Ollama 的 OLLAMA_ORIGINS
          中允许当前页面的精确来源后重启服务。连接验证只发送测试文本，不发送会话数据；本页不自动安装或下载模型。</p
        ></details
      >
    </div>

    <div class="panel goal-panel">
      <div class="agent-header"
        ><h2>让工具完成分析目标</h2
        ><span
          >{{ info.synthetic ? 'SYNTHETIC · 合成演示' : '本地采集' }} · {{ info.sampleCount }} 帧 ·
          {{ range }}</span
        ></div
      >
      <p
        >分析时自动暂停采集。支持接续修改区间或侧别；改变会话版本后重新取数。可定位图表、准备报告和
        CSV，成果卡保存文件；只分析不会下载。</p
      >
      <div class="goal-examples"
        ><button :disabled="running" @click="goal = '比较前后各 5 秒的左右膝 ROM，并展示差异'"
          >比较左右膝 ROM</button
        ><button
          :disabled="running"
          @click="goal = '哪些区间不适合比较？请查询整个已采样区间的质量与缺失情况'"
          >查询区间质量</button
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
        ><textarea
          id="agent-goal"
          v-model="goal"
          :disabled="running"
          maxlength="2000"
          rows="3"
        /><div class="goal-actions"
          ><span
            >每次最多 12 轮 / 24 次调用 / 3 次纠错 · 请求 60 秒 / 总计
            {{ providerKind === 'deepseek' ? '2' : '4' }} 分钟</span
          ><el-button :disabled="running || !runs.length" @click="clear">清空上下文</el-button
          ><el-button v-if="running" type="danger" @click="runtime?.cancel()">取消分析</el-button
          ><el-button
            v-else
            type="primary"
            native-type="submit"
            :disabled="!connected || !goal.trim()"
            >执行目标</el-button
          ></div
        ></form
      >
      <p v-if="error" class="agent-error" role="alert">{{ error }}</p>
    </div>

    <slot />
    <div v-if="!runs.length" class="agent-empty panel"
      ><h3>分析结果将包含可复核的本地证据</h3
      ><p
        >连接模型并执行目标后，在这里查看步骤、实际调用、区间比较表、质量区间与数值引用。未连接时不生成模拟回答。</p
      ></div
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
        >{{ run.provider }} / {{ run.model }} · {{ run.rounds }} 轮 · {{ run.calls.length }} 次调用
        · {{ (run.elapsedMs / 1000).toFixed(1) }} s<template v-if="run.usage.reportedRequests">
          · API 已报告 token：输入 {{ run.usage.inputTokens ?? '未提供' }} / 输出
          {{ run.usage.outputTokens ?? '未提供' }}（{{
            run.usage.reportedRequests
          }}
          个请求）</template
        ></p
      >
      <p v-if="run.status === 'running'" role="status">{{ run.phase }}</p>
      <p v-if="run.conversationCosts" class="run-meta">
        本场累计（自最近清空或连接起）：{{ run.conversationCosts.turns }} 次用户目标 /
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
      <div v-if="run.completion" class="citation-list">
        <strong>本地完成检查 · {{ run.completion.state }}</strong>
        <p>已满足：{{ run.completion.satisfied.join('、') || '暂无' }}</p>
        <p>待满足或澄清：{{ run.completion.missing.join('、') || '无' }}</p>
        <p v-for="limitation in run.completion.limitations" :key="limitation">{{ limitation }}</p>
      </div>
      <ol v-if="run.steps.length" class="agent-steps"
        ><li v-for="(step, index) in run.steps" :key="index">{{ step }}</li></ol
      >
      <p v-if="run.message" class="run-message">{{ run.message }}</p>
      <div v-if="run.citations.length" class="citation-list"
        ><strong>已核验引用 · 值直接来自本地工具</strong
        ><p v-for="(citation, i) in run.citations" :key="i"
          >{{ citation.callId }} {{ citation.path }} =
          {{ citation.value === null ? '缺失' : citation.value }}</p
        ></div
      >
      <AgentEvidence
        v-for="call in evidenceCalls(run)"
        :key="call.id"
        :call="call"
        :disabled="invalid(run)"
        @locate="locate"
      />
      <AgentArtifact
        v-for="call in artifactCalls(run)"
        :key="call.id"
        :call="call"
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
.connection-panel,
.goal-panel,
.run-panel,
.agent-empty {
  padding: 24px;
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
  color: #667d71;
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
  color: var(--green);
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
  color: #456353;
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
  border: 1px solid #dce6df;
  border-radius: 6px;
  padding: 10px 12px;
  margin-top: 7px;
  background: #fcfdfc;
  color: #243932;
  font-family: inherit;
  font-size: 13px;
}
textarea {
  resize: vertical;
}
.connection-note {
  color: var(--green);
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
  background: #edf5f0;
  padding: 7px 12px;
  font-size: 12px;
  border-radius: 5px;
  color: var(--green);
}
.goal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.goal-actions span {
  flex: 1;
  font-size: 11px;
  color: #81958a;
  min-width: 240px;
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
  background: #f5f9f6;
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 5px;
}
.run-message {
  color: #294d39;
  margin: 14px 0;
  white-space: pre-wrap;
}
.citation-list {
  font-size: 12px;
  background: #f1f7f3;
  border-left: 3px solid var(--green);
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
  background: #f4f7f5;
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
  .connection-panel,
  .goal-panel,
  .run-panel {
    padding: 16px;
  }
  .goal-actions span {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
