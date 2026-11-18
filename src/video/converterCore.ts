const NO_DOWNLOAD_PROGRESS_MS = 45_000;
const MAX_DOWNLOAD_MS = 5 * 60_000;
const DOWNLOADING = '正在下载视频转换器…';
type Status = (message: string) => void;

class CoreRequestError extends Error {
  constructor(status: number) {
    super(`下载转换器资源时服务器返回 HTTP ${status}`);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }

  readonly retryable: boolean;
}

async function fetchCore(signal: AbortSignal, status: Status, retry: boolean) {
  const idle = new AbortController();
  const deadline = new AbortController();
  const requestSignal = AbortSignal.any([signal, idle.signal, deadline.signal]);
  const expire = () => idle.abort(new Error('下载视频转换器超时（45 秒内未收到数据）'));
  let idleTimer = setTimeout(expire, NO_DOWNLOAD_PROGRESS_MS);
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error('下载视频转换器超过 5 分钟')),
    MAX_DOWNLOAD_MS,
  );
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.wasm`, {
      signal: requestSignal,
      cache: retry ? 'reload' : 'default',
    });
    if (!response.ok || !response.body) throw new CoreRequestError(response.status);
    let bytes = 0;
    let reported = 0;
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (chunk.length) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(expire, NO_DOWNLOAD_PROGRESS_MS);
            bytes += chunk.length;
            const megabytes = Math.floor(bytes / (1024 * 1024));
            if (megabytes > reported) {
              reported = megabytes;
              status(`${DOWNLOADING} 已接收 ${megabytes} MB`);
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const binary = await new Response(stream, {
      headers: { 'Content-Type': 'application/wasm' },
    }).blob();
    requestSignal.throwIfAborted();
    return binary;
  } catch (error) {
    requestSignal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(deadlineTimer);
    // Also stop reading an HTTP error response that we did not consume.
    idle.abort();
  }
}

async function downloadCore(signal: AbortSignal, status: Status) {
  try {
    return await fetchCore(signal, status, false);
  } catch (error) {
    signal.throwIfAborted();
    // Idle and overall deadlines give the user a prompt to act. A dropped
    // connection or transient HTTP error gets one fresh request automatically.
    if (!(error instanceof TypeError || (error instanceof CoreRequestError && error.retryable)))
      throw error;
    status('视频转换器下载中断，正在重试…');
    return fetchCore(signal, status, true);
  }
}

interface CoreTransfer {
  controller: AbortController;
  listeners: Set<Status>;
  readonly message: string;
  result: Promise<Blob>;
}

let pending: CoreTransfer | undefined;

function startDownload(): CoreTransfer {
  const controller = new AbortController();
  const listeners = new Set<Status>();
  let message = DOWNLOADING;
  const result = downloadCore(controller.signal, (next) => {
    message = next;
    for (const listener of listeners) listener(next);
  });
  const transfer: CoreTransfer = {
    controller,
    listeners,
    get message() {
      return message;
    },
    result: result.finally(() => {
      if (pending === transfer) pending = undefined;
    }),
  };
  return transfer;
}

export async function loadConverterCore(signal: AbortSignal, status: Status) {
  signal.throwIfAborted();
  // Comparison slots can share the same transfer while cancelling independently.
  // Completed downloads rely on the browser's HTTP cache, releasing our Blob.
  const transfer = (pending ??= startDownload());
  let cancel!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = reject;
  });
  const abort = () => cancel(signal.reason);
  const notify = (message: string) => status(message);
  signal.addEventListener('abort', abort, { once: true });
  transfer.listeners.add(notify);
  try {
    status(transfer.message);
    return await Promise.race([transfer.result, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
    transfer.listeners.delete(notify);
    if (pending === transfer && transfer.listeners.size === 0) {
      pending = undefined;
      transfer.controller.abort();
    }
  }
}
