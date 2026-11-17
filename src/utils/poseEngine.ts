import type { Landmark } from '../types';
import { humanPose } from './humanPose';
import {
  hasCollapsedBodySegment,
  hasForeshortenedTorso,
  hasUprightTorso,
  keepConsistentJoints,
  recoverCollapsedSegments,
  sameBodyRegion,
  VideoPoseTrack,
} from './poseRecovery';

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

function bodyCrop(points: Landmark[], aspect: number, padding = 2.6) {
  if (torsoJoints.filter((i) => visible(points[i])).length < 3) return;
  const observed = points.filter(visible);
  const xs = observed.map((point) => point.x);
  const ys = observed.map((point) => point.y);
  const left = Math.min(...xs),
    right = Math.max(...xs);
  const top = Math.min(...ys),
    bottom = Math.max(...ys);
  const span = Math.max((right - left) * aspect, bottom - top);
  const side = Math.max(0.24, padding * span);
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
type Retry =
  | { crop?: ReturnType<typeof bodyCrop>; strict?: boolean; mirrored?: never }
  | { mirrored: true; crop?: never; strict?: never };

export class PoseEngine {
  private worker = new Worker(`${import.meta.env.BASE_URL}pose-inference.worker.js`);
  private pending?: (error: Error) => void;
  private closed = false;
  private hadPose = false;
  private jointTimes = bodyJoints.map(() => -Infinity);
  private nextPartialRetry = 0;
  private nextRedetection = 0;
  private videoTrack?: VideoPoseTrack;

  constructor(source: 'camera' | 'file' = 'camera') {
    if (source === 'file') this.videoTrack = new VideoPoseTrack();
  }

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
    await this.request({ type: 'init', offline: !!this.videoTrack });
  }

  private async observe(
    bitmap: ImageBitmap,
    timestamp: number,
    preview: boolean,
    aspect: number,
    retry?: Retry,
  ) {
    const reply = await this.request(
      { type: 'detect', bitmap, timestamp, preview, redetect: !!retry, ...retry },
      bitmap,
      15_000,
    );
    if (reply.type !== 'result') throw new Error('本地姿态 Worker 未返回推理结果。');
    return { points: humanPose(reply.points, aspect), image: reply.bitmap };
  }

  async detect(
    bitmap: ImageBitmap,
    timestamp: number,
    preview = false,
    aspect = bitmap.width / bitmap.height,
  ) {
    // Retain the same frame for a bounded retry. A new loss can be
    // retried immediately, while sustained empty footage gets periodic retries.
    const canRetry = this.hadPose || timestamp >= this.nextRedetection;
    let { points, image } = await this.observe(
      bitmap,
      timestamp,
      preview || canRetry || !!this.videoTrack || timestamp >= this.nextPartialRetry,
      aspect,
    );
    let tracked = points;
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
    const recentPose = this.videoTrack?.recent(timestamp);
    const lossAnchor = lostPose ? recentPose : undefined;
    const bent = this.videoTrack && hasForeshortenedTorso(points, aspect);
    const recoverGeometry = this.videoTrack && hasCollapsedBodySegment(points, aspect);
    const partialCrop = this.videoTrack && (lostJoints || sparse) && bodyCrop(points, aspect);
    const crop =
      (lossAnchor ? bodyCrop(lossAnchor, aspect, 2) : undefined) ||
      (bent || recoverGeometry ? bodyCrop(points, aspect, 2) : partialCrop || undefined);
    if ((lostPose || lostJoints || crop || recoverGeometry || bent) && image) {
      if (lostPose) this.nextRedetection = timestamp + 400;
      if (lostPose || lostJoints || partialCrop)
        this.nextPartialRetry = timestamp + (this.videoTrack ? 160 : 300);
      const recovered = await this.observe(
        image,
        timestamp,
        preview || !!bent || !!lossAnchor,
        aspect,
        { crop, strict: !!this.videoTrack && lostPose && !lossAnchor },
      );
      const retry = recovered.points;
      image = recovered.image;
      if (lostPose) {
        if (retry.length && (!lossAnchor || sameBodyRegion(lossAnchor, retry, aspect))) {
          tracked = points = retry;
        } else if (image && lossAnchor) {
          const reflected = await this.observe(image, timestamp, true, aspect, { mirrored: true });
          image = reflected.image;
          if (image && sameBodyRegion(lossAnchor, reflected.points, aspect)) {
            // A single view can confidently invent limbs at full occlusion.
            // Confirm the reacquisition around the new proposal on this frame.
            let support = retry;
            if (!sameBodyRegion(reflected.points, support, aspect)) {
              const newCrop = bodyCrop(reflected.points, aspect, 2);
              if (newCrop || crop) {
                const confirmation = await this.observe(image, timestamp, preview, aspect, {
                  crop: newCrop,
                });
                support = confirmation.points;
                image = confirmation.image;
              }
            }
            if (sameBodyRegion(reflected.points, support, aspect)) {
              const confirmed = keepConsistentJoints(reflected.points, support, aspect);
              if (bodyJoints.some((i) => visible(confirmed[i]))) {
                points = confirmed;
                tracked = reflected.points;
              }
            }
          }
        }
      } else if (bent && retry.length) {
        points = keepConsistentJoints(points, retry, aspect);
        // The VIDEO graph can stay on the folded pose after the person has
        // stood up. Require the crop and full-frame observations to agree.
        if (
          image &&
          hasUprightTorso(retry, aspect) &&
          (sameBodyRegion(tracked, retry, aspect) ||
            (recentPose && sameBodyRegion(recentPose, retry, aspect)))
        ) {
          const full = await this.observe(image, timestamp, preview, aspect, { strict: true });
          image = full.image;
          if (hasUprightTorso(full.points, aspect) && sameBody(retry, full.points, aspect)) {
            tracked = points = full.points;
          } else {
            points = keepConsistentJoints(tracked, retry, aspect, full.points);
          }
        } else if (image && bodyJoints.filter((i) => visible(points[i])).length < 4) {
          const full = await this.observe(image, timestamp, preview, aspect, { mirrored: true });
          image = full.image;
          points = keepConsistentJoints(tracked, retry, aspect, full.points);
        }
      } else if (retry.length && points.length && sameBody(points, retry, aspect)) {
        // Both detections are from the same image. Keep the reliable tracked
        // observations and add only joints that the retry recovers.
        points = points.map((point, i) =>
          !visible(point) && visible(retry[i]) ? retry[i] : point,
        );
        if (recoverGeometry) points = recoverCollapsedSegments(points, retry, aspect);
      }
    }
    if (this.videoTrack && !this.videoTrack.accept(tracked, timestamp, aspect)) points = [];
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
