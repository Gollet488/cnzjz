import { setTimeout as delay } from 'node:timers/promises';

const retryable = new Set([429, 503, 529]);
const maxWait = 3000;

// Only repeat explicit rate-limit/overload rejections. Network and read errors
// may occur after inference was accepted, so leave those to the user.
export async function fetchCloudModel(url, options) {
  const response = await fetch(url, options);
  if (!retryable.has(response.status)) return response;
  const header = response.headers.get('Retry-After');
  const wait =
    header === null
      ? 600
      : /^\d+$/.test(header)
        ? Number(header) * 1000
        : Math.max(0, Date.parse(header) - Date.now());
  if (!Number.isFinite(wait) || wait > maxWait) return response;
  await response.body?.cancel().catch(() => {});
  const signal = options.signal;
  await delay(wait, undefined, { signal });
  signal?.throwIfAborted();
  return fetch(url, options);
}
