import type { ToolDefinition } from '../analysis/tools.ts';

export interface ModelCall {
  id?: string;
  name: string;
  arguments: unknown;
}
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ModelCall[];
  toolName?: string;
  toolCallId?: string;
}
export interface ModelReply {
  calls: ModelCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  response?: {
    id: string;
    model: string;
    systemFingerprint: string | null;
    finishReason: string;
  };
}
export interface ProviderFailure {
  httpStatus: number;
  responseText: string;
  truncated: boolean;
}
// Preserve wire failures for local audit only. They are not model/tool facts.
export class ProviderResponseError extends Error {
  readonly failure: ProviderFailure;
  constructor(message: string, failure: ProviderFailure) {
    super(message);
    this.name = 'ProviderResponseError';
    this.failure = failure;
  }
}
// Providers translate wire formats only. They never execute a model's commands.
export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly toolMode?: 'constrained';
  // Exact UTF-8 JSON body size, when the adapter exposes its wire encoding.
  requestBytes?(request: { messages: ModelMessage[]; tools: ToolDefinition[] }): number;
  complete(request: {
    messages: ModelMessage[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): Promise<ModelReply>;
}

// Providers may ignore abort signals. Stop waiting and discard late replies.
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new Error(String(signal.reason)));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

// Stable compatibility entry.
export { OllamaProvider, localOllamaURL } from './providers/ollama.ts';
