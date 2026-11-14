import type { ModelProvider, ModelReply } from '../provider.ts';
import {
  localModelAddress,
  localModelId,
  localRequest,
  probeLocalTools,
  readLocalJSON,
} from './localModel.ts';
import { array, enumeration, object } from '../../analysis/schema.ts';

type ChatInput = Pick<Parameters<ModelProvider['complete']>[0], 'messages' | 'tools'>;

function callFormat(tools: ChatInput['tools']) {
  const format = (offered: ChatInput['tools'], maximum: number) =>
    object({
      calls: array(
        {
          anyOf: offered.map((tool) =>
            object({ tool: enumeration(tool.name), values: tool.inputSchema }),
          ),
        },
        1,
        maximum,
      ),
    });
  const finish = tools.filter((tool) => tool.name === 'finish_analysis');
  const working = tools.filter((tool) => tool.name !== 'finish_analysis');
  const declaring = working.every(({ name }) => ['set_task_spec', 'set_task_patch'].includes(name));
  if (!finish.length) return format(working, declaring ? 1 : 8);
  if (!working.length) return format(finish, 1);
  return { anyOf: [format(finish, 1), format(working, 8)] };
}
export function localOllamaURL(address: string): string {
  return localModelAddress(address);
}

function cloudOllamaModel(model: string) {
  return /(?:[:-]cloud)(?:$|:)/i.test(model);
}

export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama-local';
  readonly model: string;
  readonly toolMode?: 'constrained';
  private readonly baseURL: string;
  private readonly fetcher: typeof fetch;

  constructor(address: string, model: string, fetcher: typeof fetch = fetch, constrained = false) {
    this.baseURL = localOllamaURL(address);
    if (constrained) this.toolMode = 'constrained';
    const id = localModelId(model);
    if (!id || cloudOllamaModel(id)) throw new Error('请选择已安装的本地模型，不使用 cloud 模型。');
    this.model = id;
    // Browser fetch requires its Window receiver; storing it as an instance
    // method would otherwise call it with this=provider (Illegal invocation).
    this.fetcher = fetcher.bind(globalThis);
  }

  static forAgent(address: string, model: string) {
    return new OllamaProvider(address, model, fetch, true);
  }

  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await localRequest(this.baseURL, path, signal, this.fetcher, body);
    return readLocalJSON(response, 'OLLAMA');
  }

  static async models(address: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
    const provider = new OllamaProvider(address, 'discovery', fetcher);
    const data = await provider.request('/api/tags', signal);
    if (!Array.isArray(data?.models)) throw new Error('OLLAMA_INVALID_MODELS');
    const models = new Set<string>();
    for (const item of data.models) {
      const id = localModelId(item?.name) ?? localModelId(item?.model);
      if (id && !cloudOllamaModel(id) && !item.remote_host && !item.remote_model) models.add(id);
    }
    return [...models].slice(0, 100);
  }

  async checkConfiguration(signal: AbortSignal) {
    const details = await this.request('/api/show', signal, { model: this.model });
    if (details?.remote_host || details?.remote_model)
      throw new Error('不允许由本地服务转发至云模型。');
    if (!Array.isArray(details?.capabilities) || !details.capabilities.includes('tools'))
      throw new Error('模型未声明 tools 能力；请更新 Ollama 或选择支持结构化工具的本地模型。');
  }

  async probe(signal: AbortSignal) {
    await this.checkConfiguration(signal);
    return probeLocalTools(this, signal);
  }

  private chatBody({ messages, tools }: ChatInput) {
    const options = {
      model: this.model,
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: 16384, num_predict: 2048 },
    };
    if (this.toolMode === 'constrained') {
      const format = callFormat(tools);
      const transcript = messages.flatMap((message) => {
        if (message.role === 'assistant' && message.calls) return [];
        if (message.role === 'tool')
          return [{ role: 'user', content: `本地工具反馈：${message.content}` }];
        return [{ role: message.role, content: message.content }];
      });
      const instructionIndex =
        transcript.length - (tools.some((tool) => tool.name === 'set_task_patch') ? 1 : 0);
      transcript.splice(instructionIndex, 0, {
        role: 'user',
        content: `返回 JSON {"calls":[{"tool":"工具名称","values":{}}]}。可用工具：${JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))}`,
      });
      return {
        ...options,
        format,
        messages: transcript,
      };
    }
    return {
      ...options,
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

  requestBytes(input: ChatInput) {
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
    const calls =
      this.toolMode === 'constrained'
        ? this.constrainedCalls(data.message.content)
        : (data.message.tool_calls ?? []);
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

  private constrainedCalls(content: unknown) {
    try {
      if (typeof content !== 'string') return [];
      const decoded = JSON.parse(content);
      if (!Array.isArray(decoded?.calls)) return [];
      // Argument validation and rejection diagnostics belong to the runtime.
      return decoded.calls.map((item: { tool?: string; values?: unknown } | null) => ({
        function: { name: item?.tool, arguments: item?.values },
      }));
    } catch {
      return [];
    }
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
