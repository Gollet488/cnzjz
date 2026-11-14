import { ProviderResponseError } from './provider.ts';
import { localDefaults, localHosts } from './providers/localModel.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { LocalOpenAIProvider } from './providers/localOpenAI.ts';
import type { LocalProviderId } from './providers/localModel.ts';

export const localProviderIds = ['ollama', 'local-openai'] as const;

export interface LocalService {
  address: string;
  models: string[];
}

export function localServiceGroups(provider: LocalProviderId, configured?: string) {
  const ports = provider === 'ollama' ? [11434] : [1234, 8080, 8000];
  const groups = ports.map((port) => localHosts.map((host) => `http://${host}:${port}`));
  if (!configured) return groups;
  const defaultGroup = groups.find((group) => group.includes(configured));
  return [
    [configured, ...(defaultGroup?.filter((address) => address !== configured) ?? [])],
    ...groups.filter((group) => group !== defaultGroup),
  ];
}

export async function discoverLocalService(
  provider: LocalProviderId,
  addresses: string[],
  signal: AbortSignal,
  tokenFor: (address: string) => string,
): Promise<LocalService> {
  async function read(address: string, timeout: number) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const models =
      provider === 'ollama'
        ? await OllamaProvider.models(address, requestSignal)
        : await LocalOpenAIProvider.models(address, requestSignal, tokenFor(address));
    requestSignal.throwIfAborted();
    return { address, models };
  }

  // Keep the preferred loopback address stable when the same service answers on aliases.
  const [preferred, ...aliases] = addresses;
  const first = await read(preferred, aliases.length ? 3500 : 8000).catch((error: unknown) => ({
    error,
  }));
  signal.throwIfAborted();
  if ('models' in first && (first.models.length || !aliases.length)) return first;
  const fallbacks = await Promise.allSettled(aliases.map((address) => read(address, 3500)));
  signal.throwIfAborted();
  for (const attempt of fallbacks)
    if (attempt.status === 'fulfilled' && attempt.value.models.length) return attempt.value;
  if ('models' in first) return first;
  for (const attempt of fallbacks) if (attempt.status === 'fulfilled') return attempt.value;
  if (
    first.error instanceof ProviderResponseError &&
    [401, 403].includes(first.error.failure.httpStatus)
  )
    throw first.error;
  for (const attempt of fallbacks)
    if (
      attempt.status === 'rejected' &&
      attempt.reason instanceof ProviderResponseError &&
      [401, 403].includes(attempt.reason.failure.httpStatus)
    )
      throw attempt.reason;
  throw first.error;
}

export function defaultLocalAddress(provider: LocalProviderId) {
  return localDefaults[provider];
}
