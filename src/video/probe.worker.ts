import { readMP4 } from './mp4';

self.onmessage = async ({ data }: MessageEvent<File>) => {
  try {
    const source = await readMP4(data);
    const support = await VideoDecoder.isConfigSupported(source.config);
    self.postMessage(support.supported);
  } catch {
    self.postMessage(false);
  }
};
