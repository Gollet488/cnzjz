import type { ModelProvider, ModelReply } from '../provider.ts';

// Same-origin transport only. Credentials and the official API adapter stay in Node.
export class DeepSeekPageProvider implements ModelProvider {
  readonly id = 'deepseek-api';
  readonly model = 'deepseek-flash';
  private async request(path: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(`/__deepseek/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'DEEPSEEK_PROXY_UNAVAILABLE');
    return data;
  }
  async complete(input: Parameters<ModelProvider['complete']>[0]): Promise<ModelReply> {
    return this.request('complete', { messages: input.messages, tools: input.tools }, input.signal);
  }
  async probe(signal: AbortSignal) {
    return this.request('probe', {}, signal);
  }
}
