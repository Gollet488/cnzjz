import { readMP4 } from './mp4';
import type { VideoProbe } from './protocol';

// Some platform decoders report HEVC support but reject the actual profile
// or coded dimensions. Test one keyframe before selecting the native path.
async function verifyHEVC(file: File, source: Awaited<ReturnType<typeof readMP4>>) {
  const sample = source.decode[0];
  const bytes = await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
  let decoder: VideoDecoder | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      timer = setTimeout(() => resolve(false), 3000);
      let decoded = false;
      decoder = new VideoDecoder({
        output(frame) {
          decoded = true;
          frame.close();
        },
        error: reject,
      });
      decoder.configure(source.config);
      decoder.decode(
        new EncodedVideoChunk({
          type: 'key',
          timestamp: sample.timestamp,
          duration: sample.durationUs,
          data: bytes,
        }),
      );
      decoder.flush().then(() => resolve(decoded), reject);
    });
  } finally {
    clearTimeout(timer);
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
}

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    const source = await readMP4(data);
    const support = await VideoDecoder.isConfigSupported(source.config);
    const hevc = /^(hvc1|hev1)\./.test(source.config.codec);
    if (!support.supported || (hevc && !(await verifyHEVC(data, source)))) {
      self.postMessage(null);
      return;
    }
    const timestamps = Float64Array.from(source.presentation, (frame) => frame.timestamp);
    self.postMessage({ timestamps, codec: source.config.codec } satisfies VideoProbe, {
      transfer: [timestamps.buffer],
    });
  } catch {
    self.postMessage(null);
  }
};
