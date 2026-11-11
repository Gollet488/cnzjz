export const cloudProviders = {
  deepseek: { name: 'DeepSeek', prefix: 'DEEPSEEK' },
  openai: { name: 'OpenAI GPT', prefix: 'OPENAI' },
  anthropic: { name: 'Anthropic Claude', prefix: 'ANTHROPIC' },
  zhipu: { name: '智谱 GLM', prefix: 'ZHIPU' },
  moonshot: { name: 'Moonshot Kimi', prefix: 'MOONSHOT' },
} as const;

export type CloudProviderId = keyof typeof cloudProviders;
export type ProviderId = 'ollama' | CloudProviderId;
export interface CloudModelConfig {
  provider: CloudProviderId;
  models: string[];
  endpoint: string;
  missing: string[];
}
