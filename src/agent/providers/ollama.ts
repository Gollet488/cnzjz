import type { ModelProvider, ModelReply } from '../provider.ts';
import { ProviderResponseError } from '../provider.ts';
export function localOllamaURL(address: string): string {
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      '仅支持本机 Ollama 根地址，例如 http://127.0.0.1:11434；不接受凭据或任意路径。',
    );
  return url.origin;
}

async function readJSON(response: Response): Promise<any> {
  if (!response.body)
    throw new ProviderResponseError(
      response.ok ? 'OLLAMA_EMPTY_RESPONSE' : `OLLAMA_HTTP_${response.status}`,
      { httpStatus: response.status, responseText: '', truncated: false },
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    content = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = 1_000_000 - size;
      size += chunk.value.byteLength;
      if (size > 1_000_000) {
        content += decoder.decode(chunk.value.subarray(0, remaining));
        throw new ProviderResponseError('OLLAMA_RESPONSE_LIMIT', {
          httpStatus: response.status,
          responseText: content,
          truncated: true,
        });
      }
      content += decoder.decode(chunk.value, { stream: true });
    }
    content += decoder.decode();
    const failure = { httpStatus: response.status, responseText: content, truncated: false };
    if (!response.ok)
      throw new ProviderResponseError(
        `OLLAMA_HTTP_${response.status}：${content.slice(0, 2000)}`,
        failure,
      );
    try {
      return JSON.parse(content);
    } catch (error) {
      throw new ProviderResponseError(
        `OLLAMA_INVALID_JSON：${error instanceof Error ? error.message : 'JSON_PARSE_FAILED'}`,
        failure,
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama-local';
  readonly model: string;
  private readonly baseURL: string;
  private readonly fetcher: typeof fetch;

  constructor(address: string, model: string, fetcher: typeof fetch = fetch) {
    this.baseURL = localOllamaURL(address);
    this.model = model.trim();
    if (!this.model || this.model.length > 200 || /cloud/i.test(this.model))
      throw new Error('请选择已安装的本地模型，不使用 cloud 模型。');
    // Browser fetch requires its Window receiver; storing it as an instance
    // method would otherwise call it with this=provider (Illegal invocation).
    this.fetcher = fetcher.bind(globalThis);
  }

  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await this.fetcher(this.baseURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    return readJSON(response);
  }

  static async models(address: string, signal: AbortSignal): Promise<string[]> {
    const provider = new OllamaProvider(address, 'discovery');
    const data = await provider.request('/api/tags', signal);
    if (!Array.isArray(data.models)) throw new Error('OLLAMA_INVALID_MODELS');
    return data.models
      .slice(0, 100)
      .flatMap((m: any) => (typeof m.name === 'string' && !/cloud/i.test(m.name) ? [m.name] : []));
  }

  async probe(signal: AbortSignal): Promise<{ usage: ModelReply['usage']; requests: number }> {
    const details = await this.request('/api/show', signal, { model: this.model });
    if (details.remote_host || details.remote_model)
      throw new Error('不允许由本地服务转发至云模型。');
    if (!Array.isArray(details.capabilities) || !details.capabilities.includes('tools'))
      throw new Error('模型未声明 tools 能力；请更新 Ollama 或选择支持结构化工具的本地模型。');
    // Capability metadata alone is insufficient: verify a real structured call.
    const reply = await this.complete({
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
    if (
      reply.calls.length !== 1 ||
      reply.calls[0].name !== 'connection_check' ||
      JSON.stringify(reply.calls[0].arguments) !== '{"echo":"kinetic"}'
    )
      throw new Error('模型未通过真实结构化工具探测；未连接。');
    return { usage: reply.usage, requests: 1 };
  }

  private chatBody({
    messages,
    tools,
  }: Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>) {
    return {
      model: this.model,
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 16384, num_predict: 2048 },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolName ? { tool_name: m.toolName } : {}),
        ...(m.calls
          ? {
              tool_calls: m.calls.map((c, index) => ({
                type: 'function',
                function: { index, name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      })),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    };
  }

  requestBytes(input: Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>) {
    return new TextEncoder().encode(JSON.stringify(this.chatBody(input))).length;
  }

  async complete({
    messages,
    tools,
    signal,
  }: Parameters<ModelProvider['complete']>[0]): Promise<ModelReply> {
    const data = await this.request('/api/chat', signal, this.chatBody({ messages, tools }));
    if (
      !data.done ||
      data.message?.role !== 'assistant' ||
      (data.message.tool_calls !== undefined && !Array.isArray(data.message.tool_calls))
    )
      throw new Error('OLLAMA_INVALID_RESPONSE');
    const calls = data.message.tool_calls ?? [];
    if (calls.length > 8) throw new Error('OLLAMA_CALL_BATCH_LIMIT');
    // Neither thinking nor unverified free text enters UI or conversation history.
    return {
      calls: calls.map((c: any) => {
        if (typeof c.function?.name !== 'string' || c.function.name.length > 100)
          throw new Error('OLLAMA_INVALID_CALL');
        return { name: c.function.name, arguments: c.function.arguments };
      }),
      usage: {
        inputTokens:
          Number.isInteger(data.prompt_eval_count) && data.prompt_eval_count >= 0
            ? data.prompt_eval_count
            : undefined,
        outputTokens:
          Number.isInteger(data.eval_count) && data.eval_count >= 0 ? data.eval_count : undefined,
      },
    };
  }

  // Evaluation baseline only: bounded text is saved as evidence, never rendered
  // as a verified Agent answer and never executed as a tool or URL.
  async summarizeOnce(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    signal: AbortSignal,
  ) {
    const data = await this.request('/api/chat', signal, {
      model: this.model,
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 16384, num_predict: 2048 },
      messages,
    });
    if (
      !data.done ||
      data.message?.role !== 'assistant' ||
      typeof data.message.content !== 'string' ||
      data.message.content.length > 20_000
    )
      throw new Error('OLLAMA_INVALID_SUMMARY');
    return {
      text: data.message.content,
      usage: {
        inputTokens:
          Number.isInteger(data.prompt_eval_count) && data.prompt_eval_count >= 0
            ? data.prompt_eval_count
            : null,
        outputTokens:
          Number.isInteger(data.eval_count) && data.eval_count >= 0 ? data.eval_count : null,
      },
    };
  }
}
