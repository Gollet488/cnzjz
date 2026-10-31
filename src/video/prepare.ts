import { readMP4 } from './mp4.ts';

// Extensions supplement video/* because Windows often reports no video MIME for
// MKV, TS, RMVB and other containers. Content, rather than the suffix, is decoded.
export const VIDEO_ACCEPT =
  'video/*,.mp4,.m4v,.mov,.qt,.webm,.mkv,.avi,.flv,.f4v,.wmv,.asf,.mpg,.mpeg,.mpe,.m2v,.ts,.mts,.m2ts,.m2t,.3gp,.3g2,.ogv,.ogg,.vob,.rm,.rmvb,.divx,.dv,.mxf,.nut';
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export interface PreparedVideo {
  file: File;
  transcoded: boolean;
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
  const checkpoint = async () => signal.throwIfAborted();
  try {
    const source = await readMP4(file, checkpoint);
    const support = await VideoDecoder.isConfigSupported(source.config);
    signal.throwIfAborted();
    if (support.supported) return { file, transcoded: false };
  } catch (error) {
    signal.throwIfAborted();
    // Unsupported containers/codecs/transforms are normalized below. A damaged
    // input must also pass the converter and the normal MP4 validation.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
  }
  status('正在加载本地视频转换器…');
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  signal.throwIfAborted();
  const ffmpeg = new FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal.addEventListener('abort', abort, { once: true });
  // Terminate, rather than merely rejecting a promise, so cancellation releases
  // the WASM heap even while the synchronous encoder is running in its worker.
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    10 * 60 * 1000,
  );
  let diagnostic = '';
  ffmpeg.on('log', ({ message }) => {
    if (
      /error|invalid|unsupported|not found|failed|aborting/i.test(message) &&
      !/^Conversion failed/i.test(message)
    )
      diagnostic = message.slice(0, 240);
  });
  ffmpeg.on('progress', ({ progress }) => {
    if (!signal.aborted)
      status(`正在本机转换视频… ${Math.round(Math.max(0, Math.min(0.99, progress)) * 100)}%`);
  });
  try {
    await ffmpeg.load({
      classWorkerURL: '/ffmpeg/worker.js',
      coreURL: '/ffmpeg/ffmpeg-core.js',
      wasmURL: '/ffmpeg/ffmpeg-core.wasm',
    });
    signal.throwIfAborted();
    // Do not use user-provided names as virtual FS paths or command options.
    const suffix = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1] ?? 'video';
    const input = `input.${suffix}`;
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
    signal.throwIfAborted();
    status('正在本机转换视频…');
    const code = await ffmpeg.exec([
      '-xerror',
      '-i',
      input,
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
      '-movflags',
      '+faststart',
      'output.mp4',
    ]);
    signal.throwIfAborted();
    if (code !== 0) throw new Error(diagnostic || `转换器返回 ${code}`);
    const data = await ffmpeg.readFile('output.mp4');
    if (typeof data === 'string') throw new Error('转换输出不是视频数据。');
    const converted = new File([new Uint8Array(data)], file.name, { type: 'video/mp4' });
    const source = await readMP4(converted, checkpoint);
    const support = await VideoDecoder.isConfigSupported(source.config);
    signal.throwIfAborted();
    if (!support.supported) throw new Error('当前浏览器无法解码转换后的 H.264 视频。');
    return { file: converted, transcoded: true };
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `视频转换失败：${timedOut ? '转换超过 10 分钟，已停止' : error instanceof Error ? error.message : String(error)}。请检查文件是否损坏、加密或包含不受支持的编码；也可尝试缩短视频后重试。`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    ffmpeg.terminate();
  }
}
