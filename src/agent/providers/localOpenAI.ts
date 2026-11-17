import type { ModelProvider, ModelReply } from '../provider.ts';
import { chatMessages } from './deepseek.ts';
import {
  localModelAddress,
  localModelId,
  localRequest,
  probeLocalTools,
  readLocalJSON,
} from './localModel.ts';

type ChatInput = Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>;

const compatibleOwners = new Map([
  ['llamacpp', 'llama.cpp'],
  ['vllm', 'vLLM'],
]);

async function lmStudioInventory(address: string, signal: AbortSignal, token: string) {
  try {
    const response = await localRequest(
      address,
      '/api/v1/models',
      AbortSignal.any([signal, AbortSignal.timeout(1200)]),
      fetch,
      undefined,
      token,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return;
    }
    const models: unknown = (await readLocalJSON(response, 'LOCAL_OPENAI', token))?.models;
    if (
      Array.isArray(models) &&
      models.every((item) => typeof item?.key === 'string' && Array.isArray(item.loaded_instances))
    )
      return models;
  } catch {
    signal.throwIfAborted();
  }
}

export class LocalOpenAIProvider implements ModelProvider {
  readonly id = 'local-openai-local';
  readonly model: string;
  private readonly address: string;

  constructor(
    address: string,
    model: string,
    private readonly token = '',
  ) {
    this.address = localModelAddress(address, true);
    const id = localModelId(model);
    if (!id || id === token) throw new Error('请输入有效的本地模型 ID。');
    this.model = id;
  }

  static async inventory(address: string, signal: AbortSignal, token = '') {
    const origin = localModelAddress(address, true);
    const response = await localRequest(origin, '/v1/models', signal, fetch, undefined, token);
    const data = await readLocalJSON(response, 'LOCAL_OPENAI', token);
    if (!Array.isArray(data?.data) || (data.object && data.object !== 'list'))
      throw new Error('LOCAL_OPENAI_INVALID_MODELS');
    const models = new Set<string>();
    const owners = new Set<string | undefined>();
    for (const item of data.data) {
      const id = localModelId(item?.id);
      if (id && id !== token && !item.remote_host && !item.remote_model) {
        models.add(id);
        owners.add(compatibleOwners.get(item.owned_by));
      }
    }
    let deployment = owners.size === 1 ? owners.values().next().value : undefined;
    if (!deployment) {
      const inventory = await lmStudioInventory(origin, signal, token);
      if (inventory) {
        deployment = 'LM Studio';
        for (const item of inventory) {
          if (item.type !== 'embedding') continue;
          models.delete(item.key);
          for (const instance of item.loaded_instances) models.delete(instance?.id);
        }
      }
    }
    return { deployment: deployment ?? 'OpenAI 兼容', models: [...models].slice(0, 100) };
  }

  private chatBody({ messages, tools }: ChatInput) {
    return {
      model: this.model,
      stream: false,
      temperature: 0,
      max_tokens: 2048,
      messages: chatMessages(messages),
      tools: tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
    };
  }

  requestBytes(input: ChatInput) {
    return new TextEncoder().encode(JSON.stringify(this.chatBody(input))).length;
  }

  async complete({
    messages,
    tools,
    signal,
  }: Parameters<ModelProvider['complete']>[0]): Promise<ModelReply> {
    const response = await localRequest(
      this.address,
      '/v1/chat/completions',
      signal,
      fetch,
      this.chatBody({ messages, tools }),
      this.token,
    );
    const data = await readLocalJSON(response, 'LOCAL_OPENAI', this.token);
    const choice =
      Array.isArray(data?.choices) && data.choices.length === 1 ? data.choices[0] : undefined;
    if (
      choice?.message?.role !== 'assistant' ||
      !['stop', 'tool_calls'].includes(choice.finish_reason)
    )
      throw new Error('LOCAL_OPENAI_INVALID_RESPONSE');
    const calls = choice.message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8) throw new Error('LOCAL_OPENAI_INVALID_CALLS');
    const tokens = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    return {
      calls: calls.map((call) => {
        const name = call?.function?.name;
        const args = call?.function?.arguments;
        if (
          call?.type !== 'function' ||
          typeof name !== 'string' ||
          !name.length ||
          name.length > 100
        )
          throw new Error('LOCAL_OPENAI_INVALID_CALL');
        let decoded: unknown;
        try {
          decoded = typeof args === 'string' ? JSON.parse(args) : args;
        } catch {
          throw new Error('LOCAL_OPENAI_INVALID_CALL_ARGUMENTS');
        }
        return {
          id: localModelId(call.id),
          name,
          arguments: decoded,
        };
      }),
      usage: {
        inputTokens: tokens(data.usage?.prompt_tokens),
        outputTokens: tokens(data.usage?.completion_tokens),
      },
      response: {
        id: typeof data.id === 'string' ? data.id : '',
        model: localModelId(data.model) ?? this.model,
        finishReason: choice.finish_reason,
        systemFingerprint:
          typeof data.system_fingerprint === 'string' ? data.system_fingerprint : null,
      },
    };
  }

  probe(signal: AbortSignal) {
    return probeLocalTools(this, signal);
  }
}
