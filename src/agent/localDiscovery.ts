import { ProviderResponseError } from './provider.ts';
import { localHosts } from './providers/localModel.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { LocalOpenAIProvider } from './providers/localOpenAI.ts';
import type { LocalProviderId } from './providers/localModel.ts';

export const defaultLocalAddress = 'http://127.0.0.1:11434';

export interface LocalService {
  address: string;
  provider: LocalProviderId;
  deployment: string;
  models: string[];
  modelDigests?: ReadonlyMap<string, string | undefined>;
  runningModels?: string[];
}

export function resolveOllamaModel(service: LocalService, model: string) {
  if (service.models.includes(model)) return model;
  const prefix = /^(?:sha256:)?([0-9a-f]{12,64})$/i.exec(model)?.[1].toLowerCase();
  if (!prefix || !service.modelDigests) return;
  const matches = [...service.modelDigests].filter(([, digest]) => digest?.startsWith(prefix));
  if (matches.length === 1 && service.models.includes(matches[0][0])) return matches[0][0];
}

export function localServiceGroups(configured: string[]) {
  const defaults = [11434, 1234, 8080, 8000].map((port) =>
    localHosts.map((host) => `http://${host}:${port}`),
  );
  const preferred: string[][] = [];
  for (const address of configured) {
    if (preferred.some((group) => group.includes(address))) continue;
    const index = defaults.findIndex((group) => group.includes(address));
    const aliases = index < 0 ? [] : defaults.splice(index, 1)[0];
    preferred.push([address, ...aliases.filter((alias) => alias !== address)]);
  }
  return [...preferred, ...defaults];
}

export function authenticationStatus(error: unknown) {
  if (error instanceof ProviderResponseError && [401, 403].includes(error.failure.httpStatus))
    return error.failure.httpStatus;
}

export async function discoverLocalService(
  addresses: string[],
  signal: AbortSignal,
  tokenFor: (address: string) => string,
): Promise<LocalService> {
  async function read(address: string, timeout: number): Promise<LocalService> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    const native = await OllamaProvider.inventory(
      address,
      AbortSignal.any([requestSignal, AbortSignal.timeout(2000)]),
    ).catch((error: unknown) => ({ error }));
    if ('models' in native) return { address, provider: 'ollama', deployment: 'Ollama', ...native };
    requestSignal.throwIfAborted();
    try {
      const inventory = await LocalOpenAIProvider.inventory(
        address,
        requestSignal,
        tokenFor(address),
      );
      return { address, provider: 'local-openai', ...inventory };
    } catch (error) {
      throw authenticationStatus(error) || !authenticationStatus(native.error)
        ? error
        : native.error;
    }
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
  if (authenticationStatus(first.error)) throw first.error;
  for (const attempt of fallbacks)
    if (attempt.status === 'rejected' && authenticationStatus(attempt.reason)) throw attempt.reason;
  throw first.error;
}

export async function withRunningModels(service: LocalService, signal: AbortSignal) {
  if (service.provider !== 'ollama' || !service.models.length) return service;
  const runningModels = await OllamaProvider.runningModels(
    service.address,
    AbortSignal.any([signal, AbortSignal.timeout(1200)]),
  ).catch(() => undefined);
  return { ...service, runningModels };
}
