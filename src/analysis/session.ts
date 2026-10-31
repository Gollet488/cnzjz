import type { AnalysisParameters, Landmark, PoseFrame, Source } from '../types.ts';
import { LandmarkFilter, measureFrame } from '../utils/poseMath.ts';

export const METRIC_VERSION = '2.0' as const;
export type SessionReference = { sessionId: string; revision: number };
export interface Acquisition {
  mode: 'webcodecs' | 'webcodecs-transcoded';
  status: 'preparing' | 'running' | 'paused' | 'completed' | 'cancelled' | 'truncated' | 'failed';
  expectedFrames: number | null;
  processedFrames: number;
  codec: string;
  rotation: number;
  mediaTimeOffset: number;
}
export interface SessionInfo extends SessionReference {
  source: Source;
  synthetic: boolean;
  parameters: AnalysisParameters;
  range: [number, number] | null;
  sampleCount: number;
  acquisition: Acquisition | null;
}
export function validateParameters(p: AnalysisParameters) {
  if (
    !Number.isFinite(p.threshold) ||
    p.threshold < 0 ||
    p.threshold > 1 ||
    !Number.isInteger(p.window) ||
    p.window < 1 ||
    p.window > 120 ||
    !Number.isFinite(p.aspect) ||
    p.aspect <= 0 ||
    p.metricVersion !== METRIC_VERSION
  )
    throw new Error('INVALID_PARAMETERS');
}

// One parameter snapshot per session revision. Recalculation replays saved source
// samples into a fresh pipeline, never through capture's timestamp deduplication.
export class AnalysisSession {
  private id = globalThis.crypto.randomUUID();
  private revision = 0;
  private data: PoseFrame[] = [];
  private parameters: AnalysisParameters;
  private source: Source;
  private filter = new LandmarkFilter();
  private rawHistory: Landmark[][] = [];
  private filteredHistory: Landmark[][] = [];
  private times: number[] = [];
  private acquisition: Acquisition | null = null;
  private syntheticFile = false;

  constructor(source: Source, parameters: AnalysisParameters) {
    validateParameters(parameters);
    this.source = source;
    this.parameters = { ...parameters };
  }
  get frames() {
    return this.data;
  }
  info(): SessionInfo {
    return {
      sessionId: this.id,
      revision: this.revision,
      source: this.source,
      synthetic: this.source === 'demo' || this.syntheticFile,
      parameters: { ...this.parameters },
      range: this.data.length ? [this.data[0].time, this.data.at(-1)!.time] : null,
      sampleCount: this.data.length,
      acquisition: this.acquisition
        ? { ...this.acquisition, processedFrames: this.data.length }
        : null,
    };
  }
  assertCurrent(ref: SessionReference) {
    if (ref.sessionId !== this.id || ref.revision !== this.revision)
      throw new Error('STALE_SESSION');
  }
  private clearPipeline() {
    this.filter.clear();
    this.rawHistory = [];
    this.filteredHistory = [];
    this.times = [];
  }
  reset(source = this.source, parameters = this.parameters) {
    validateParameters(parameters);
    this.id = globalThis.crypto.randomUUID();
    this.revision = 0;
    this.source = source;
    this.parameters = { ...parameters };
    this.data = [];
    this.acquisition = null;
    this.syntheticFile = false;
    this.clearPipeline();
  }
  // Uploaded pixels can also be generated. Explicit provenance is versioned,
  // independent of real MediaPipe inference, and never inferred from a filename.
  setFileSynthetic(value: boolean, reference: SessionReference = this.info()) {
    this.assertCurrent(reference);
    if (this.source !== 'file' || typeof value !== 'boolean') throw new Error('INVALID_PROVENANCE');
    if (this.syntheticFile === value) return;
    this.syntheticFile = value;
    this.revision++;
  }
  setAcquisition(value: Acquisition, reference: SessionReference = this.info()) {
    this.assertCurrent(reference);
    this.acquisition = { ...value };
    this.revision++;
  }
  append(points: Landmark[], time: number, reference: SessionReference = this.info()): boolean {
    this.assertCurrent(reference);
    if (!Number.isFinite(time) || time < 0) throw new Error('INVALID_TIME');
    if (this.data.length && time <= this.data.at(-1)!.time) return false;
    if (
      points.length !== 0 &&
      (points.length !== 33 ||
        points.some(
          (p) =>
            ![p.x, p.y, p.z, p.visibility].every(Number.isFinite) ||
            p.visibility < 0 ||
            p.visibility > 1,
        ))
    )
      throw new Error('INVALID_LANDMARKS');
    this.add(points, time);
    this.revision++;
    return true;
  }
  private add(points: Landmark[], time: number) {
    const raw = points.map((p) => ({ ...p }));
    if (!raw.length) this.clearPipeline();
    const filtered = raw.length
      ? this.filter.apply(raw, this.parameters.window, this.parameters.threshold)
      : [];
    if (raw.length) {
      this.rawHistory.push(raw);
      this.filteredHistory.push(filtered);
      this.times.push(time);
      this.rawHistory = this.rawHistory.slice(-this.parameters.window);
      this.filteredHistory = this.filteredHistory.slice(-this.parameters.window);
      this.times = this.times.slice(-this.parameters.window);
    }
    this.data.push(
      measureFrame(
        filtered,
        time,
        this.data.at(-1),
        this.filteredHistory,
        this.parameters.threshold,
        this.parameters.aspect,
        raw,
        this.rawHistory,
        [this.times[0] ?? time, time],
      ),
    );
  }
  recalculate(parameters: AnalysisParameters, reference: SessionReference = this.info()) {
    this.assertCurrent(reference);
    validateParameters(parameters);
    const samples = this.data;
    this.parameters = { ...parameters };
    this.data = [];
    this.clearPipeline();
    for (const f of samples) this.add(f.rawPoints, f.time);
    this.revision++;
    return this.info();
  }
}
