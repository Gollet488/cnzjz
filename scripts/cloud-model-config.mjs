import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { cloudModelId, cloudProviders, temporaryApiKeyFormat } from '../src/agent/modelCatalog.ts';
import { DeepSeekProvider, DEEPSEEK_ADDRESS } from '../src/agent/providers/deepseek.ts';
import { CloudApiProvider } from '../src/agent/providers/cloudApi.ts';
import { fetchCloudModel } from './cloud-transport.mjs';

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
const keyNames = Object.values(cloudProviders).map(({ prefix }) => prefix + '_API_KEY');

export function windowsUserCloudKeys(requested) {
  const names = keyNames.filter((name) => requested.includes(name));
  if (process.platform !== 'win32' || !names.length) return {};
  // Query only known keys, in one process. Keep the output in server memory.
  const script = [
    '$keys = @{}',
    `foreach ($name in @(${names.map((name) => `'${name}'`).join(', ')})) {`,
    "  $value = [Environment]::GetEnvironmentVariable($name, 'User')",
    '  if ($null -ne $value) { $keys[$name] = $value }',
    '}',
    '[Console]::Write(($keys | ConvertTo-Json -Compress))',
  ].join('\n');
  try {
    return JSON.parse(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch {
    return {};
  }
}

export function cloudConfiguration(
  root,
  environment = process.env,
  readUserKeys = windowsUserCloudKeys,
) {
  const envFile = resolve(root, '.env');
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const env = { ...file, ...environment };
  const missing = keyNames.filter((name) => env[name] === undefined);
  return configure({ ...readUserKeys(missing), ...env }, envFile);
}

export function publicCloudConfiguration(environment = process.env) {
  return configure(environment);
}

function configure(env, envFile) {
  const configs = Object.entries(cloudProviders).map(([provider, { prefix, presets }]) => {
    const keyName = prefix + '_API_KEY';
    const modelsName = prefix + '_MODELS';
    const endpointName = prefix + '_ENDPOINT';
    const key = envFile ? (env[keyName] ?? '').trim() : '';
    const configured = envFile && env[modelsName]?.trim();
    const ids = configured
      ? configured
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [presets[0]];
    const allowed = endpoints[provider];
    const endpoint = env[endpointName]?.trim() || allowed[0];
    const missing = [];
    if (envFile && !temporaryApiKeyFormat.test(key)) missing.push(keyName);
    if (envFile && (!ids.length || !ids.every((id) => cloudModelId.test(id) && id !== key)))
      missing.push(modelsName);
    if (!allowed.includes(endpoint)) missing.push(endpointName);
    return {
      provider,
      key,
      endpoint,
      models: !envFile || missing.length ? [] : [...new Set(ids)].slice(0, 40),
      missing,
    };
  });
  return {
    catalog: {
      ...(envFile ? { envFile } : { public: true }),
      providers: configs.map(({ provider, endpoint, models, missing }) => ({
        provider,
        models,
        missing,
        endpoint: endpoints[provider].includes(endpoint) ? endpoint : endpoints[provider][0],
      })),
    },
    create(provider, model, apiKey) {
      const config = configs.find((entry) => entry.provider === provider);
      if (!config || !endpoints[provider].includes(config.endpoint)) return undefined;
      if (apiKey === undefined) {
        if (!config.models.includes(model)) return undefined;
      } else if (
        !cloudModelId.test(model) ||
        !temporaryApiKeyFormat.test(apiKey) ||
        model === apiKey
      )
        return undefined;
      return provider === 'deepseek'
        ? new DeepSeekProvider(apiKey ?? config.key, model, fetchCloudModel)
        : new CloudApiProvider({
            kind: provider,
            model,
            endpoint: config.endpoint,
            fetcher: fetchCloudModel,
            // An OpenAI task may retain this adapter to replay reasoning, but
            // a temporary key is supplied separately on every request.
            key: apiKey === undefined ? config.key : undefined,
          });
    },
  };
}
