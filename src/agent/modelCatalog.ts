export const cloudProviders = {
  deepseek: {
    name: 'DeepSeek',
    prefix: 'DEEPSEEK',
    presets: ['deepseek-flash', 'deepseek-v4-pro'],
    docs: 'https://api-docs.deepseek.com/quick_start/pricing/',
    keys: 'https://platform.deepseek.com/api_keys',
  },
  openai: {
    name: 'OpenAI GPT',
    prefix: 'OPENAI',
    presets: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.4-mini'],
    docs: 'https://developers.openai.com/api/docs/models',
    keys: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    name: 'Anthropic Claude',
    prefix: 'ANTHROPIC',
    presets: ['claude-sonnet-4-6'],
    docs: 'https://platform.claude.com/docs/en/models/overview',
    keys: 'https://platform.claude.com/settings/keys',
  },
  zhipu: {
    name: '智谱 GLM',
    prefix: 'ZHIPU',
    presets: ['glm-5.3', 'glm-5.2'],
    docs: 'https://docs.z.ai/guides/capabilities/thinking-mode',
    keys: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  moonshot: {
    name: 'Moonshot Kimi',
    prefix: 'MOONSHOT',
    presets: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.6'],
    docs: 'https://platform.kimi.ai/docs/guide/use-thinking-models',
    keys: 'https://platform.kimi.com/console/api-keys',
  },
} as const;

export const modelNotes: Readonly<Partial<Record<string, string>>> = {
  'deepseek-flash': 'V4.1 Flash 系列别名，适合常规任务。',
  'deepseek-v4-pro': 'V4 Pro 系列别名。',
  'gpt-6.1-sol': '能力与成本均衡，适合日常分析和多轮追问。',
  'gpt-6-luna': '成本优先，适合简单查询和批量使用。',
  'gpt-6.1-terra': '侧重速度与效率。',
  'gpt-6-astra': '旗舰模型，适合复杂指令与多步任务。',
  'glm-5.3': '使用官方低推理档位，保留本轮工具调用所需的思考上下文。',
  'kimi-k3.1-pro': '官方旗舰，使用低推理档位。',
  'kimi-k3': '使用官方低推理档位。',
};

export type CloudProviderId = keyof typeof cloudProviders;
export type ProviderId = 'ollama' | CloudProviderId;
export const cloudProviderIds = Object.keys(cloudProviders) as CloudProviderId[];
export const cloudModelId = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;
export const temporaryApiKeyFormat = /^[\x21\x23-\x5b\x5d-\x7e]{1,4096}$/;

export function usesChatReasoning(provider: string, model: string) {
  return (
    (provider === 'zhipu' && /^glm-5\.3(?:$|-)/i.test(model)) ||
    (provider === 'moonshot' && /^kimi-k(?:3(?:$|[.-])|2\.7-code(?:$|-))/i.test(model))
  );
}

export function preservesCloudContext(provider: string, model: string) {
  return provider === 'openai' || usesChatReasoning(provider, model);
}

export interface CloudModelConfig {
  provider: CloudProviderId;
  models: string[];
  endpoint: string;
  missing: string[];
}
