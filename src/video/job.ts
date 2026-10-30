import type { OfflineMetadata, OfflineState, WorkerResult } from './protocol';

interface JobCallbacks {
  metadata(value: OfflineMetadata): void;
  frame(value: Extract<WorkerResult, { type: 'frame' }>): boolean | void;
  state(value: OfflineState, message?: string): void;
}

export class OfflineVideoJob {
  private worker: Worker;
  private active = true;
  private paused = false;
  private pending?: Extract<WorkerResult, { type: 'frame' }>;
  private callbacks: JobCallbacks;
  constructor(file: File, limit: number, callbacks: JobCallbacks) {
    this.callbacks = callbacks;
    this.worker = new Worker(new URL('./offline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResult>) => {
      if (!this.active) {
        if (data.type === 'frame') data.preview.close();
        return;
      }
      if (data.type === 'metadata') callbacks.metadata(data.metadata);
      if (data.type === 'frame') {
        if (this.pending) {
          data.preview.close();
          this.finish('failed', '离线 Worker 未等待交付确认，已停止以保护帧序列。');
        } else if (this.paused) this.pending = data;
        else this.deliver(data);
      }
      if (data.type === 'done') this.finish(data.truncated ? 'truncated' : 'completed');
      if (data.type === 'error') this.finish('failed', data.message);
    };
    this.worker.onerror = (event) => this.finish('failed', `离线 Worker 失败：${event.message}`);
    callbacks.state('preparing');
    this.worker.postMessage({ type: 'start', file, limit });
  }
  private deliver(data: Extract<WorkerResult, { type: 'frame' }>) {
    // Delivery and session append are synchronous. No async result can cross a
    // cancelled client; ack keeps at most one uncommitted result on the UI side.
    if (this.callbacks.frame(data) === false) {
      this.finish('failed', '会话拒收当前帧，已停止；不能将缺帧结果标记为完整。');
      return;
    }
    if (this.active) this.worker.postMessage({ type: 'ack' });
  }
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.worker.postMessage({ type: 'pause' });
    this.callbacks.state('paused');
  }
  resume() {
    if (!this.active) return;
    this.paused = false;
    this.callbacks.state('running');
    if (this.pending) {
      const data = this.pending;
      this.pending = undefined;
      this.deliver(data);
    }
    this.worker.postMessage({ type: 'resume' });
  }
  private finish(state: OfflineState, message?: string) {
    if (!this.active) return;
    this.active = false;
    this.pending?.preview.close();
    this.pending = undefined;
    this.worker.terminate();
    this.callbacks.state(state, message);
  }
  cancel() {
    this.finish('cancelled');
  }
}
