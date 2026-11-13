// Extensions supplement video/* because Windows often reports no video MIME for
// MKV, TS, RMVB and other containers. Content, rather than the suffix, is decoded.
export const VIDEO_ACCEPT =
  'video/*,.mp4,.m4v,.mov,.qt,.webm,.mkv,.avi,.flv,.f4v,.wmv,.asf,.mpg,.mpeg,.mpe,.m2v,.ts,.mts,.m2ts,.m2t,.3gp,.3g2,.ogv,.ogg,.vob,.rm,.rmvb,.divx,.dv,.mxf,.nut';
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
// A cold start downloads and compiles the 32 MB WASM core, possibly alongside a second input.
const CONVERTER_STARTUP_MS = 45_000;
const CONVERSION_MS = 10 * 60_000;

export interface PreparedVideo {
  file: File;
  transcoded: boolean;
}

function canDecode(file: File, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./probe.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('读取视频索引超时，请重新选择视频重试。'));
    }, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<boolean>) => {
      finish();
      resolve(data);
    };
    worker.onerror = worker.onmessageerror = () => {
      finish();
      reject(new Error('视频格式检查启动失败，请重新选择视频重试。'));
    };
    try {
      worker.postMessage(file);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export async function prepareVideo(
  file: File,
  signal: AbortSignal,
  status: (message: string) => void = () => {},
): Promise<PreparedVideo> {
  signal.throwIfAborted();
  if (!file.size) throw new Error('视频文件为空，请重新选择。');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('视频超过 500 MB，请先截取较短片段。');
  if (typeof VideoDecoder === 'undefined')
    throw new Error('此浏览器缺少 WebCodecs，请使用新版 Chrome/Edge 的 localhost 或 HTTPS。');
  status('正在检查视频格式…');
  if (await canDecode(file, signal)) return { file, transcoded: false };
  signal.throwIfAborted();
  status('正在加载本地视频转换器…');
  const { FFmpeg, FFFSType } = await import('@ffmpeg/ffmpeg');
  signal.throwIfAborted();
  const ffmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal.addEventListener('abort', abort, { once: true });
  // Terminate, rather than merely rejecting a promise, so cancellation releases
  // the WASM heap even while the synchronous encoder is running in its worker.
  let initializing = true;
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    abort();
  };
  let timer = setTimeout(expire, CONVERTER_STARTUP_MS);
  let diagnostic = '';
  ffmpeg.on('log', ({ message }) => {
    if (
      /error|invalid|unsupported|not found|failed|aborting/i.test(message) &&
      !/^Conversion failed/i.test(message)
    )
      diagnostic = message.slice(0, 240);
  });
  let reported = -1;
  ffmpeg.on('progress', ({ progress }) => {
    if (signal.aborted || !Number.isFinite(progress)) return;
    const percent = Math.round(Math.max(0, Math.min(0.99, progress)) * 100);
    if (percent <= reported) return;
    reported = percent;
    status(`正在本机转换视频… ${percent}%`);
  });
  try {
    await ffmpeg.load({
      classWorkerURL: `${import.meta.env.BASE_URL}ffmpeg/worker.js`,
      coreURL: `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.js`,
      wasmURL: `${import.meta.env.BASE_URL}ffmpeg/ffmpeg-core.wasm`,
    });
    signal.throwIfAborted();
    clearTimeout(timer);
    initializing = false;
    timer = setTimeout(expire, CONVERSION_MS);
    // Do not use user-provided names as virtual FS paths or command options.
    const suffix = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1] ?? 'video';
    const input = `input.${suffix}`;
    await ffmpeg.createDir('/source');
    const mounted = await ffmpeg.mount(
      FFFSType.WORKERFS,
      { blobs: [{ name: input, data: file }] },
      '/source',
    );
    if (!mounted) throw new Error('转换器无法读取本地文件。');
    signal.throwIfAborted();
    status('正在本机转换视频…');
    const code = await ffmpeg.exec([
      '-xerror',
      '-i',
      `/source/${input}`,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      "scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1,scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-bf',
      '0',
      '-fps_mode',
      'passthrough',
      // The guessed average FPS is not a safe encoder time base for VFR:
      // rounding to it can collapse two input PTS into one output timestamp.
      '-enc_time_base',
      '1:1000000',
      '-video_track_timescale',
      '1000000',
      'output.mp4',
    ]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(diagnostic || `转换器返回 ${code}`);
    const data = await ffmpeg.readFile('output.mp4');
    if (typeof data === 'string') throw new Error('转换输出不是视频数据。');
    // The read buffer is transferred out of the converter. Release its WASM
    // heap before validating the output index in a separate worker.
    ffmpeg.terminate();
    clearTimeout(timer);
    const converted = new File([data as Uint8Array<ArrayBuffer>], file.name, { type: 'video/mp4' });
    if (!(await canDecode(converted, signal)))
      throw new Error('当前浏览器无法解码转换后的 H.264 视频。');
    return { file: converted, transcoded: true };
  } catch (error) {
    signal.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    if (initializing)
      throw new Error(
        timedOut
          ? `视频转换器初始化超时（${CONVERTER_STARTUP_MS / 1000} 秒），已停止。请重新选择视频重试。`
          : `视频转换器加载失败：${detail}。请重新选择视频重试。`,
        { cause: error },
      );
    throw new Error(
      `视频转换失败：${timedOut ? '转换超过 10 分钟，已停止' : detail}。请检查文件是否损坏、加密或包含不受支持的编码；也可尝试缩短视频后重试。`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    ffmpeg.terminate();
  }
}
