import { readMP4 } from './mp4';
import { analysisFrameIndices, PresentationAudit } from './timeline';
import { PoseEngine } from '../utils/poseEngine';
import type { WorkerResult } from './protocol';

const scope = self as unknown as {
  postMessage(value: WorkerResult, transfer?: Transferable[]): void;
};
let paused = false;
let acknowledged = true;
let stopped = false;
let fatal: Error | undefined;
let wake: () => void;
let change: Promise<void>;
function notify() {
  wake?.();
  change = new Promise((resolve) => {
    wake = resolve;
  });
}
notify();
async function checkpoint() {
  while (paused && !stopped && !fatal) await change;
  if (fatal) throw fatal;
  if (stopped) throw new Error('CANCELLED');
}
self.onmessage = ({ data }) => {
  if (data.type === 'pause') paused = true;
  if (data.type === 'resume') paused = false;
  if (data.type === 'ack') acknowledged = true;
  if (data.type === 'cancel') {
    stopped = true;
    paused = false;
  }
  notify();
  if (data.type === 'start') void run(data.file, data.limit);
};
async function run(file: File, limit: number) {
  let decoder: VideoDecoder | undefined;
  let inference: PoseEngine | undefined;
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
    const indices = analysisFrameIndices(source.presentation.length, limit);
    scope.postMessage({
      type: 'metadata',
      metadata: {
        codec: source.config.codec,
        total: source.presentation.length,
        sampleTotal: indices.length,
        firstTime: source.presentation[0].timestamp / 1e6,
        lastTime: source.presentation.at(-1)!.timestamp / 1e6,
        aspect: source.aspect,
        rotation: source.rotation,
        mediaTimeOffset: source.mediaTimeOffset,
      },
    });
    inference = new PoseEngine();
    await inference.ready();
    await checkpoint();
    const timestamps = source.presentation.map((s) => s.timestamp);
    const expected = new Set(timestamps);
    const audit = new PresentationAudit(timestamps);
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
        if (queue.length > Math.max(budget, 20))
          fatal = new Error('解码输出超过有界队列，已停止；未丢帧或宣称完成。');
        notify();
      },
      error(error) {
        fatal = error;
        notify();
      },
    });
    decoder.configure(source.config);
    // Read/decode and consume concurrently in this worker. The output callback
    // cannot await: outstanding encoded inputs + decoded outputs share a budget.
    const feed = (async () => {
      try {
        let blockStart = -1;
        let block = new Uint8Array();
        for (const sample of source.decode) {
          await checkpoint();
          // A decoder may buffer reference frames before producing anything.
          // Allow additional input when the consumer has no output to drain.
          while (
            inputCount - outputCount + queue.length >=
            (queue.length ? budget : Math.max(budget, 20))
          ) {
            await change;
            await checkpoint();
          }
          const end = sample.offset + sample.size;
          if (sample.offset < blockStart || end > blockStart + block.byteLength) {
            blockStart = sample.offset;
            block = new Uint8Array(
              await file.slice(blockStart, Math.max(end, blockStart + 1024 * 1024)).arrayBuffer(),
            );
          }
          const bytes = block.subarray(sample.offset - blockStart, end - blockStart);
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
        notify();
      }
    })();
    const scale = Math.min(1, 1280 / Math.max(source.displayWidth, source.displayHeight));
    const width = Math.max(1, Math.round(source.displayWidth * scale));
    const height = Math.max(1, Math.round(source.displayHeight * scale));
    const outWidth = source.rotation % 180 ? height : width;
    const outHeight = source.rotation % 180 ? width : height;
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext('2d')!;
    let lastOutput = -Infinity;
    let analyzed = 0;
    while (!inputDone || queue.length) {
      await checkpoint();
      if (!queue.length) {
        if (!inputDone) await change;
        continue;
      }
      const frame = queue.shift()!;
      notify();
      const timestamp = frame.timestamp;
      try {
        if (timestamp <= lastOutput) throw new Error('解码器未按呈现顺序输出，已停止以保护时序。');
        lastOutput = timestamp;
        if (!expected.has(timestamp)) continue; // Edit-list preroll/outro.
        audit.accept(timestamp);
        if (audit.count !== indices[analyzed]) continue;
        ctx.save();
        ctx.translate(outWidth / 2, outHeight / 2);
        ctx.rotate((source.rotation * Math.PI) / 180);
        ctx.drawImage(frame, -width / 2, -height / 2, width, height);
        ctx.restore();
      } finally {
        frame.close();
      }
      // A fresh MediaPipe instance per decode run: source PTS + 1 ms is strictly
      // monotonic even at PTS zero. Wall-clock/performance time is never used.
      const result = await inference.detect(
        canvas.transferToImageBitmap(),
        timestamp / 1000 + 1,
        true,
        source.aspect,
      );
      const preview = result.preview;
      if (!preview) throw new Error('本地姿态 Worker 未返回预览画面。');
      try {
        await checkpoint();
      } catch (error) {
        preview.close();
        throw error;
      }
      acknowledged = false;
      scope.postMessage(
        {
          type: 'frame',
          points: result.points,
          time: timestamp / 1e6,
          index: ++analyzed,
          preview,
        },
        [preview],
      );
      while (!acknowledged && !fatal && !stopped) await change;
    }
    if (!stopped) {
      await feed;
      await checkpoint();
      if (outputCount !== source.decode.length)
        throw new Error(`解码样本数不匹配：${outputCount}/${source.decode.length}。`);
      audit.finish();
      scope.postMessage({
        type: 'done',
        truncated: false,
        sampled: analyzed !== audit.count,
        count: analyzed,
      });
    }
  } catch (error) {
    if (!stopped)
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
  } finally {
    stopped = true;
    inference?.close();
    notify();
    if (decoder && decoder.state !== 'closed') decoder.close();
    queue.forEach((f) => f.close());
  }
}
