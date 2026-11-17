import type { VideoProbe } from './protocol';

// Extensions supplement video/* because Windows often reports no video MIME for
// MKV, TS, RMVB and other containers. Content, rather than the suffix, is decoded.
export const VIDEO_ACCEPT =
  'video/*,.mp4,.m4v,.mov,.qt,.webm,.mkv,.avi,.flv,.f4v,.wmv,.asf,.mpg,.mpeg,.mpe,.m2v,.ts,.mts,.m2ts,.m2t,.3gp,.3g2,.ogv,.ogg,.vob,.rm,.rmvb,.divx,.dv,.mxf,.nut';
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONVERSION_BYTES = 500 * 1024 * 1024;
// A cold start downloads and compiles the 32 MB WASM core, possibly alongside a second input.
const CONVERTER_STARTUP_MS = 45_000;
const CONVERSION_MS = 10 * 60_000;

export interface PreparedVideo {
  file: File;
  transcoded: boolean;
  probe: VideoProbe;
}

function playableCodec(probe: VideoProbe | null) {
  return probe && document.createElement('video').canPlayType(`video/mp4; codecs="${probe.codec}"`);
}

function probeVideo(file: File, signal: AbortSignal): Promise<VideoProbe | null> {
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
    worker.onmessage = ({ data }: MessageEvent<VideoProbe | null>) => {
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
  if (file.size > MAX_VIDEO_BYTES) throw new Error('视频超过 2 GB，请先截取较短片段。');
  if (typeof VideoDecoder === 'undefined')
    throw new Error('此浏览器缺少 WebCodecs，请使用新版 Chrome/Edge 的 localhost 或 HTTPS。');
  status('正在检查视频格式…');
  const probe = await probeVideo(file, signal);
  if (probe && playableCodec(probe))
    return {
      file: file.type === 'video/mp4' ? file : new File([file], file.name, { type: 'video/mp4' }),
      transcoded: false,
      probe,
    };
  signal.throwIfAborted();
  if (file.size > MAX_CONVERSION_BYTES)
    throw new Error('该文件需要转换，但已超过 500 MB 转换上限。请先转为 H.264 MP4 或截取片段。');
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
  let reencoding = false;
  ffmpeg.on('log', ({ message }) => {
    if (
      reencoding &&
      /error|invalid|unsupported|not found|failed|aborting/i.test(message) &&
      !/^Conversion failed/i.test(message)
    )
      diagnostic = message.slice(0, 240);
  });
  let reported = -1;
  ffmpeg.on('progress', ({ progress }) => {
    if (!reencoding || signal.aborted || !Number.isFinite(progress)) return;
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
    const inputArgs = ['-xerror', '-i', `/source/${input}`, '-map', '0:v:0', '-an', '-sn', '-dn'];
    async function readOutput() {
      const data = await ffmpeg.readFile('output.mp4');
      if (typeof data === 'string') throw new Error('转换输出不是视频数据。');
      signal.throwIfAborted();
      return new File([data as Uint8Array<ArrayBuffer>], file.name, { type: 'video/mp4' });
    }
    if (!probe) {
      status('正在检查能否直接封装原视频轨道…');
      // A failed tag check is cheap for codecs that need to be re-encoded.
      const remuxCode = await ffmpeg.exec([
        ...inputArgs,
        '-c:v',
        'copy',
        '-tag:v',
        'avc1',
        '-video_track_timescale',
        '1000000',
        'output.mp4',
      ]);
      signal.throwIfAborted();
      if (remuxCode === 0) {
        const remuxed = await readOutput();
        await ffmpeg.deleteFile('output.mp4');
        const remuxProbe = await probeVideo(remuxed, signal);
        if (remuxProbe && playableCodec(remuxProbe))
          return { file: remuxed, transcoded: true, probe: remuxProbe };
      }
    }
    reencoding = true;
    status('正在本机转换视频…');
    // Cap the display-oriented raster at 1920×1080 (or 1080×1920 for portrait)
    // with one scale pass, including correction for non-square source pixels.
    const displayWidth = 'iw*sar';
    const landscape = `gte(${displayWidth},ih)`;
    const scale = `min(1,min(if(${landscape},1920,1080)/(${displayWidth}),if(${landscape},1080,1920)/ih))`;
    const filter = `scale=w='max(2,trunc(${displayWidth}*(${scale})/2)*2)':h='max(2,trunc(ih*ow/(${displayWidth})/2)*2)',setsar=1`;
    const code = await ffmpeg.exec([
      '-y',
      ...inputArgs,
      '-vf',
      filter,
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
    const converted = await readOutput();
    // The read buffer is transferred out of the converter. Release its WASM
    // heap before validating the output index in a separate worker.
    ffmpeg.terminate();
    clearTimeout(timer);
    const convertedProbe = await probeVideo(converted, signal);
    if (!convertedProbe) throw new Error('当前浏览器无法解码转换后的 H.264 视频。');
    return { file: converted, transcoded: true, probe: convertedProbe };
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
