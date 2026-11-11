import { chatMessages } from './deepseek.ts';
import type { ModelCall, ModelMessage, ModelProvider, ModelReply } from '../provider.ts';
import { ProviderResponseError } from '../provider.ts';
import type { CloudProviderId } from '../modelCatalog.ts';

type Provider = Exclude<CloudProviderId, 'deepseek'>;
type Request = Parameters<ModelProvider['complete']>[0];

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

// Node-only. Responses reasoning and native call IDs stay with the current task.
// Each follow-up preserves the exact previous input prefix and response items.
export class CloudApiProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly #key: string;
  private readonly kind: Provider;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private openai?: { prefix: object[]; output: object[]; callIds: string[]; context: string };

  constructor(options: {
    kind: Provider;
    model: string;
    endpoint: string;
    key: string;
    fetcher?: typeof fetch;
  }) {
    this.kind = options.kind;
    this.id = options.kind + '-api';
    this.model = options.model;
    this.endpoint = options.endpoint;
    this.#key = options.key;
    this.fetcher = options.fetcher ?? fetch;
  }

  private responseInput(messages: ModelMessage[]) {
    const texts = messages.filter((m) => m.role === 'system' || m.role === 'user');
    const context = JSON.stringify(texts);
    const fresh = texts.map((m) => ({ role: m.role, content: m.content }));
    if (!this.openai) return { context, input: fresh };
    const results = new Map(
      messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]),
    );
    return {
      context,
      input: [
        ...this.openai.prefix,
        ...this.openai.output,
        ...this.openai.callIds.map((id) => ({
          type: 'function_call_output',
          call_id: id,
          output: results.get(id) ?? '{"ok":false,"omitted":"No local result in this round"}',
        })),
        // The system prompt is constant. Only append changes to task bindings
        // and any runtime correction, after all pending tool results.
        ...(this.openai.context === context ? [] : fresh.filter((m) => m.role === 'user')),
      ],
    };
  }

  async complete({ messages, tools, signal }: Request): Promise<ModelReply> {
    const responseInput = this.kind === 'openai' ? this.responseInput(messages) : undefined;
    const functions = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    const body = JSON.stringify({
      model: this.model,
      ...(responseInput
        ? {
            input: responseInput.input,
            store: false,
            include: ['reasoning.encrypted_content'],
            max_output_tokens: 4096,
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
              messages: chatMessages(messages),
              max_tokens: 2048,
              thinking: { type: 'disabled' },
              tools: functions.map((fn) => ({ type: 'function', function: fn })),
              tool_choice: 'auto',
              stream: false,
            }),
    });
    if (Buffer.byteLength(body) > 512_000) throw new Error('CLOUD_CONTEXT_LIMIT');
    const auth: Record<string, string> =
      this.kind === 'anthropic'
        ? { 'x-api-key': this.#key, 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer ' + this.#key };
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        redirect: 'error',
        body,
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('CLOUD_TRANSPORT');
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
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = jsonArguments((content + decoder.decode()).replaceAll(this.#key, '[REDACTED]'));
    if (typeof data?.id !== 'string' || typeof data.model !== 'string') protocolError();
    let calls: ModelCall[];
    let reason: string;
    if (responseInput) {
      reason = data.status;
      if (reason !== 'completed' || !Array.isArray(data.output)) protocolError();
      calls = data.output
        .filter((item: any) => item?.type === 'function_call')
        .map((item: any) => {
          if (typeof item.call_id !== 'string' || !item.call_id.length || item.call_id.length > 200)
            protocolError();
          return call(item.name, jsonArguments(item.arguments), item.call_id);
        });
      const callIds = calls.map((c) => c.id!);
      if (new Set(callIds).size !== callIds.length || calls.length > 8) protocolError();
      this.openai = {
        context: responseInput.context,
        prefix: responseInput.input,
        output: data.output,
        callIds,
      };
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
    }
    if (calls.length > 8) protocolError();
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

  async probe(signal: AbortSignal) {
    const reply = await this.complete({
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
    });
    if (
      reply.calls.length !== 1 ||
      reply.calls[0]?.name !== 'connection_check' ||
      JSON.stringify(reply.calls[0]?.arguments) !== '{"echo":"kinetic"}'
    )
      throw new Error('CLOUD_TOOL_PROBE_FAILED');
    return { requests: 1, response: reply.response, usage: reply.usage };
  }
}
