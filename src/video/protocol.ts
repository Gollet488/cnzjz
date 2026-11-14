import type { Landmark } from '../types';

/** Inclusive, zero-based indices in the video's presentation order. */
export interface VideoClip {
  start: number;
  end: number;
}

export interface VideoProbe {
  timestamps: Float64Array;
  codec: string;
}
export interface OfflineMetadata {
  transcoded?: boolean;
  clipped?: boolean;
  codec: string;
  total: number;
  sampleTotal: number;
  firstTime: number;
  lastTime: number;
  aspect: number;
  rotation: number;
  mediaTimeOffset: number;
}
export type OfflineState =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'sampled'
  | 'cancelled'
  | 'truncated'
  | 'failed';
export type WorkerResult =
  | { type: 'metadata'; metadata: OfflineMetadata }
  | { type: 'decoding' }
  | { type: 'frame'; points: Landmark[]; time: number; index: number; preview?: ImageBitmap }
  | { type: 'done'; truncated: boolean; sampled?: boolean; count: number }
  | { type: 'error'; message: string };
