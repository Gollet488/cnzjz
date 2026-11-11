import type { CloudModelConfig, CloudProviderId } from '../modelCatalog.ts';
import type { ModelProvider, ModelReply } from '../provider.ts';

export function modelError(error: unknown, local = false) {
  const code = error instanceof Error ? error.message : String(error);
  if (local) {
    if (code === 'NO_TOOL')
      return 'Ollama 模型未返回结构化工具调用。请在模型设置测试连接，或更换模型。';
    const reason = /Failed to fetch|NetworkError|timed out/.test(code)
      ? '无法连接本机 Ollama'
      : code;
    return `${reason}。请运行 ollama list 检查模型，确认 Ollama 已启动且允许当前页面来源，或更换模型。`;
  }
  if (/CONFIGURATION/.test(code)) return '模型配置已变化。请查看模型设置，刷新列表后重新选择。';
  if (/TASK_EXPIRED|TASK_CONFLICT/.test(code))
    return '本机代理的模型任务上下文已过期或发生冲突。请重新发送。';
  if (/CONTEXT_LIMIT/.test(code))
    return '任务反馈已达到模型请求大小上限。请缩小分析范围后重新发送。';
  if (/HTTP_(401|403)/.test(code))
    return '供应商拒绝了认证或模型权限。请检查模型设置中的密钥和账户权限。';
  if (/HTTP_404/.test(code)) return '供应商找不到此模型或接口。请检查模型 ID、端点与账户权限。';
  if (/HTTP_(402|429)/.test(code))
    return '供应商额度不足或触发了限流。请检查余额、配额，或稍后重试。';
  if (/HTTP_400/.test(code))
    return '供应商拒绝了请求。请确认所选模型支持当前接口及结构化工具调用。';
  if (/HTTP_5\d\d|TRANSPORT|PROXY_UNAVAILABLE|TIMEOUT|Failed to fetch/.test(code))
    return '连接供应商或本机 Node 代理失败。请检查网络和代理，或稍后重试。';
  if (/TOOL_PROBE|RESPONSE_PROTOCOL|INVALID_CALL|NO_TOOL|EMPTY_TOOL/.test(code))
    return '模型未返回可用的结构化工具调用。请在模型设置测试连接，或改选支持工具的模型。';
  return `${code}。可重试、在模型设置测试连接或更换模型。`;
}

async function request<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch('/__models/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'same-origin',
  });
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('CLOUD_PROXY_UNAVAILABLE');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'CLOUD_PROXY_UNAVAILABLE');
  return data;
}

export class CloudPageProvider implements ModelProvider {
  readonly id: string;
  private readonly task = crypto.randomUUID();

  constructor(
    private readonly kind: CloudProviderId,
    readonly model: string,
  ) {
    this.id = kind + '-api';
  }

  static catalog(signal: AbortSignal) {
    return request<{ envFile: string; providers: CloudModelConfig[] }>('catalog', {}, signal);
  }

  complete({ messages, tools, signal }: Parameters<ModelProvider['complete']>[0]) {
    return request<ModelReply>(
      'complete',
      {
        provider: this.kind,
        model: this.model,
        task: this.task,
        messages,
        tools,
      },
      signal,
    );
  }

  probe(signal: AbortSignal) {
    return request<{ response?: ModelReply['response'] }>(
      'probe',
      { provider: this.kind, model: this.model },
      signal,
    );
  }

  async release() {
    if (this.kind === 'openai')
      await request('release', { task: this.task }, AbortSignal.timeout(3000)).catch(() => {});
  }
}
