import { computed, ref, shallowRef } from 'vue';
import { cloudProviders } from './modelCatalog.ts';
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

export function createProvider(choice: ModelChoice) {
  return choice.provider === 'ollama'
    ? OllamaProvider.forAgent(choice.address!, choice.model)
    : new CloudPageProvider(choice.provider, choice.model);
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
  let discovery: AbortController | undefined;
  let probe: AbortController | undefined;

  const options = computed<ModelChoice[]>(() => [
    ...local.value.map(
      (model): ModelChoice => ({ provider: 'ollama', model, address: address.value }),
    ),
    ...cloud.value.flatMap((p) =>
      p.models.map((model): ModelChoice => ({ provider: p.provider, model })),
    ),
  ]);
  const selected = computed(
    () =>
      choice.value && options.value.find((item) => choiceKey(item) === choiceKey(choice.value!)),
  );
  const settingsConfig = computed(() =>
    cloud.value.find((p) => p.provider === settingsProvider.value),
  );
  const settingsOptions = computed(() =>
    options.value.filter((p) => p.provider === settingsProvider.value),
  );
  const testModel = ref('');
  const target = computed(
    () =>
      settingsOptions.value.find((m) => m.model === testModel.value) ??
      (selected.value?.provider === settingsProvider.value
        ? selected.value
        : settingsOptions.value[0]),
  );
  const testResult = computed(() => target.value && tests.value[choiceKey(target.value)]);
  const settingsStatus = computed(() => {
    if (!loaded.value) return '正在读取配置';
    if (
      settingsProvider.value === 'ollama'
        ? localError.value && !local.value.length
        : cloudError.value
    )
      return '连接异常';
    if (!target.value) return '待配置';
    return testResult.value?.ok === false ? '连接异常' : '可发送';
  });

  function select(key: string) {
    if (!key) {
      choice.value = undefined;
      try {
        localStorage.removeItem(preference);
      } catch {
        // Selection is still cleared for the current page.
      }
      return;
    }
    const item = options.value.find((value) => choiceKey(value) === key);
    if (!item) return;
    choice.value = item;
    openSettings(item.provider, false);
    try {
      localStorage.setItem(preference, JSON.stringify(item));
    } catch {
      // Selection remains available for the current page.
    }
  }
  function openSettings(provider: ProviderId, open = true) {
    settingsProvider.value = provider;
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
        if (controller.signal.aborted) return;
        cloud.value = configured.providers;
        envFile.value = configured.envFile;
        cloudError.value = '';
      } catch {
        if (controller.signal.aborted) return;
        cloud.value = [];
        cloudError.value =
          '无法读取 Node 云端配置。请通过本机开发服务或生产预览打开页面，再刷新模型列表。';
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

  async function testConnection() {
    const item = target.value;
    if (testing.value || !item) return;
    testing.value = true;
    const controller = new AbortController();
    probe = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    try {
      const result = await createProvider(item).probe(signal);
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
    options,
    cloud,
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
