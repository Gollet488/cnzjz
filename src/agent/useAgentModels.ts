import { computed, ref, shallowRef, watch } from 'vue';
import {
  cloudModelId,
  cloudProviderIds,
  cloudProviders,
  temporaryApiKeyFormat,
} from './modelCatalog.ts';
import type { CloudModelConfig, ProviderId } from './modelCatalog.ts';
import { CloudPageProvider, modelError } from './providers/cloudPage.ts';
import { localOllamaURL, OllamaProvider } from './providers/ollama.ts';

const preference = 'kinetic-agent-model';
const defaultAddress = 'http://127.0.0.1:11434';
export interface ModelChoice {
  provider: ProviderId;
  model: string;
  address?: string;
}
export const providerNames = {
  ollama: 'Ollama',
  ...Object.fromEntries(Object.entries(cloudProviders).map(([id, p]) => [id, p.name])),
} as Record<ProviderId, string>;
export const choiceKey = (value: ModelChoice) =>
  JSON.stringify([value.provider, value.model, value.address ?? '']);

function restoreChoice(): ModelChoice | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(preference) ?? 'null');
    if (
      !saved ||
      typeof saved.model !== 'string' ||
      !saved.model.length ||
      saved.model.length > 200
    )
      return;
    if (saved.provider === 'ollama')
      return { provider: 'ollama', model: saved.model, address: localOllamaURL(saved.address) };
    if (Object.hasOwn(cloudProviders, saved.provider))
      return { provider: saved.provider, model: saved.model };
  } catch {
    // Browser storage can be disabled.
  }
}

export function useAgentModels() {
  const choice = shallowRef(restoreChoice());
  const address = ref(choice.value?.address ?? defaultAddress);
  const addressInput = ref(address.value);
  const local = ref<string[]>([]);
  const cloud = shallowRef<CloudModelConfig[]>([]);
  const envFile = ref('项目根目录下的 .env');
  const localError = ref('');
  const cloudError = ref('');
  const refreshing = ref(false);
  const loaded = ref(false);
  const settings = ref(false);
  const settingsProvider = ref<ProviderId>(choice.value?.provider ?? 'ollama');
  const tests = ref<Record<string, { ok: boolean; message: string }>>({});
  const testing = ref(false);
  const temporaryKey = ref('');
  const customModel = ref('');
  let keyLifetime = new AbortController();
  let discovery: AbortController | undefined;
  let probe: AbortController | undefined;

  watch(
    temporaryKey,
    () => {
      keyLifetime.abort();
      keyLifetime = new AbortController();
      probe?.abort();
      tests.value = {};
    },
    { flush: 'sync' },
  );

  const cloudOptions = computed(() =>
    cloudProviderIds.flatMap((provider) => {
      const models = new Set<string>(cloudProviders[provider].presets);
      for (const model of cloud.value.find((p) => p.provider === provider)?.models ?? [])
        models.add(model);
      if (choice.value?.provider === provider) models.add(choice.value.model);
      return [...models].map((model): ModelChoice => ({ provider, model }));
    }),
  );
  const options = computed<ModelChoice[]>(() => [
    ...local.value.map(
      (model): ModelChoice => ({ provider: 'ollama', model, address: address.value }),
    ),
    ...cloudOptions.value,
  ]);
  const selected = computed(
    () =>
      choice.value && options.value.find((item) => choiceKey(item) === choiceKey(choice.value!)),
  );
  const settingsConfig = computed(() =>
    cloud.value.find((p) => p.provider === settingsProvider.value),
  );
  const selectedConfigured = computed(() =>
    cloud.value.some(
      (p) => p.provider === selected.value?.provider && p.models.includes(selected.value.model),
    ),
  );
  const keyValid = computed(() => temporaryApiKeyFormat.test(temporaryKey.value.trim()));
  const customModelValid = computed(() => {
    const model = customModel.value.trim();
    return cloudModelId.test(model) && model !== temporaryKey.value.trim();
  });

  function usesTemporaryKey(item: ModelChoice) {
    return (
      item.provider !== 'ollama' &&
      item.provider === choice.value?.provider &&
      Boolean(temporaryKey.value.trim())
    );
  }

  function canSend(item: ModelChoice) {
    if (item.provider === 'ollama') return true;
    const config = cloud.value.find((p) => p.provider === item.provider);
    if (!config || config.missing.some((name) => name.endsWith('_ENDPOINT'))) return false;
    if (usesTemporaryKey(item)) return keyValid.value && item.model !== temporaryKey.value.trim();
    return config.models.includes(item.model);
  }

  const ready = computed(() => selected.value && canSend(selected.value));
  const settingsOptions = computed(() =>
    options.value.filter((p) => p.provider === settingsProvider.value && canSend(p)),
  );
  const testModel = ref('');
  const target = computed(
    () =>
      settingsOptions.value.find((m) => m.model === testModel.value) ??
      (selected.value?.provider === settingsProvider.value && canSend(selected.value)
        ? selected.value
        : settingsOptions.value[0]),
  );
  watch(
    () => target.value && choiceKey(target.value),
    () => probe?.abort(),
    { flush: 'sync' },
  );
  const testResult = computed(() => target.value && tests.value[choiceKey(target.value)]);
  const settingsStatus = computed(() => {
    if (testing.value) return '正在测试';
    if (!loaded.value) return '正在读取配置';
    if (
      settingsProvider.value === 'ollama'
        ? localError.value && !local.value.length
        : cloudError.value
    )
      return '连接异常';
    if (!target.value) return '待配置';
    return testResult.value ? (testResult.value.ok ? '已连接' : '连接异常') : '可发送';
  });

  function choose(item?: ModelChoice) {
    if (item?.provider !== choice.value?.provider) temporaryKey.value = '';
    if (!item) {
      choice.value = undefined;
      try {
        localStorage.removeItem(preference);
      } catch {
        // Selection is still cleared for the current page.
      }
      return;
    }
    choice.value = item;
    openSettings(item.provider, false);
    try {
      localStorage.setItem(preference, JSON.stringify(item));
    } catch {
      // Selection remains available for the current page.
    }
  }
  function select(key: string) {
    const item = options.value.find((value) => choiceKey(value) === key);
    if (item || !key) choose(item);
  }

  function selectCustom() {
    if (settingsProvider.value === 'ollama' || !customModelValid.value) return;
    choose({
      provider: settingsProvider.value,
      model: customModel.value.trim(),
    });
    settings.value = false;
  }

  function openSettings(provider: ProviderId, open = true) {
    settingsProvider.value = provider;
    customModel.value = '';
    testModel.value = '';
    if (open) settings.value = true;
  }

  async function refresh(clearConnectionStatus = false) {
    if (clearConnectionStatus) tests.value = {};
    discovery?.abort();
    const controller = new AbortController();
    discovery = controller;
    refreshing.value = true;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    const readLocal = async () => {
      try {
        const installed = await OllamaProvider.models(address.value, signal);
        if (controller.signal.aborted) return;
        local.value = [...new Set(installed)];
        localError.value = '';
      } catch {
        if (controller.signal.aborted) return;
        local.value = [];
        localError.value =
          '无法读取本机 Ollama。请启动 Ollama（ollama serve），确认地址；如被浏览器拦截，在 OLLAMA_ORIGINS 中加入当前页面来源后重启 Ollama。';
      }
    };
    const readCloud = async () => {
      try {
        const configured = await CloudPageProvider.catalog(signal);
        if (!Array.isArray(configured?.providers) || !configured.providers.length)
          throw new Error('CLOUD_PROXY_UNAVAILABLE');
        if (controller.signal.aborted) return;
        cloud.value = configured.providers;
        envFile.value = configured.envFile;
        cloudError.value = '';
      } catch {
        if (controller.signal.aborted) return;
        cloud.value = [];
        cloudError.value =
          '云端模型需要本机服务。请在项目目录运行 pnpm dev，从终端打开本机地址，再刷新模型列表。';
      }
    };
    await Promise.all([readLocal(), readCloud()]);
    if (controller.signal.aborted) return;
    loaded.value = true;
    refreshing.value = false;
  }

  function applyAddress() {
    try {
      address.value = localOllamaURL(addressInput.value);
      addressInput.value = address.value;
      local.value = [];
      void refresh();
    } catch {
      localError.value = '请输入本机 Ollama 根地址，例如 http://127.0.0.1:11434。';
    }
  }

  function recordResult(item: ModelChoice, ok: boolean, message: string) {
    tests.value[choiceKey(item)] = { ok, message };
  }

  function createProvider(item: ModelChoice) {
    if (item.provider === 'ollama') return OllamaProvider.forAgent(item.address!, item.model);
    const credential = usesTemporaryKey(item)
      ? { key: () => temporaryKey.value.trim(), signal: keyLifetime.signal }
      : undefined;
    return new CloudPageProvider(item.provider, item.model, credential);
  }

  async function testConnection() {
    const item = target.value;
    if (testing.value || !item) return;
    testing.value = true;
    const controller = new AbortController();
    probe = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(70_000)]);
    try {
      const result = await createProvider(item).probe(signal);
      signal.throwIfAborted();
      recordResult(
        item,
        true,
        '结构化工具调用通过' +
          ('response' in result && result.response ? ` · ${result.response.model}` : ''),
      );
    } catch (error) {
      if (!controller.signal.aborted)
        recordResult(item, false, modelError(error, item.provider === 'ollama'));
    } finally {
      testing.value = false;
      probe = undefined;
    }
  }

  function dispose() {
    temporaryKey.value = '';
    discovery?.abort();
    probe?.abort();
  }

  return {
    addressInput,
    cloudError,
    localError,
    envFile,
    refreshing,
    loaded,
    settings,
    settingsProvider,
    settingsConfig,
    settingsOptions,
    testModel,
    target,
    testResult,
    testing,
    settingsStatus,
    choice,
    selected,
    selectedConfigured,
    ready,
    temporaryKey,
    keyValid,
    customModel,
    customModelValid,
    selectCustom,
    createProvider,
    options,
    cloudOptions,
    select,
    openSettings,
    refresh,
    applyAddress,
    recordResult,
    testConnection,
    cancelTest: () => probe?.abort(),
    dispose,
  };
}
