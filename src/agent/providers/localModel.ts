import { ProviderResponseError } from '../provider.ts';
import type { ModelProvider } from '../provider.ts';

export type LocalProviderId = 'ollama' | 'local-openai';
export const localHosts = ['127.0.0.1', 'localhost', '[::1]'];
export const localInventoryPaths = ['/api/tags', '/api/ps', '/v1/models', '/api/v1/models'];
export const localPaths = [
  ...localInventoryPaths,
  '/api/show',
  '/api/chat',
  '/v1/chat/completions',
];
export const localReplyLimit = 1_000_000;
export const localModelRoute = '/__local-model';
let relayAvailable: boolean | undefined;

export function localModelAddress(value: string, compatible = false): string {
  const address = value.trim();
  const url = new URL(address.includes('://') ? address : `http://${address}`);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !localHosts.includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && !(compatible && ['/v1', '/v1/'].includes(url.pathname)))
  )
    throw new Error('请输入本机回环地址。');
  return url.origin;
}

export function localModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const model = value.trim();
  if (model && model.length <= 200 && !/[\s\p{Cc}]/u.test(model)) return model;
}

export async function localRequest(
  address: string,
  path: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  body?: unknown,
  token?: string,
) {
  const init: RequestInit = {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  };
  const canRelay =
    typeof location !== 'undefined' &&
    location.protocol === 'http:' &&
    localHosts.includes(location.hostname);
  const relay = async () => {
    const response = await fetcher(localModelRoute, {
      ...init,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ address, path, body }),
    });
    if (response.headers.get('X-Local-Model-Relay') === 'upstream') return response;
    await response.body?.cancel();
    throw new TypeError('Failed to fetch local model service');
  };
  if (body !== undefined && canRelay) {
    // The inventory and chat endpoints can have different CORS policies.
    // Discover the proxy before sending the model request, so inference runs only once.
    if (relayAvailable === undefined) {
      const response = await fetcher(localModelRoute, { ...init, cache: 'no-store' });
      relayAvailable = response.headers.get('X-Local-Model-Relay') === 'available';
      await response.body?.cancel();
    }
    if (relayAvailable) return relay();
  }
  try {
    return await fetcher(address + path, {
      ...init,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (error) {
    signal.throwIfAborted();
    // Only inventory reads are safe to retry after an ambiguous network error.
    if (!(error instanceof TypeError) || !canRelay || body !== undefined) throw error;
    return relay();
  }
}

export async function readLocalJSON(response: Response, prefix: string, token = ''): Promise<any> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let content = '';
  const failure = (code: string, truncated = false, detail = '') =>
    new ProviderResponseError(`${prefix}_${code}${detail ? `：${detail}` : ''}`, {
      httpStatus: response.status,
      responseText: token ? content.replaceAll(token, '[REDACTED]') : content,
      truncated,
    });
  if (!reader) throw failure(response.ok ? 'EMPTY_RESPONSE' : `HTTP_${response.status}`);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = localReplyLimit - size;
      size += chunk.value.byteLength;
      if (size > localReplyLimit) {
        content += decoder.decode(chunk.value.subarray(0, remaining));
        throw failure('RESPONSE_LIMIT', true);
      }
      content += decoder.decode(chunk.value, { stream: true });
    }
    content += decoder.decode();
    if (!response.ok)
      throw failure(
        `HTTP_${response.status}`,
        false,
        prefix === 'OLLAMA' ? content.slice(0, 2000) : '',
      );
    try {
      return JSON.parse(content);
    } catch (error) {
      throw failure(
        'INVALID_JSON',
        false,
        prefix === 'OLLAMA' && error instanceof Error ? error.message : '',
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function probeLocalTools(provider: ModelProvider, signal: AbortSignal) {
  const reply = await provider.complete({
    signal,
    messages: [
      { role: 'user', content: '连接测试：请仅调用 connection_check，参数 echo 为 kinetic。' },
    ],
    tools: [
      {
        name: 'connection_check',
        description: '验证结构化工具调用协议，不访问姿态数据。',
        inputSchema: {
          type: 'object',
          properties: { echo: { type: 'string', enum: ['kinetic'] } },
          required: ['echo'],
          additionalProperties: false,
        },
        outputSchema: { type: 'boolean' },
      },
    ],
  });
  const [call] = reply.calls;
  if (
    reply.calls.length !== 1 ||
    call.name !== 'connection_check' ||
    JSON.stringify(call.arguments) !== '{"echo":"kinetic"}'
  )
    throw new Error('LOCAL_TOOL_PROBE：模型未通过真实结构化工具探测。');
  return { usage: reply.usage, requests: 1, response: reply.response };
}
