import type { CloudModelConfig, CloudProviderId } from '../modelCatalog.ts';
import { preservesCloudContext } from '../modelCatalog.ts';
import type { ModelProvider, ModelReply } from '../provider.ts';

export const cloudUnavailable =
  '当前站点未连接云端模型服务。请使用已部署该服务的 HTTPS 地址，或在本机运行 pnpm dev 后打开终端显示的地址。';

export function modelError(error: unknown, local = false) {
  const code = error instanceof Error ? error.message : String(error);
  const timedOut =
    (error instanceof Error && error.name === 'TimeoutError') || /TIMEOUT|timed out/i.test(code);
  if (local) {
    if (code === 'NO_TOOL')
      return 'Ollama 模型未返回结构化工具调用。请在模型设置测试连接，或更换模型。';
    const reason = timedOut
      ? '本机 Ollama 响应超时，首次载入大模型可能较慢'
      : /Failed to fetch|NetworkError/.test(code)
        ? '无法连接本机 Ollama'
        : code;
    return `${reason}。请运行 ollama list 检查模型，确认 Ollama 已启动且允许当前页面来源，或更换模型。`;
  }
  if (/PROXY_UNAVAILABLE|ORIGIN_REJECTED/.test(code)) return cloudUnavailable;
  if (/KEY_REQUIRED/.test(code)) return '请输入所选供应商的官方 API Key。';
  if (/CONFIGURATION|INVALID_INPUT/.test(code))
    return '模型配置不可用。请检查模型 ID、API Key 和服务配置中的官方端点，再刷新列表。';
  if (/TASK_LIMIT|PROXY_BUSY/.test(code)) return '模型服务请求较多，请稍后重试。';
  if (/TASK_EXPIRED|TASK_CONFLICT/.test(code))
    return '模型任务上下文已过期或发生冲突。请重新发送。';
  if (/CONTEXT_LIMIT/.test(code))
    return '任务反馈已达到模型请求大小上限。请缩小分析范围后重新发送。';
  if (/HTTP_(401|403)/.test(code)) return '供应商拒绝了认证或模型权限。请检查 API Key 和账户权限。';
  if (/HTTP_404/.test(code)) return '供应商找不到此模型或接口。请检查模型 ID、端点与账户权限。';
  if (/HTTP_402/.test(code)) return '供应商账户余额不足。请在供应商控制台检查 API 余额。';
  if (/HTTP_429/.test(code)) return '供应商触发限流或额度已用完。请检查 API 配额，或稍后重试。';
  if (/HTTP_(400|422)/.test(code))
    return '供应商拒绝了请求。请确认所选模型支持当前接口及结构化工具调用。';
  if (timedOut) return '等待模型响应超时。请检查网络后重试，或换用响应较快的模型。';
  if (/HTTP_5\d\d/.test(code)) return '供应商服务暂时不可用。请稍后重试或更换模型。';
  if (/TRANSPORT/.test(code)) return '模型服务无法连接供应商官方 API，请稍后重试。';
  if (/Failed to fetch|NetworkError/.test(code))
    return '浏览器无法连接云端模型服务。请检查网络并刷新页面。';
  if (/TOOL_PROBE|RESPONSE_PROTOCOL|INVALID_CALL|NO_TOOL|EMPTY_TOOL/.test(code))
    return '模型未返回可用的结构化工具调用。请在模型设置测试连接，或改选支持工具的模型。';
  return '模型请求未完成。可在模型设置测试连接、稍后重试或更换模型。';
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
  const data = await response.json().catch((error) => {
    signal.throwIfAborted();
    if (error instanceof SyntaxError) throw new Error('CLOUD_PROXY_UNAVAILABLE');
    throw error;
  });
  if (!response.ok)
    throw new Error(typeof data?.error === 'string' ? data.error : 'CLOUD_PROXY_UNAVAILABLE');
  return data;
}

interface TemporaryCredential {
  key: () => string;
  signal: AbortSignal;
}

export class CloudPageProvider implements ModelProvider {
  readonly id: string;
  private task = crypto.randomUUID();

  constructor(
    private readonly kind: CloudProviderId,
    readonly model: string,
    private readonly credential?: TemporaryCredential,
  ) {
    this.id = kind + '-api';
  }

  static catalog(signal: AbortSignal) {
    return request<{ envFile?: string; public?: boolean; providers: CloudModelConfig[] }>(
      'catalog',
      {},
      signal,
    );
  }

  private send<T>(path: string, body: object, signal: AbortSignal) {
    if (!this.credential) return request<T>(path, body, signal);
    this.credential.signal.throwIfAborted();
    return request<T>(
      path,
      { ...body, apiKey: this.credential.key() },
      AbortSignal.any([signal, this.credential.signal]),
    );
  }

  complete({ messages, tools, signal }: Parameters<ModelProvider['complete']>[0]) {
    return this.send<ModelReply>(
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

  async probe(signal: AbortSignal) {
    const result = await this.send<{
      requests: number;
      response: NonNullable<ModelReply['response']>;
    }>('probe', { provider: this.kind, model: this.model }, signal);
    if (result?.requests !== 1 || !result.response?.model)
      throw new Error('CLOUD_RESPONSE_PROTOCOL');
    return result;
  }

  async release() {
    if (preservesCloudContext(this.kind, this.model)) {
      const task = this.task;
      this.task = crypto.randomUUID();
      await request('release', { task }, AbortSignal.timeout(3000)).catch(() => {});
    }
  }
}
