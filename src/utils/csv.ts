import type { PoseFrame, Marker } from '../types.ts';
import type { SessionInfo } from '../analysis/session.ts';
import { angleValue, channels } from './poseMath.ts';
import { JOINTS, POINT_NAMES } from '../config.ts';
function cells(values: readonly unknown[]) {
  // Quote the joined row once, instead of allocating 354 individually wrapped
  // strings. Escaping, empty cells and String(number)'s precision are unchanged.
  return '"' + values.map((value) => String(value ?? '').replace(/"/g, '""')).join('","') + '"';
}
export function csvHeader() {
  return [
    'time_s',
    'session_id',
    'session_revision',
    'source',
    'synthetic',
    'metric_version',
    'confidence_threshold',
    'filter_window_frames',
    'source_aspect',
    'acquisition_mode',
    'acquisition_status',
    'source_expected_frames',
    'source_processed_frames',
    'source_codec',
    'source_rotation_deg',
    'media_time_offset_s',
    'confidence',
    'center_x',
    'center_y',
    'asymmetry_percent',
    'window_start_s',
    'window_end_s',
    ...['raw', 'filtered'].flatMap((basis) =>
      [
        'coordinate_variance_norm2',
        'window_frames',
        'valid_points',
        'valid_point_samples',
        'min_samples_per_point',
        'max_samples_per_point',
      ].map((field) => `${basis}_${field}`),
    ),
    'shoulder_height_delta',
    'hip_height_delta',
    'knee_height_delta',
    ...['raw', 'filtered'].flatMap((prefix) =>
      POINT_NAMES.flatMap((n) => ['x', 'y', 'z', 'visibility'].map((k) => `${prefix}_${n}_${k}`)),
    ),
    ...['raw', 'filtered'].flatMap((basis) =>
      JOINTS.flatMap((j) =>
        channels(j.key).flatMap((side) => [
          `${basis}_${j.key}_${side}_deg`,
          `${basis}_${j.key}_${side}_velocity_deg_s`,
        ]),
      ),
    ),
    'markers',
  ];
}
function csvRow(f: PoseFrame, labels: string, session: SessionInfo) {
  return [
    f.time,
    session.sessionId,
    session.revision,
    session.source,
    session.synthetic,
    session.parameters.metricVersion,
    session.parameters.threshold,
    session.parameters.window,
    session.parameters.aspect,
    session.acquisition?.mode,
    session.acquisition?.status,
    session.acquisition?.expectedFrames,
    session.acquisition?.processedFrames,
    session.acquisition?.codec,
    session.acquisition?.rotation,
    session.acquisition?.mediaTimeOffset,
    f.confidence,
    f.center?.x,
    f.center?.y,
    f.asymmetry,
    ...f.windowInterval,
    ...(['raw', 'filtered'] as const).flatMap((basis) => {
      const v = f.variance[basis];
      return [
        v.value,
        v.windowFrames,
        v.validPoints,
        v.validSamples,
        v.minSamplesPerPoint,
        v.maxSamplesPerPoint,
      ];
    }),
    f.heightDifference.shoulder,
    f.heightDifference.hip,
    f.heightDifference.knee,
    ...[f.rawPoints, f.points].flatMap((points) =>
      POINT_NAMES.flatMap((_, index) => {
        const p = points[index];
        return [p?.x, p?.y, p?.z, p?.visibility];
      }),
    ),
    ...(['raw', 'filtered'] as const).flatMap((basis) =>
      JOINTS.flatMap((j) =>
        channels(j.key).flatMap((side) => [
          angleValue(basis === 'raw' ? f.rawAngles : f.angles, j.key, side),
          angleValue(basis === 'raw' ? f.rawVelocity : f.velocity, j.key, side),
        ]),
      ),
    ),
    labels,
  ];
}

export const CSV_CHUNK_ROWS = 24;
// Bounded row batches, with only one row's cell array alive at a time. Full JS
// precision is intentional. No Worker receives a clone of the entire session.
export function* csvChunks(
  frames: readonly PoseFrame[],
  markers: readonly Marker[],
  session: SessionInfo,
) {
  const sorted = markers
    .map((m, index) => ({ ...m, index }))
    .filter((m) => Number.isFinite(m.time))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  let cursor = 0;
  const encoder = new TextEncoder();
  yield { data: encoder.encode('\uFEFF' + cells(csvHeader())), rows: 0 };
  for (let start = 0; start < frames.length; start += CSV_CHUNK_ROWS) {
    const end = Math.min(start + CSV_CHUNK_ROWS, frames.length);
    let text = '';
    for (let i = start; i < end; i++) {
      const f = frames[i];
      const labels: typeof sorted = [];
      while (cursor < sorted.length && sorted[cursor].time < f.time) cursor++;
      const last = i === frames.length - 1;
      const until = last ? f.time + 0.05 : frames[i + 1].time;
      while (
        cursor < sorted.length &&
        (last ? sorted[cursor].time <= until : sorted[cursor].time < until)
      )
        labels.push(sorted[cursor++]);
      // Preserve original insertion order for labels that share a frame bucket.
      labels.sort((a, b) => a.index - b.index);
      text += '\r\n' + cells(csvRow(f, labels.map((m) => m.label).join(' / '), session));
    }
    yield { data: encoder.encode(text), rows: end };
  }
}

// Compatibility helper for small contract tests. Product exports use writeCSV;
// this explicitly materializes the string and must not be used for long sessions.
export function serializeCSV(frames: PoseFrame[], markers: Marker[], session: SessionInfo): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return [...csvChunks(frames, markers, session)].map((c) => decoder.decode(c.data)).join('');
}
