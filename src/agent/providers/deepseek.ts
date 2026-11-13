import type { ModelMessage, ModelProvider, ModelReply } from '../provider.ts';
import { ProviderResponseError } from '../provider.ts';

// Node-only official adapter; the browser uses the credential-free page transport.
export const DEEPSEEK_ADDRESS = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_INFERENCE = {
  stream: false,
  thinking: { type: 'disabled' },
  temperature: 0,
  max_tokens: 2048,
  tool_choice: 'auto',
} as const;

type DeepSeekFailureStage = 'configuration' | 'request' | 'transport' | 'response' | 'probe';

export class DeepSeekRequestError extends Error {
  readonly stage: DeepSeekFailureStage;
  constructor(stage: DeepSeekFailureStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

export function chatMessages(messages: ModelMessage[]) {
  let pending: { id: string; nativeId?: string; name: string }[] = [];
  const used = new Set<string>();
  const result = messages.map((message, index) => {
    if (message.role === 'tool') {
      const match = pending.findIndex((call) =>
        message.toolCallId ? call.nativeId === message.toolCallId : call.name === message.toolName,
      );
      if (match < 0) throw new DeepSeekRequestError('request', 'DEEPSEEK_ORPHAN_TOOL_RESULT');
      const [call] = pending.splice(match, 1);
      return { role: 'tool', content: message.content, tool_call_id: call!.id };
    }
    if (pending.length) throw new DeepSeekRequestError('request', 'DEEPSEEK_MISSING_TOOL_RESULT');
    if (message.calls?.length) {
      if (message.role !== 'assistant')
        throw new DeepSeekRequestError('request', 'DEEPSEEK_INVALID_HISTORY_ROLE');
      // Some Chat Completions services reuse IDs in separate response batches.
      // Keep native IDs when unique in the compact projection.
      pending = message.calls.map((call, callIndex) => {
        let id = call.id ?? `call_${index}_${callIndex}`;
        while (used.has(id)) id = `p_${id}`;
        used.add(id);
        return { id, nativeId: call.id, name: call.name };
      });
      return {
        role: message.role,
        content: message.content || null,
        tool_calls: message.calls.map((call, callIndex) => ({
          id: pending[callIndex]!.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
  if (pending.length) throw new DeepSeekRequestError('request', 'DEEPSEEK_MISSING_TOOL_RESULT');
  return result;
}

export class DeepSeekProvider implements ModelProvider {
  readonly id = 'deepseek-api';
  readonly model: string;
  #apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, model = DEEPSEEK_MODEL, fetcher: typeof fetch = fetch) {
    if (!apiKey?.trim())
      throw new DeepSeekRequestError('configuration', 'DEEPSEEK_API_KEY_REQUIRED');
    if (/\s/.test(apiKey))
      throw new DeepSeekRequestError('configuration', 'DEEPSEEK_API_KEY_INVALID');
    this.#apiKey = apiKey;
    this.model = model.trim();
    if (!this.model || this.model.length > 200) throw new Error('DEEPSEEK_MODEL_REQUIRED');
    this.fetcher = fetcher.bind(globalThis);
  }

  private chatBody(
    input: Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>,
    probe: boolean,
  ) {
    return {
      model: this.model,
      ...DEEPSEEK_INFERENCE,
      ...(probe && { tool_choice: { type: 'function', function: { name: 'connection_check' } } }),
      messages: chatMessages(input.messages),
      tools: input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    };
  }

  requestBytes(input: Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>) {
    return new TextEncoder().encode(JSON.stringify(this.chatBody(input, false))).length;
  }

  private async readResponse(response: Response): Promise<any> {
    let content = '',
      size = 0,
      truncated = false;
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const remaining = 1_000_000 - size;
          size += chunk.value.byteLength;
          if (size > 1_000_000) {
            content += decoder.decode(chunk.value.subarray(0, remaining));
            truncated = true;
            break;
          }
          content += decoder.decode(chunk.value, { stream: true });
        }
        content += decoder.decode();
      } catch {
        if (response.ok)
          throw new DeepSeekRequestError('transport', 'DEEPSEEK_RESPONSE_READ_FAILED');
        // A failed error-body stream does not erase the HTTP status already received.
        truncated = true;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    // HTTP services may echo submitted credentials in error diagnostics. Keep
    // only a redacted body, never headers, in the shared failure audit.
    content = content.replaceAll(this.#apiKey, '[REDACTED]');
    const failure = { httpStatus: response.status, responseText: content, truncated };
    if (!response.ok) throw new ProviderResponseError(`DEEPSEEK_HTTP_${response.status}`, failure);
    if (truncated) throw new ProviderResponseError('DEEPSEEK_RESPONSE_LIMIT', failure);
    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderResponseError('DEEPSEEK_INVALID_JSON', failure);
    }
  }

  complete(input: Parameters<ModelProvider['complete']>[0]): Promise<ModelReply> {
    return this.requestCompletion(input);
  }

  private async requestCompletion(
    input: Parameters<ModelProvider['complete']>[0],
    probe = false,
  ): Promise<ModelReply> {
    const body = JSON.stringify(this.chatBody(input, probe));
    const request: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#apiKey}` },
      body,
      signal: input.signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    };
    let response;
    try {
      response = await this.fetcher(`${DEEPSEEK_ADDRESS}/chat/completions`, request);
    } catch {
      input.signal.throwIfAborted();
      throw new DeepSeekRequestError('transport', 'DEEPSEEK_FETCH_FAILED');
    }
    const data = await this.readResponse(response);
    if (
      typeof data?.id !== 'string' ||
      typeof data.model !== 'string' ||
      !Array.isArray(data.choices) ||
      data.choices.length !== 1 ||
      data.choices[0]?.message?.role !== 'assistant'
    )
      throw new DeepSeekRequestError('response', 'DEEPSEEK_INVALID_RESPONSE');
    const choice = data.choices[0];
    if (!['tool_calls', 'stop'].includes(choice.finish_reason))
      throw new DeepSeekRequestError('response', 'DEEPSEEK_INCOMPLETE_RESPONSE');
    const calls = choice.message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8)
      throw new DeepSeekRequestError('response', 'DEEPSEEK_CALL_BATCH_LIMIT');
    const tokens = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    return {
      calls: calls.map((call: any) => {
        if (
          call?.type !== 'function' ||
          typeof call.id !== 'string' ||
          typeof call.function?.name !== 'string' ||
          !call.function.name.length ||
          call.function.name.length > 100 ||
          typeof call.function.arguments !== 'string'
        )
          throw new DeepSeekRequestError('response', 'DEEPSEEK_INVALID_CALL');
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          throw new DeepSeekRequestError('response', 'DEEPSEEK_INVALID_CALL_ARGUMENTS');
        }
        return { name: call.function.name, arguments: args };
      }),
      usage: {
        inputTokens: tokens(data.usage?.prompt_tokens),
        outputTokens: tokens(data.usage?.completion_tokens),
      },
      response: {
        id: data.id,
        model: data.model,
        systemFingerprint:
          typeof data.system_fingerprint === 'string' ? data.system_fingerprint : null,
        finishReason: choice.finish_reason,
      },
    };
  }

  async probe(signal: AbortSignal) {
    const reply = await this.requestCompletion(
      {
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
      },
      true,
    );
    if (
      reply.calls.length !== 1 ||
      reply.calls[0]!.name !== 'connection_check' ||
      JSON.stringify(reply.calls[0]!.arguments) !== '{"echo":"kinetic"}'
    )
      throw new DeepSeekRequestError('probe', 'DEEPSEEK_TOOL_PROBE_FAILED');
    return { usage: reply.usage, requests: 1, response: reply.response };
  }
}
