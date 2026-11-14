import type { Landmark } from '../types';
import { humanPose } from './humanPose';

const bodyJoints = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const torsoJoints = [11, 12, 23, 24];
const visible = (point: Landmark) => point.visibility >= 0.5;
const distance = (a: Landmark, b: Landmark, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function sameBody(current: Landmark[], retry: Landmark[], aspect: number) {
  const shared = bodyJoints.filter((i) => visible(current[i]) && visible(retry[i]));
  const torso = shared.filter((i) => torsoJoints.includes(i));
  const anchors = torso.length >= 2 ? torso : shared;
  if (torso.length < 2 && anchors.length < 3) return false;
  const scale = Math.max(...anchors.map((i) => distance(current[anchors[0]], current[i], aspect)));
  const tolerance = Math.max(0.025, Math.min(0.1, scale / 3));
  return anchors.every((i) => distance(current[i], retry[i], aspect) <= tolerance);
}

function bodyCrop(points: Landmark[], aspect: number) {
  if (torsoJoints.filter((i) => visible(points[i])).length < 3) return;
  const observed = points.filter(visible);
  const xs = observed.map((point) => point.x);
  const ys = observed.map((point) => point.y);
  const left = Math.min(...xs),
    right = Math.max(...xs);
  const top = Math.min(...ys),
    bottom = Math.max(...ys);
  const span = Math.max((right - left) * aspect, bottom - top);
  const side = Math.max(0.24, 2.6 * span);
  const width = Math.min(1, side / aspect),
    height = Math.min(1, side);
  if (width * height > 0.65) return;
  return {
    x: Math.min(1 - width, Math.max(0, (left + right - width) / 2)),
    y: Math.min(1 - height, Math.max(0, (top + bottom - height) / 2)),
    width,
    height,
  };
}

type Reply =
  | { type: 'ready' }
  | { type: 'result'; points: Landmark[]; bitmap?: ImageBitmap }
  | { type: 'error'; message: string };

export class PoseEngine {
  private worker = new Worker(`${import.meta.env.BASE_URL}pose-inference.worker.js`);
  private pending?: (error: Error) => void;
  private closed = false;
  private hadPose = false;
  private jointTimes = bodyJoints.map(() => -Infinity);
  private nextPartialRetry = 0;
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
    assistSmallSubjects = false,
  ) {
    // Retain the same frame for a bounded retry. A new loss can be
    // retried immediately, while sustained empty footage gets periodic retries.
    const canRetry = this.hadPose || timestamp >= this.nextRedetection;
    const reply = await this.request(
      {
        type: 'detect',
        bitmap,
        timestamp,
        preview: preview || canRetry || timestamp >= this.nextPartialRetry,
        redetect: false,
      },
      bitmap,
      15_000,
    );
    if (reply.type !== 'result') throw new Error('本地姿态 Worker 未返回推理结果。');
    let points = humanPose(reply.points, aspect);
    let image = reply.bitmap;
    const lostPose = !points.length && canRetry;
    const partial = points.length > 0 && timestamp >= this.nextPartialRetry;
    // Count each recently visible joint separately so new detections cannot
    // hide the loss of another joint.
    const lostJoints =
      partial &&
      bodyJoints.some(
        (joint, i) => timestamp - this.jointTimes[i] <= 800 && !visible(points[joint]),
      );
    const sparse = partial && bodyJoints.filter((joint) => visible(points[joint])).length <= 6;
    const crop =
      assistSmallSubjects && (lostJoints || sparse) ? bodyCrop(points, aspect) : undefined;
    if ((lostPose || lostJoints || crop) && image) {
      if (lostPose) this.nextRedetection = timestamp + 400;
      this.nextPartialRetry = timestamp + (assistSmallSubjects ? 160 : 300);
      const recovered = await this.request(
        { type: 'detect', bitmap: image, timestamp, preview, redetect: true, crop },
        image,
        15_000,
      );
      if (recovered.type !== 'result') throw new Error('本地姿态 Worker 未返回重新检测结果。');
      const retry = humanPose(recovered.points, aspect);
      if (retry.length && lostPose) {
        points = retry;
      } else if (retry.length && points.length && sameBody(points, retry, aspect)) {
        // Both detections are from the same image. Keep the reliable tracked
        // observations and add only joints that the retry recovers.
        points = points.map((point, i) =>
          !visible(point) && visible(retry[i]) ? retry[i] : point,
        );
      }
      image = recovered.bitmap;
    }
    this.hadPose = points.length > 0;
    if (this.hadPose)
      bodyJoints.forEach((joint, i) => {
        if (visible(points[joint])) this.jointTimes[i] = timestamp;
      });
    if (!preview) image?.close();
    return { points, preview: preview ? image : undefined };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.pending?.(new Error('本地姿态任务已停止。'));
  }
}
