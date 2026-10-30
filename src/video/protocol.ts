import type { Landmark } from '../types';
export interface OfflineMetadata {
  codec: string;
  total: number;
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
  | 'cancelled'
  | 'truncated'
  | 'failed';
export type WorkerResult =
  | { type: 'metadata'; metadata: OfflineMetadata }
  | { type: 'frame'; points: Landmark[]; time: number; index: number; preview: ImageBitmap }
  | { type: 'done'; truncated: boolean; count: number }
  | { type: 'error'; message: string };
