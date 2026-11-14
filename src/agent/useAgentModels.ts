import { computed, reactive, ref, shallowRef, watch } from 'vue';
import {
  defaultLocalAddress,
  discoverLocalService,
  localProviderIds,
  localServiceGroups,
} from './localDiscovery.ts';
import type { LocalService } from './localDiscovery.ts';
import {
  cloudModelId,
  cloudProviderIds,
  cloudProviders,
  temporaryApiKeyFormat,
} from './modelCatalog.ts';
import type { CloudModelConfig, ProviderId } from './modelCatalog.ts';
import { CloudPageProvider, cloudUnavailable, modelError } from './providers/cloudPage.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { LocalOpenAIProvider } from './providers/localOpenAI.ts';
import { localModelAddress, localModelId } from './providers/localModel.ts';
import type { LocalProviderId } from './providers/localModel.ts';
import { ProviderResponseError } from './provider.ts';

const preference = 'kinetic-agent-model';
const addressPreference = 'kinetic-agent-local-addresses';
export interface ModelChoice {
  provider: ProviderId;
  model: string;
  address?: string;
  manual?: true;
}
export const providerNames = {
  ollama: 'Ollama',
  'local-openai': '本地兼容服务',
  ...Object.fromEntries(Object.entries(cloudProviders).map(([id, p]) => [id, p.name])),
} as Record<ProviderId, string>;
export const choiceKey = (value: ModelChoice) =>
  JSON.stringify([value.provider, value.model, value.address ?? '']);
export const isLocalProvider = (provider: ProviderId): provider is LocalProviderId =>
  provider === 'ollama' || provider === 'local-openai';

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
    const provider = saved.provider as ProviderId;
    if (isLocalProvider(provider)) {
      if (!localModelId(saved.model)) return;
      return {
        provider,
        model: saved.model,
        address: localModelAddress(saved.address, provider === 'local-openai'),
        ...(provider === 'local-openai' && saved.manual === true ? { manual: true } : {}),
      };
    }
    if (Object.hasOwn(cloudProviders, saved.provider))
      return { provider: saved.provider, model: saved.model };
  } catch {
    // Browser storage can be disabled.
  }
}

function restoreAddresses() {
  const addresses: Partial<Record<LocalProviderId, string>> = {};
  try {
    const saved = JSON.parse(localStorage.getItem(addressPreference) ?? '{}');
    for (const provider of localProviderIds) {
      if (typeof saved?.[provider] === 'string')
        addresses[provider] = localModelAddress(saved[provider], provider === 'local-openai');
    }
  } catch {
    // The defaults also work when storage is unavailable.
  }
  return addresses;
}

export function useAgentModels() {
  const choice = shallowRef(restoreChoice());
  const addresses = ref(restoreAddresses());
  if (choice.value && isLocalProvider(choice.value.provider) && choice.value.address)
    addresses.value[choice.value.provider] ??= choice.value.address;
  const addressInput = ref('');
  const addressError = ref('');
  watch(addressInput, () => (addressError.value = ''), { flush: 'sync' });
  const local = shallowRef<Record<LocalProviderId, LocalService[]>>({
    ollama: [],
    'local-openai': [],
  });
  const localErrors = ref<Record<LocalProviderId, string>>({ ollama: '', 'local-openai': '' });
  const compatibleAuthAddress = ref('');
  const localToken = ref('');
  const localTokens = reactive(new Map<string, string>());
  const cloud = shallowRef<CloudModelConfig[]>([]);
  const envFile = ref('项目根目录下的 .env');
  const publicCloud = ref(false);
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
    addressInput,
    (value, previous) => {
      if (settingsProvider.value !== 'local-openai') return;
      const normalize = (input: string) => {
        try {
          return localModelAddress(input, true);
        } catch {
          return '';
        }
      };
      const address = normalize(value);
      if (address !== normalize(previous)) localToken.value = localTokens.get(address) ?? '';
    },
    { flush: 'sync' },
  );

  const localError = computed(() =>
    isLocalProvider(settingsProvider.value) ? localErrors.value[settingsProvider.value] : '',
  );
  const settledLocalServices = computed(() =>
    localProviderIds.flatMap((provider) => local.value[provider]),
  );
  const localModelCount = computed(() =>
    settledLocalServices.value.reduce((total, service) => total + service.models.length, 0),
  );
  const localServiceCount = computed(() => settledLocalServices.value.length);

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
  const localOptions = computed<ModelChoice[]>(() => {
    const options = localProviderIds.flatMap((provider) =>
      local.value[provider].flatMap(({ address, models }) =>
        models.map((model): ModelChoice => ({ provider, model, address })),
      ),
    );
    const manual = choice.value;
    if (manual?.manual && !options.some((item) => choiceKey(item) === choiceKey(manual)))
      options.push(manual);
    return options;
  });
  const options = computed<ModelChoice[]>(() => [...localOptions.value, ...cloudOptions.value]);
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
    if (settingsProvider.value === 'local-openai')
      return !!localModelId(model) && model !== localToken.value.trim();
    return cloudModelId.test(model) && model !== temporaryKey.value.trim();
  });

  function usesTemporaryKey(item: ModelChoice) {
    return (
      !isLocalProvider(item.provider) &&
      item.provider === choice.value?.provider &&
      Boolean(temporaryKey.value.trim())
    );
  }

  function canSend(item: ModelChoice) {
    if (isLocalProvider(item.provider)) return true;
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
      settingsOptions.value.find((m) => choiceKey(m) === testModel.value) ??
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
    if (!loaded.value || (isLocalProvider(settingsProvider.value) && refreshing.value))
      return '正在读取配置';
    if (
      isLocalProvider(settingsProvider.value) ? localError.value && !target.value : cloudError.value
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
    const provider = settingsProvider.value;
    if (provider === 'ollama' || !customModelValid.value) return;
    const model = customModel.value.trim();
    if (provider === 'local-openai') {
      const address = applyAddress();
      if (address) choose({ provider, address, model, manual: true });
      return;
    }
    choose({
      provider,
      model,
    });
    settings.value = false;
  }

  function openSettings(provider: ProviderId, open = true) {
    settingsProvider.value = provider;
    customModel.value = '';
    testModel.value = '';
    if (isLocalProvider(provider)) {
      const current = choice.value;
      addressInput.value =
        (current?.provider === provider && current.address) ||
        addresses.value[provider] ||
        local.value[provider][0]?.address ||
        (provider === 'local-openai' && compatibleAuthAddress.value) ||
        defaultLocalAddress(provider);
      localToken.value = localTokens.get(addressInput.value) ?? '';
      addressError.value = '';
    }
    if (open) settings.value = true;
  }
  openSettings(settingsProvider.value, false);

  async function refresh(clearConnectionStatus = false) {
    if (clearConnectionStatus) tests.value = {};
    discovery?.abort();
    const controller = new AbortController();
    discovery = controller;
    refreshing.value = true;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const readLocal = async () => {
      await Promise.all(
        localProviderIds.map(async (provider) => {
          const groups = localServiceGroups(provider, addresses.value[provider]);
          const results = await Promise.allSettled(
            groups.map((group) =>
              discoverLocalService(
                provider,
                group,
                signal,
                (address) => localTokens.get(address) ?? '',
              ),
            ),
          );
          if (controller.signal.aborted) return;
          const services = results.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
          );
          local.value = { ...local.value, [provider]: services };
          const configured = addresses.value[provider];
          const preferred = results[0];
          const authIndex = results.findIndex(
            (result) =>
              result.status === 'rejected' &&
              result.reason instanceof ProviderResponseError &&
              [401, 403].includes(result.reason.failure.httpStatus),
          );
          if (provider === 'local-openai')
            compatibleAuthAddress.value = authIndex < 0 ? '' : groups[authIndex][0];
          const failure =
            (configured && preferred.status === 'rejected' ? preferred : undefined) ??
            results[authIndex];
          if (
            failure?.status === 'rejected' &&
            failure.reason instanceof ProviderResponseError &&
            [401, 403].includes(failure.reason.failure.httpStatus)
          ) {
            const status = failure.reason.failure.httpStatus;
            localErrors.value[provider] =
              provider === 'local-openai'
                ? `${compatibleAuthAddress.value} 拒绝访问（${status}）。请检查本地服务令牌或浏览器跨域权限。`
                : `Ollama 拒绝访问（${status}）。请检查 OLLAMA_ORIGINS 是否允许当前页面来源。`;
          } else if (!services.length || (configured && preferred.status === 'rejected')) {
            localErrors.value[provider] =
              provider === 'ollama'
                ? '无法读取本机 Ollama。请确认服务已启动、地址正确，并检查浏览器本地网络权限或 OLLAMA_ORIGINS。'
                : '无法读取本地兼容服务。请确认服务已启动、地址正确，并检查浏览器本地网络权限或服务的 CORS 设置。';
          } else {
            localErrors.value[provider] = '';
          }
        }),
      );
    };
    const readCloud = async () => {
      try {
        const configured = await CloudPageProvider.catalog(signal);
        if (!Array.isArray(configured?.providers) || !configured.providers.length)
          throw new Error('CLOUD_PROXY_UNAVAILABLE');
        if (controller.signal.aborted) return;
        cloud.value = configured.providers;
        envFile.value = configured.envFile ?? envFile.value;
        publicCloud.value = configured.public === true;
        cloudError.value = '';
      } catch {
        if (controller.signal.aborted) return;
        cloud.value = [];
        cloudError.value = cloudUnavailable;
      }
    };
    await Promise.all([readLocal(), readCloud()]);
    if (controller.signal.aborted) return;
    loaded.value = true;
    refreshing.value = false;
  }

  function applyAddress() {
    const provider = settingsProvider.value;
    if (!isLocalProvider(provider)) return;
    let address: string;
    try {
      address = localModelAddress(addressInput.value, provider === 'local-openai');
    } catch {
      addressError.value =
        provider === 'ollama'
          ? '请输入本机 Ollama 根地址，例如 http://127.0.0.1:11434。'
          : '请输入本机兼容服务地址，例如 http://127.0.0.1:1234/v1。';
      return;
    }
    if (provider === 'local-openai') {
      const token = localToken.value.trim();
      if (token && !temporaryApiKeyFormat.test(token)) return;
      if (token) localTokens.set(address, token);
      else localTokens.delete(address);
      tests.value = {};
      probe?.abort();
    }
    addresses.value[provider] = address;
    addressInput.value = address;
    try {
      localStorage.setItem(addressPreference, JSON.stringify(addresses.value));
    } catch {
      // The address remains available for the current page.
    }
    void refresh();
    return address;
  }

  function recordResult(item: ModelChoice, ok: boolean, message: string) {
    tests.value[choiceKey(item)] = { ok, message };
  }

  function createProvider(item: ModelChoice) {
    if (item.provider === 'ollama') return OllamaProvider.forAgent(item.address!, item.model);
    if (item.provider === 'local-openai')
      return new LocalOpenAIProvider(
        item.address!,
        item.model,
        localTokens.get(item.address!) ?? '',
      );
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
        recordResult(
          item,
          false,
          modelError(error, isLocalProvider(item.provider) ? item.provider : false),
        );
    } finally {
      testing.value = false;
      probe = undefined;
    }
  }

  function dispose() {
    temporaryKey.value = '';
    localTokens.clear();
    discovery?.abort();
    probe?.abort();
  }

  return {
    addressInput,
    addressError,
    localToken,
    localTokenValid: computed(
      () => !localToken.value.trim() || temporaryApiKeyFormat.test(localToken.value.trim()),
    ),
    cloudError,
    localError,
    localOptions,
    localServiceCount,
    localModelCount,
    localServices: computed(() =>
      isLocalProvider(settingsProvider.value) ? local.value[settingsProvider.value] : [],
    ),
    envFile,
    publicCloud,
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
