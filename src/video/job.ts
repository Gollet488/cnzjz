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
  private watchdog?: ReturnType<typeof setTimeout>;
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
      if (!this.paused) this.watch();
      if (data.type === 'metadata') callbacks.metadata(data.metadata);
      if (data.type === 'frame') {
        if (this.pending) {
          data.preview.close();
          this.finish('failed', '离线 Worker 未等待交付确认，已停止以保护帧序列。');
        } else if (this.paused) this.pending = data;
        else this.deliver(data);
      }
      if (data.type === 'done')
        this.finish(data.truncated ? 'truncated' : data.sampled ? 'sampled' : 'completed');
      if (data.type === 'error') this.finish('failed', data.message);
    };
    this.worker.onerror = (event) => this.finish('failed', `离线 Worker 失败：${event.message}`);
    this.worker.onmessageerror = () => this.finish('failed', '无法读取离线分析结果。');
    callbacks.state('preparing');
    try {
      this.worker.postMessage({ type: 'start', file, limit });
      this.watch();
    } catch (error) {
      this.worker.terminate();
      throw error;
    }
  }
  private watch() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => this.finish('failed', '离线分析 60 秒内没有进展，可重新开始分析或更换视频。'),
      60_000,
    );
  }
  private deliver(data: Extract<WorkerResult, { type: 'frame' }>) {
    // Delivery and session append are synchronous. No async result can cross a
    // cancelled client; ack keeps at most one uncommitted result on the UI side.
    try {
      if (this.callbacks.frame(data) === false) {
        data.preview.close();
        this.finish('failed', '会话拒收当前帧，已停止；不能将缺帧结果标记为完整。');
        return;
      }
      if (this.active) this.worker.postMessage({ type: 'ack' });
    } catch (error) {
      data.preview.close();
      this.finish('failed', error instanceof Error ? error.message : String(error));
    }
  }
  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    clearTimeout(this.watchdog);
    this.worker.postMessage({ type: 'pause' });
    this.callbacks.state('paused');
  }
  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.watch();
    this.callbacks.state('running');
    if (this.pending) {
      const data = this.pending;
      this.pending = undefined;
      this.deliver(data);
    }
    if (this.active) this.worker.postMessage({ type: 'resume' });
  }
  private finish(state: OfflineState, message?: string) {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.watchdog);
    this.pending?.preview.close();
    this.pending = undefined;
    this.worker.terminate();
    this.callbacks.state(state, message);
  }
  cancel() {
    this.finish('cancelled');
  }
}
