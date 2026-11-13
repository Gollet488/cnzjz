import type { Landmark } from '../types';
import { humanPose } from './humanPose';

type Reply =
  | { type: 'ready' }
  | { type: 'result'; points: Landmark[]; bitmap?: ImageBitmap }
  | { type: 'error'; message: string };

export class PoseEngine {
  private worker = new Worker(`${import.meta.env.BASE_URL}pose-inference.worker.js`);
  private pending?: (error: Error) => void;
  private closed = false;
  private hadPose = false;
  private lostPose = false;
  private nextRedetection = 0;

  private request(message: object, bitmap?: ImageBitmap, timeout = 30_000) {
    return new Promise<Reply>((resolve, reject) => {
      if (this.closed || this.pending) {
        bitmap?.close();
        reject(new Error('本地姿态模型不可用。'));
        return;
      }
      const clear = () => {
        clearTimeout(timer);
        this.pending = undefined;
      };
      const fail = (error: Error) => {
        clear();
        this.close();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('本地姿态模型响应超时。')), timeout);
      this.pending = fail;
      this.worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if (data.type === 'error') fail(new Error(data.message));
        else {
          clear();
          resolve(data);
        }
      };
      this.worker.onerror = (event) =>
        fail(new Error(event.message || '本地姿态 Worker 加载失败。'));
      this.worker.onmessageerror = () => fail(new Error('本地姿态 Worker 返回的数据不可读取。'));
      try {
        this.worker.postMessage(message, bitmap ? [bitmap] : []);
      } catch (error) {
        bitmap?.close();
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async ready() {
    await this.request({ type: 'init' });
  }

  async detect(
    bitmap: ImageBitmap,
    timestamp: number,
    preview = false,
    aspect = bitmap.width / bitmap.height,
  ) {
    // Refresh the region from the whole image after a loss. Keep this bounded:
    // continuous empty footage stays on the ordinary video path.
    const redetect = this.lostPose && timestamp >= this.nextRedetection;
    if (redetect) {
      this.lostPose = false;
      this.nextRedetection = timestamp + 1000;
    }
    const reply = await this.request(
      { type: 'detect', bitmap, timestamp, preview, redetect },
      bitmap,
      15_000,
    );
    if (reply.type !== 'result') throw new Error('本地姿态 Worker 未返回推理结果。');
    const points = humanPose(reply.points, aspect);
    if (this.hadPose && !points.length) this.lostPose = true;
    if (points.length) this.lostPose = false;
    this.hadPose = points.length > 0;
    return { points, preview: reply.bitmap };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.pending?.(new Error('本地姿态任务已停止。'));
  }
}
