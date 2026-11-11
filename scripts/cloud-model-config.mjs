import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { cloudProviders } from '../src/agent/modelCatalog.ts';
import {
  DeepSeekProvider,
  DEEPSEEK_ADDRESS,
  DEEPSEEK_MODEL,
} from '../src/agent/providers/deepseek.ts';
import { CloudApiProvider } from '../src/agent/providers/cloudApi.ts';

const endpoints = {
  deepseek: [DEEPSEEK_ADDRESS + '/chat/completions'],
  openai: ['https://api.openai.com/v1/responses'],
  anthropic: ['https://api.anthropic.com/v1/messages'],
  zhipu: [
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://api.z.ai/api/paas/v4/chat/completions',
  ],
  moonshot: [
    'https://api.moonshot.cn/v1/chat/completions',
    'https://api.moonshot.ai/v1/chat/completions',
  ],
};
const modelId = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;

export function cloudConfiguration(
  root,
  fallbackDeepSeekKey = () => '',
  environment = process.env,
) {
  const envFile = resolve(root, '.env');
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const env = { ...file, ...environment };
  const configs = Object.entries(cloudProviders).map(([provider, { prefix }]) => {
    const keyName = prefix + '_API_KEY';
    const modelsName = prefix + '_MODELS';
    const endpointName = prefix + '_ENDPOINT';
    const key = (env[keyName] ?? (provider === 'deepseek' ? fallbackDeepSeekKey() : '')).trim();
    const configured = env[modelsName]?.trim() || (provider === 'deepseek' ? DEEPSEEK_MODEL : '');
    const ids = configured.split(',').map((id) => id.trim());
    const allowed = endpoints[provider];
    const endpoint = env[endpointName]?.trim() || allowed[0];
    const missing = [];
    if (!key || /\s/.test(key)) missing.push(keyName);
    if (!ids.every((id) => modelId.test(id) && id !== key)) missing.push(modelsName);
    if (!allowed.includes(endpoint)) missing.push(endpointName);
    return {
      provider,
      key,
      endpoint,
      models: missing.length ? [] : [...new Set(ids)].slice(0, 40),
      missing,
    };
  });
  return {
    catalog: {
      envFile,
      providers: configs.map(({ provider, endpoint, models, missing }) => ({
        provider,
        models,
        missing,
        endpoint: endpoints[provider].includes(endpoint) ? endpoint : endpoints[provider][0],
      })),
    },
    create(provider, model) {
      const config = configs.find(
        (entry) => entry.provider === provider && entry.models.includes(model),
      );
      if (!config) return undefined;
      return provider === 'deepseek'
        ? new DeepSeekProvider(config.key, model)
        : new CloudApiProvider({
            kind: provider,
            model,
            endpoint: config.endpoint,
            key: config.key,
          });
    },
  };
}
