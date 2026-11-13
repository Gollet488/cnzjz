import { chatMessages } from './deepseek.ts';
import type { ModelCall, ModelMessage, ModelProvider, ModelReply } from '../provider.ts';
import { ProviderResponseError } from '../provider.ts';
import { usesChatReasoning } from '../modelCatalog.ts';
import type { CloudProviderId } from '../modelCatalog.ts';

type Provider = Exclude<CloudProviderId, 'deepseek'>;
type Request = Parameters<ModelProvider['complete']>[0];
type Replay = { prefix: object[]; output: object[]; callIds: string[]; context: string };

function protocolError(): never {
  throw new Error('CLOUD_RESPONSE_PROTOCOL');
}

function call(name: unknown, args: unknown, id?: string): ModelCall {
  if (typeof name !== 'string' || !name.length || name.length > 100) protocolError();
  return { name, arguments: args, ...(id ? { id } : {}) };
}

function jsonArguments(args: unknown) {
  if (typeof args !== 'string') protocolError();
  try {
    return JSON.parse(args);
  } catch {
    protocolError();
  }
}

function tokens(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function chatArguments(kind: Provider, value: unknown) {
  if (kind === 'zhipu' && value && typeof value === 'object' && !Array.isArray(value)) return value;
  return jsonArguments(value);
}

function messagesForClaude(messages: ModelMessage[]) {
  const system: string[] = [];
  const turns: { role: 'user' | 'assistant'; content: object[] }[] = [];
  for (const m of chatMessages(messages)) {
    if (m.role === 'system') {
      system.push(m.content ?? '');
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: object[] = [];
    if ('tool_call_id' in m)
      blocks.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: m.content,
      });
    else {
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? [])
        blocks.push({
          type: 'tool_use',
          id: c.id,
          name: c.function.name,
          input: jsonArguments(c.function.arguments),
        });
    }
    if (!blocks.length) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  return { system: system.join('\n\n'), messages: turns };
}

// Node-only. Reasoning and native call IDs stay with the current task.
// Each follow-up preserves the exact previous input prefix and response items.
export class CloudApiProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly #key?: string;
  private readonly kind: Provider;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly chatReasoning: boolean;
  private replay?: Replay;

  constructor(options: {
    kind: Provider;
    model: string;
    endpoint: string;
    key?: string;
    fetcher?: typeof fetch;
  }) {
    this.kind = options.kind;
    this.id = options.kind + '-api';
    this.model = options.model;
    this.chatReasoning = usesChatReasoning(options.kind, options.model);
    this.endpoint = options.endpoint;
    this.#key = options.key;
    this.fetcher = options.fetcher ?? fetch;
  }

  private responseInput(messages: ModelMessage[], freshRequest: boolean) {
    const texts = messages.filter((m) => m.role === 'system' || m.role === 'user');
    const context = JSON.stringify(texts);
    const fresh = texts.map((m) => ({ role: m.role, content: m.content }));
    if (freshRequest || !this.replay) return { context, input: fresh };
    const results = new Map(
      messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]),
    );
    return {
      context,
      input: [
        ...this.replay.prefix,
        ...this.replay.output,
        ...this.replay.callIds.map((id) => {
          const output =
            results.get(id) ?? '{"ok":false,"omitted":"No local result in this round"}';
          return this.chatReasoning
            ? { role: 'tool', tool_call_id: id, content: output }
            : { type: 'function_call_output', call_id: id, output };
        }),
        // The system prompt is constant. Only append changes to task bindings
        // and any runtime correction, after all pending tool results.
        ...(this.replay.context === context ? [] : fresh.filter((m) => m.role === 'user')),
      ],
    };
  }

  private chatThinkingOptions() {
    if (!this.chatReasoning) return { thinking: { type: 'disabled' } };
    if (this.kind === 'zhipu')
      return { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'low' };
    return this.model.toLowerCase().startsWith('kimi-k3') ? { reasoning_effort: 'low' } : {};
  }

  complete(input: Request, key = this.#key): Promise<ModelReply> {
    return this.requestCompletion(input, key);
  }

  private async requestCompletion(
    { messages, tools, signal }: Request,
    key?: string,
    probe = false,
  ): Promise<ModelReply> {
    if (!key) throw new Error('CLOUD_CONFIGURATION');
    const responseInput =
      this.kind === 'openai' || this.chatReasoning
        ? this.responseInput(messages, probe)
        : undefined;
    const functions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const body = JSON.stringify({
      model: this.model,
      ...(this.kind === 'openai'
        ? {
            input: responseInput!.input,
            store: false,
            include: ['reasoning.encrypted_content'],
            max_output_tokens: 4096,
            ...(probe && { tool_choice: { type: 'function', name: 'connection_check' } }),
            tools: functions.map((fn) => ({ type: 'function', strict: false, ...fn })),
          }
        : this.kind === 'anthropic'
          ? {
              ...messagesForClaude(messages),
              max_tokens: 2048,
              tools: functions.map(({ parameters, ...fn }) => ({
                ...fn,
                input_schema: parameters,
              })),
            }
          : {
              messages: responseInput?.input ?? chatMessages(messages),
              max_tokens: this.chatReasoning ? 8192 : 2048,
              ...this.chatThinkingOptions(),
              tools: functions.map((fn) => ({ type: 'function', function: fn })),
              tool_choice: 'auto',
              stream: false,
            }),
    });
    if (Buffer.byteLength(body) > 512_000) throw new Error('CLOUD_CONTEXT_LIMIT');
    const auth: Record<string, string> =
      this.kind === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer ' + key };
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        redirect: 'error',
        body,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error('CLOUD_TRANSPORT', { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderResponseError('CLOUD_UPSTREAM_HTTP_' + response.status, {
        httpStatus: response.status,
        responseText: '',
        truncated: false,
      });
    }
    const reader = response.body?.getReader();
    if (!reader) protocolError();
    const decoder = new TextDecoder();
    let size = 0;
    let content = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1_000_000) throw new Error('CLOUD_RESPONSE_LIMIT');
        content += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === 'CLOUD_RESPONSE_LIMIT') throw error;
      throw new Error('CLOUD_TRANSPORT', { cause: error });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = jsonArguments((content + decoder.decode()).replaceAll(key, '[REDACTED]'));
    if (typeof data?.id !== 'string' || typeof data.model !== 'string') protocolError();
    let calls: ModelCall[];
    let reason: string;
    let output: object[] | undefined;
    if (this.kind === 'openai') {
      reason = data.status;
      if (reason !== 'completed' || !Array.isArray(data.output)) protocolError();
      calls = data.output
        .filter((item: any) => item?.type === 'function_call')
        .map((item: any) => {
          if (typeof item.call_id !== 'string' || !item.call_id.length || item.call_id.length > 200)
            protocolError();
          return call(item.name, jsonArguments(item.arguments), item.call_id);
        });
      output = data.output;
    } else if (this.kind === 'anthropic') {
      reason = data.stop_reason;
      if (!['tool_use', 'end_turn'].includes(reason) || !Array.isArray(data.content))
        protocolError();
      calls = data.content
        .filter((block: any) => block?.type === 'tool_use')
        .map((block: any) => {
          if (typeof block.id !== 'string' || !block.id.length || block.id.length > 200)
            protocolError();
          return call(block.name, block.input, block.id);
        });
    } else {
      const choice = data.choices?.[0];
      reason = choice?.finish_reason;
      const items = choice?.message?.tool_calls ?? [];
      if (
        data.choices?.length !== 1 ||
        !['tool_calls', 'stop'].includes(reason) ||
        choice?.message?.role !== 'assistant' ||
        !Array.isArray(items)
      )
        protocolError();
      calls = items.map((item: any) => {
        if (
          item?.type !== 'function' ||
          typeof item.id !== 'string' ||
          !item.id.length ||
          item.id.length > 200
        )
          protocolError();
        return call(
          item.function?.name,
          chatArguments(this.kind, item.function?.arguments),
          item.id,
        );
      });
      if (this.chatReasoning) output = [choice.message];
    }
    const callIds = calls.map((c) => c.id!);
    if (calls.length > 8 || new Set(callIds).size !== callIds.length) protocolError();
    if (!probe && responseInput && output) {
      this.replay = {
        context: responseInput.context,
        prefix: responseInput.input,
        output,
        callIds,
      };
    }
    return {
      calls,
      usage: {
        inputTokens: tokens(data.usage?.input_tokens ?? data.usage?.prompt_tokens),
        outputTokens: tokens(data.usage?.output_tokens ?? data.usage?.completion_tokens),
      },
      response: {
        id: data.id,
        model: data.model,
        finishReason: reason,
        systemFingerprint:
          typeof data.system_fingerprint === 'string' ? data.system_fingerprint : null,
      },
    };
  }

  async probe(signal: AbortSignal, key = this.#key) {
    const reply = await this.requestCompletion(
      {
        signal,
        messages: [
          { role: 'user', content: '连接测试：请仅调用 connection_check，参数 echo 为 kinetic。' },
        ],
        tools: [
          {
            name: 'connection_check',
            description: '验证结构化工具调用协议。',
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
      key,
      true,
    );
    if (
      reply.calls.length !== 1 ||
      reply.calls[0]?.name !== 'connection_check' ||
      JSON.stringify(reply.calls[0]?.arguments) !== '{"echo":"kinetic"}'
    )
      throw new Error('CLOUD_TOOL_PROBE_FAILED');
    return { requests: 1, response: reply.response, usage: reply.usage };
  }
}
