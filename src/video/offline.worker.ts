import { readMP4 } from './mp4';
import { PresentationAudit } from './timeline';
import type { Landmark } from '../types';
import type { WorkerResult } from './protocol';

const scope = self as unknown as {
  postMessage(value: WorkerResult, transfer?: Transferable[]): void;
};
let paused = false;
let acknowledged = true;
let stopped = false;
let fatal: Error | undefined;
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 8));
async function checkpoint() {
  while (paused && !stopped && !fatal) await sleep();
  if (fatal) throw fatal;
  if (stopped) throw new Error('CANCELLED');
}
let inference: Worker | undefined;
function infer(message: object, transfer: Transferable[] = []): Promise<{ points: Landmark[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('姿态 Worker 超时（60 秒）。')), 60000);
    inference!.onmessage = ({ data }) => {
      clearTimeout(timeout);
      if (data.type === 'error') reject(new Error(data.message));
      else resolve(data);
    };
    inference!.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`姿态 Worker 加载失败：${e.message}`));
    };
    inference!.postMessage(message, transfer);
  });
}
self.onmessage = ({ data }) => {
  if (data.type === 'pause') paused = true;
  if (data.type === 'resume') paused = false;
  if (data.type === 'ack') acknowledged = true;
  if (data.type === 'cancel') {
    stopped = true;
    paused = false;
  }
  if (data.type === 'start') void run(data.file, data.limit);
};
async function run(file: File, limit: number) {
  let decoder: VideoDecoder | undefined;
  const queue: VideoFrame[] = [];
  let outputCount = 0,
    inputCount = 0,
    inputDone = false;
  try {
    if (typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined')
      throw new Error(
        '此浏览器缺少 WebCodecs/OffscreenCanvas Worker 支持，请使用新版 Chrome/Edge 的 localhost 或 HTTPS。',
      );
    const source = await readMP4(file, checkpoint);
    const support = await VideoDecoder.isConfigSupported(source.config);
    if (!support.supported)
      throw new Error(`浏览器不支持解码 ${source.config.codec}，未降级为播放采样。`);
    scope.postMessage({
      type: 'metadata',
      metadata: {
        codec: source.config.codec,
        total: source.presentation.length,
        firstTime: source.presentation[0].timestamp / 1e6,
        lastTime: source.presentation.at(-1)!.timestamp / 1e6,
        aspect: source.aspect,
        rotation: source.rotation,
        mediaTimeOffset: source.mediaTimeOffset,
      },
    });
    inference = new Worker('/pose-inference.worker.js');
    await infer({ type: 'init' });
    await checkpoint();
    const expected = new Set(source.presentation.map((s) => s.timestamp));
    const audit = new PresentationAudit(source.presentation.map((s) => s.timestamp));
    const budget = Math.max(
      4,
      Math.min(
        24,
        Math.floor((128 * 1024 * 1024) / (source.displayWidth * source.displayHeight * 4)),
      ),
    );
    decoder = new VideoDecoder({
      output(frame) {
        outputCount++;
        if (stopped || fatal) {
          frame.close();
          return;
        }
        queue.push(frame);
        if (queue.length > budget)
          fatal = new Error('解码输出超过有界队列，已停止；未丢帧或宣称完成。');
      },
      error(error) {
        fatal = error;
      },
    });
    decoder.configure(source.config);
    // Read/decode and consume concurrently in this worker. The output callback
    // cannot await: outstanding encoded inputs + decoded outputs share a budget.
    const feed = (async () => {
      try {
        for (const sample of source.decode) {
          await checkpoint();
          let waitSince = Date.now();
          while (inputCount - outputCount + queue.length >= budget) {
            const before = Date.now();
            await checkpoint();
            waitSince += Date.now() - before;
            await sleep();
            if (Date.now() - waitSince > 60000)
              throw new Error('解码队列超时；可能是浏览器解码资源不足。');
          }
          const bytes = await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer();
          await checkpoint();
          decoder!.decode(
            new EncodedVideoChunk({
              type: sample.is_sync ? 'key' : 'delta',
              timestamp: sample.timestamp,
              duration: sample.durationUs,
              data: bytes,
            }),
          );
          inputCount++;
        }
        await decoder!.flush(); // Includes delayed B frames and the final frame.
      } catch (error) {
        if (!stopped) fatal = error instanceof Error ? error : new Error(String(error));
      } finally {
        inputDone = true;
      }
    })();
    const outWidth = source.rotation % 180 ? source.displayHeight : source.displayWidth;
    const outHeight = source.rotation % 180 ? source.displayWidth : source.displayHeight;
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d')!;
    let lastOutput = -Infinity;
    let lastActivity = Date.now();
    while (!inputDone || queue.length) {
      const before = Date.now();
      await checkpoint();
      lastActivity += Date.now() - before;
      if (!queue.length) {
        await sleep();
        if (Date.now() - lastActivity > 60000) throw new Error('解码长时间没有输出。');
        continue;
      }
      const frame = queue.shift()!;
      const timestamp = frame.timestamp;
      try {
        if (timestamp <= lastOutput) throw new Error('解码器未按呈现顺序输出，已停止以保护时序。');
        lastOutput = timestamp;
        if (!expected.has(timestamp)) continue; // Edit-list preroll/outro.
        audit.accept(timestamp);
        ctx.save();
        ctx.translate(outWidth / 2, outHeight / 2);
        ctx.rotate((source.rotation * Math.PI) / 180);
        ctx.drawImage(
          frame,
          -source.displayWidth / 2,
          -source.displayHeight / 2,
          source.displayWidth,
          source.displayHeight,
        );
        ctx.restore();
      } finally {
        frame.close();
      }
      if (!expected.has(timestamp)) continue;
      // A fresh MediaPipe instance per decode run: source PTS + 1 ms is strictly
      // monotonic even at PTS zero. Wall-clock/performance time is never used.
      const bitmap = await createImageBitmap(canvas);
      const result = await infer({ type: 'detect', bitmap, timestamp: timestamp / 1000 + 1 }, [
        bitmap,
      ]);
      await checkpoint();
      const preview = canvas.transferToImageBitmap();
      acknowledged = false;
      scope.postMessage(
        {
          type: 'frame',
          points: result.points,
          time: timestamp / 1e6,
          index: audit.count,
          preview,
        },
        [preview],
      );
      while (!acknowledged) {
        await checkpoint();
        await sleep();
      }
      lastActivity = Date.now();
      if (audit.count >= limit && audit.count < source.presentation.length) {
        stopped = true;
        scope.postMessage({ type: 'done', truncated: true, count: audit.count });
        break;
      }
    }
    if (!stopped) {
      await feed;
      await checkpoint();
      if (outputCount !== source.decode.length)
        throw new Error(`解码样本数不匹配：${outputCount}/${source.decode.length}。`);
      audit.finish();
      scope.postMessage({ type: 'done', truncated: false, count: audit.count });
    }
  } catch (error) {
    if (!stopped)
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
  } finally {
    stopped = true;
    inference?.terminate();
    if (decoder && decoder.state !== 'closed') decoder.close();
    queue.forEach((f) => f.close());
  }
}
