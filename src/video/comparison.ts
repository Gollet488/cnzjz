import { JOINTS, MAX_FRAMES } from '../config.ts';
import { OFFLINE_METRIC_VERSION, type Angles, type Landmark } from '../types.ts';
import { csvCells } from '../utils/csv.ts';
import { angleValue, channels } from '../utils/poseMath.ts';
import { presentationFrameIndices } from './timeline.ts';

export const COMPARISON_INTERVAL = 0.1;
export const COMPARISON_MAX_SKEW = 0.1;

export function comparisonSchedule(duration: number) {
  const interval = Math.max(COMPARISON_INTERVAL, duration / MAX_FRAMES);
  const slots =
    duration > 0 ? Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / interval - 1e-8))) : 0;
  return { interval, slots };
}

export type ComparisonPair = { slot: number; frames: number[]; times: number[] };

export function comparisonPairs(timelines: Float64Array[], starts: number[], duration: number) {
  const { interval, slots } = comparisonSchedule(duration);
  const byLane = timelines.map((timeline, lane) => {
    const selected = new Map<number, number>();
    const indices = presentationFrameIndices(timeline.length, MAX_FRAMES, (i) => timeline[i]);
    for (const index of indices) {
      const elapsed = timeline[index - 1] / 1e6 - starts[lane];
      if (elapsed < -1e-8 || elapsed >= duration - 1e-8) continue;
      const slot = Math.min(slots - 1, Math.floor((elapsed + 1e-8) / interval));
      if (!selected.has(slot)) selected.set(slot, index - 1);
    }
    return selected;
  });
  const pairs: ComparisonPair[] = [];
  for (const [slot, reference] of byLane[0]) {
    const candidate = byLane[1].get(slot);
    if (candidate === undefined) continue;
    const frames = [reference, candidate];
    const times = frames.map((index, lane) => timelines[lane][index] / 1e6);
    const skew = times[1] - starts[1] - (times[0] - starts[0]);
    if (Math.abs(skew) <= COMPARISON_MAX_SKEW + 1e-8) pairs.push({ slot, frames, times });
  }
  return pairs;
}

export const comparisonMeasurements = JOINTS.flatMap(({ key, label }) =>
  channels(key).map((side) => ({
    joint: key,
    side,
    label: side === 'midline' ? '脊柱中线' : `${side === 'left' ? '左' : '右'}${label}`,
  })),
);

export function comparisonReadings(angles: readonly Angles[]) {
  return comparisonMeasurements.map(({ joint, side }) => {
    const reference = angleValue(angles[0], joint, side);
    const candidate = angleValue(angles[1], joint, side);
    return {
      reference,
      candidate,
      delta: reference === null || candidate === null ? null : candidate - reference,
    };
  });
}

export interface ComparisonSample extends ComparisonPair {
  elapsed: number;
  skew: number;
  points: Landmark[][];
  angles: Angles[];
  rawAngles: Angles[];
  reliablePoints: number[];
  readings: ReturnType<typeof comparisonReadings>;
  distance: number | null;
}

export class ComparisonSeries {
  readonly samples: ComparisonSample[] = [];
  readonly peaks: (ComparisonSample | undefined)[] = [];
  readonly joints = comparisonMeasurements.map(() => ({
    reference: 0,
    candidate: 0,
    paired: 0,
    absoluteSum: 0,
  }));
  readonly poses = [0, 0];
  comparable = 0;
  distanceCount = 0;
  distanceSum = 0;

  append(sample: ComparisonSample) {
    this.samples.push(sample);
    sample.points.forEach((points, lane) => {
      if (points.length) this.poses[lane]++;
    });
    if (sample.distance !== null) {
      this.distanceCount++;
      this.distanceSum += sample.distance;
    }
    if (sample.readings.some(({ delta }) => delta !== null)) this.comparable++;
    sample.readings.forEach(({ reference, candidate, delta }, index) => {
      const joint = this.joints[index];
      if (reference !== null) joint.reference++;
      if (candidate !== null) joint.candidate++;
      if (delta === null) return;
      joint.paired++;
      joint.absoluteSum += Math.abs(delta);
      const previous = this.peaks[index]?.readings[index].delta;
      if (previous == null || Math.abs(delta) > Math.abs(previous)) this.peaks[index] = sample;
    });
  }
}

interface ComparisonExport {
  samples: readonly ComparisonSample[];
  interval: number;
  slots: number;
  reachedSlots: number;
  overlap: number;
  status: 'paused' | 'completed' | 'failed';
  threshold: number;
  window: number;
  sources: readonly {
    name: string;
    start: number;
    duration: number;
    width: number;
    height: number;
    transcoded: boolean;
  }[];
}

const timelineFields = [
  'reference_aligned_time_s',
  'reference_time_s',
  'candidate_time_s',
  'reference_time_basis',
  'candidate_time_basis',
  'candidate_minus_reference_aligned_s',
  'reference_pose_detected',
  'candidate_pose_detected',
  'reference_reliable_points',
  'candidate_reliable_points',
  'comparable_joints',
  'normalized_pose_distance',
];
const basisNames = ['raw', 'filtered'] as const;
const angleFields = basisNames.flatMap((basis) =>
  comparisonMeasurements.flatMap(({ joint, side }) =>
    ['reference', 'candidate', 'delta'].map((lane) => `${basis}_${joint}_${side}_${lane}_deg`),
  ),
);

export async function comparisonCSV(run: ComparisonExport, signal: AbortSignal) {
  signal.throwIfAborted();
  const { samples, interval, slots, reachedSlots, overlap, status, threshold, window, sources } =
    run;
  const sourceFields = ['file', 'start_s', 'duration_s', 'width_px', 'height_px', 'transcoded'];
  const csvFilename = (name: string) => (/^[\s]*[=+\-@]|^[\t\r\n]/.test(name) ? `'${name}` : name);
  const common = [
    OFFLINE_METRIC_VERSION,
    status,
    threshold,
    window,
    interval,
    COMPARISON_MAX_SKEW,
    overlap,
    ...sources.flatMap(({ name, start, duration, width, height, transcoded }) => [
      csvFilename(name),
      start,
      duration,
      width,
      height,
      transcoded,
    ]),
  ];
  const metadata = [
    'metric_version',
    'analysis_status',
    'confidence_threshold',
    'filter_window_samples',
    'target_interval_s',
    'max_pair_skew_s',
    'overlap_s',
    ...['reference', 'candidate'].flatMap((lane) =>
      sourceFields.map((field) => `${lane}_${field}`),
    ),
  ];
  const parts = [
    '\uFEFF' +
      csvCells([
        'slot',
        'slot_start_s',
        'sample_status',
        ...timelineFields,
        ...angleFields,
        ...metadata,
      ]),
  ];
  const missing = Array<null>(timelineFields.length + angleFields.length).fill(null);
  let cursor = 0;
  for (let start = 0; start < slots; start += 96) {
    let chunk = '';
    for (let slot = start; slot < Math.min(slots, start + 96); slot++) {
      const sample = samples[cursor]?.slot === slot ? samples[cursor++] : undefined;
      const state = sample ? 'paired' : slot < reachedSlots ? 'missed' : 'not_reached';
      const values = sample
        ? [
            sample.elapsed,
            ...sample.times,
            'decoded_frame',
            'decoded_frame',
            sample.skew,
            ...sample.points.map((points) => points.length > 0),
            ...sample.reliablePoints,
            sample.readings.filter(({ delta }) => delta !== null).length,
            sample.distance,
            ...[comparisonReadings(sample.rawAngles), sample.readings].flatMap((readings) =>
              readings.flatMap(({ reference, candidate, delta }) => [reference, candidate, delta]),
            ),
          ]
        : missing;
      chunk += '\r\n' + csvCells([slot + 1, slot * interval, state, ...values, ...common]);
    }
    parts.push(chunk);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
  return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}
