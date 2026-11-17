import { computed, reactive, ref, shallowRef, watch } from 'vue';
import {
  authenticationStatus,
  defaultLocalAddress,
  discoverLocalService,
  localServiceGroups,
  withRunningModels,
} from './localDiscovery.ts';
import type { LocalService } from './localDiscovery.ts';
import {
  cloudModelId,
  cloudProviderIds,
  cloudProviders,
  temporaryApiKeyFormat,
} from './modelCatalog.ts';
import type { CloudModelConfig, CloudProviderId, ProviderId } from './modelCatalog.ts';
import { CloudPageProvider, cloudUnavailable, modelError } from './providers/cloudPage.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { LocalOpenAIProvider } from './providers/localOpenAI.ts';
import { localModelAddress, localModelId } from './providers/localModel.ts';
import type { LocalProviderId } from './providers/localModel.ts';

const preference = 'kinetic-agent-model';
const addressPreference = 'kinetic-agent-local-addresses';
export type SettingsProvider = 'local' | CloudProviderId;
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
  const addresses: Partial<Record<'local' | LocalProviderId, string>> = {};
  try {
    const saved = JSON.parse(localStorage.getItem(addressPreference) ?? '{}');
    for (const key of ['local', 'ollama', 'local-openai'] as const) {
      const address = normalizeAddress(saved?.[key]);
      if (address) addresses[key] = address;
    }
  } catch {
    // The defaults also work when storage is unavailable.
  }
  return addresses;
}

function normalizeAddress(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return localModelAddress(value, true);
  } catch {
    return '';
  }
}

export function useAgentModels() {
  const choice = shallowRef(restoreChoice());
  const addresses = ref(restoreAddresses());
  const addressInput = ref('');
  const addressError = ref('');
  watch(addressInput, () => (addressError.value = ''), { flush: 'sync' });
  const localServices = shallowRef<LocalService[]>([]);
  const localError = ref('');
  const authAddress = ref('');
  const localToken = ref('');
  const localTokens = reactive(new Map<string, string>());
  const cloud = shallowRef<CloudModelConfig[]>([]);
  const envFile = ref('项目根目录下的 .env');
  const publicCloud = ref(false);
  const cloudError = ref('');
  const refreshing = ref(false);
  const loaded = ref(false);
  const settings = ref(false);
  const settingsProvider = ref<SettingsProvider>('local');
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
      const address = normalizeAddress(value);
      if (address !== normalizeAddress(previous)) localToken.value = localTokens.get(address) ?? '';
    },
    { flush: 'sync' },
  );

  function serviceFor(item: ModelChoice) {
    return localServices.value.find(
      ({ address, provider }) => address === item.address && provider === item.provider,
    );
  }
  function modelProviderName(item: ModelChoice) {
    return serviceFor(item)?.deployment ?? providerNames[item.provider];
  }
  function localModelLabel(item: ModelChoice) {
    const loaded = serviceFor(item)?.runningModels?.includes(item.model);
    return `${item.model} · ${modelProviderName(item)} · ${item.address}${loaded ? ' · 已载入 Ollama' : ''}`;
  }
  const localModelCount = computed(() =>
    localServices.value.reduce((total, service) => total + service.models.length, 0),
  );
  const localServiceCount = computed(() => localServices.value.length);

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
    const options = localServices.value.flatMap(({ provider, address, models }) =>
      models.map((model): ModelChoice => ({ provider, model, address })),
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
  const canEnterLocalModel = computed(() => {
    const input = normalizeAddress(addressInput.value);
    return localServices.value.find(({ address }) => address === input)?.provider !== 'ollama';
  });
  const customModelValid = computed(() => {
    const model = customModel.value.trim();
    if (settingsProvider.value === 'local')
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
    cloudOptions.value.filter((p) => p.provider === settingsProvider.value && canSend(p)),
  );
  const testModel = ref('');
  const testAddress = ref('');
  const defaultTestModel = computed(
    () => settingsOptions.value.find((item) => item === selected.value) ?? settingsOptions.value[0],
  );
  const target = computed(() => {
    if (settingsProvider.value !== 'local')
      return (
        settingsOptions.value.find((m) => choiceKey(m) === testModel.value) ??
        defaultTestModel.value
      );
    const item = selected.value;
    if (
      item &&
      isLocalProvider(item.provider) &&
      (!testAddress.value || testAddress.value === item.address)
    )
      return item;
    return undefined;
  });
  watch(
    () => target.value && choiceKey(target.value),
    () => probe?.abort(),
    { flush: 'sync' },
  );
  const testResult = computed(() => target.value && tests.value[choiceKey(target.value)]);
  const settingsStatus = computed(() => {
    if (testing.value) return '正在测试';
    if (!loaded.value || (settingsProvider.value === 'local' && refreshing.value))
      return '正在读取配置';
    if (settingsProvider.value === 'local' ? localError.value && !target.value : cloudError.value)
      return '连接异常';
    if (!target.value) return '待配置';
    if (testResult.value) return testResult.value.ok ? '已连接' : '连接异常';
    return settingsProvider.value === 'local' ? '待验证' : '可发送';
  });

  function rememberChoice(item?: ModelChoice) {
    choice.value = item;
    try {
      if (item) localStorage.setItem(preference, JSON.stringify(item));
      else localStorage.removeItem(preference);
    } catch {
      // Selection is still updated for the current page.
    }
  }
  function choose(item?: ModelChoice) {
    if (item?.provider !== choice.value?.provider) temporaryKey.value = '';
    rememberChoice(item);
    if (item) openSettings(isLocalProvider(item.provider) ? 'local' : item.provider, false);
  }
  function select(key: string) {
    const item = options.value.find((value) => choiceKey(value) === key);
    if (item || !key) choose(item);
  }

  function selectCustom() {
    const provider = settingsProvider.value;
    if (!customModelValid.value) return;
    const model = customModel.value.trim();
    if (provider === 'local') {
      if (!canEnterLocalModel.value) return;
      const address = applyAddress();
      if (address) choose({ provider: 'local-openai', address, model, manual: true });
      return;
    }
    choose({
      provider,
      model,
    });
    settings.value = false;
  }

  function openSettings(provider: SettingsProvider, open = true) {
    settingsProvider.value = provider;
    customModel.value = '';
    testModel.value = '';
    testAddress.value = '';
    if (provider === 'local') {
      const current = choice.value;
      addressInput.value =
        current?.address ||
        addresses.value.local ||
        addresses.value.ollama ||
        addresses.value['local-openai'] ||
        localServices.value[0]?.address ||
        authAddress.value ||
        defaultLocalAddress;
      localToken.value = localTokens.get(addressInput.value) ?? '';
      addressError.value = '';
    }
    if (open) settings.value = true;
  }
  const initial = choice.value?.provider;
  openSettings(!initial || isLocalProvider(initial) ? 'local' : initial, false);

  async function refresh(clearConnectionStatus = false) {
    if (clearConnectionStatus) tests.value = {};
    discovery?.abort();
    const controller = new AbortController();
    discovery = controller;
    refreshing.value = true;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const readLocal = async () => {
      const configured = addresses.value.local;
      const groups = localServiceGroups(
        [configured, choice.value?.address, ...Object.values(addresses.value)].filter(
          (address): address is string => !!address,
        ),
      );
      const results = await Promise.allSettled(
        groups.map(async (group) => {
          const service = await discoverLocalService(
            group,
            signal,
            (address) => localTokens.get(address) ?? '',
          );
          return withRunningModels(service, signal);
        }),
      );
      if (controller.signal.aborted) return;
      localServices.value = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const current = choice.value;
      if (
        current?.provider === 'local-openai' &&
        localServices.value.some(
          ({ address, provider, models }) =>
            provider === 'ollama' && address === current.address && models.includes(current.model),
        )
      )
        rememberChoice({ provider: 'ollama', address: current.address, model: current.model });

      const preferredIndex = groups.findIndex(
        (group) => !!configured && group.includes(configured),
      );
      const authIndex = results.findIndex(
        (result) => result.status === 'rejected' && authenticationStatus(result.reason),
      );
      authAddress.value = authIndex < 0 ? '' : groups[authIndex][0];
      const failedIndex =
        results[preferredIndex]?.status === 'rejected' ? preferredIndex : authIndex;
      const failure = results[failedIndex];
      const status = failure?.status === 'rejected' && authenticationStatus(failure.reason);
      localError.value = '';
      if (status) {
        localError.value = `${groups[failedIndex][0]} 拒绝访问（${status}）。请检查本地服务令牌或跨域权限。`;
      } else if (failure || !localServices.value.length) {
        const address = failure ? groups[failedIndex][0] : '本地模型服务';
        localError.value = `无法读取 ${address}。请检查服务是否已启动、监听地址和浏览器本地网络权限。`;
      }
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
    if (settingsProvider.value !== 'local') return;
    const address = normalizeAddress(addressInput.value);
    if (!address) {
      addressError.value = '请输入本机服务地址，例如 http://127.0.0.1:11434。';
      return;
    }
    const token = localToken.value.trim();
    if (token && !temporaryApiKeyFormat.test(token)) return;
    if (token) localTokens.set(address, token);
    else localTokens.delete(address);
    addresses.value.local = address;
    addressInput.value = address;
    testModel.value = '';
    testAddress.value = address;
    probe?.abort();
    tests.value = {};
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
    modelProviderName,
    localModelLabel,
    localServices,
    envFile,
    publicCloud,
    refreshing,
    loaded,
    settings,
    settingsProvider,
    settingsConfig,
    settingsOptions,
    defaultTestModel,
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
    canEnterLocalModel,
    selectCustom,
    createProvider,
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
