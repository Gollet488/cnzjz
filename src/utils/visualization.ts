import type { Channel, Joint, Marker, PoseFrame } from '../types.ts';
import { JOINTS } from '../config.ts';
import { angleValue, channels } from './poseMath.ts';

export type Interval = [number, number];
export function paddedExtent(values: number[], minimumSpan = 0.04): Interval {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return [0, 1];
  let min = Infinity,
    max = -Infinity;
  for (const n of valid) {
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  const span = Math.max(max - min, minimumSpan);
  const middle = (min + max) / 2;
  return [middle - span * 0.6, middle + span * 0.6];
}

// Equal physical scale: one X unit represents sourceAspect times one Y unit.
// Bounds remain normalized, including valid coordinates outside [0, 1].
export function trajectoryBounds(
  frames: PoseFrame[],
  width: number,
  height: number,
  sourceAspect: number,
) {
  const points = frames.flatMap((f) =>
    f.center && Number.isFinite(f.center.x) && Number.isFinite(f.center.y) ? [f.center] : [],
  );
  const x = paddedExtent(points.map((p) => p.x)),
    y = paddedExtent(points.map((p) => p.y));
  const ratio =
    Math.max(1, width) /
    Math.max(1, height) /
    (sourceAspect > 0 && Number.isFinite(sourceAspect) ? sourceAspect : 1);
  const sx = x[1] - x[0],
    sy = y[1] - y[0];
  if (sx / sy < ratio) {
    const m = (x[0] + x[1]) / 2;
    x[0] = m - (sy * ratio) / 2;
    x[1] = m + (sy * ratio) / 2;
  } else {
    const m = (y[0] + y[1]) / 2;
    y[0] = m - sx / ratio / 2;
    y[1] = m + sx / ratio / 2;
  }
  return { x, y };
}

export interface HeatCell {
  column: number;
  row: number;
  value: number | null;
  valid: number;
  missing: number;
}
export function velocityHeatmap(
  frames: PoseFrame[],
  width: number,
  basis: 'raw' | 'filtered' = 'filtered',
  selected?: Channel[],
) {
  const start = frames[0]?.time ?? 0,
    end = frames.at(-1)?.time ?? start;
  const count = frames.length
    ? Math.max(1, Math.min(160, frames.length, Math.floor(Math.max(12, width) / 12)))
    : 0;
  const buckets: Interval[] = Array.from({ length: count }, (_, i) => [
    start + ((end - start) * i) / count,
    start + ((end - start) * (i + 1)) / count,
  ]);
  const cells: HeatCell[] = Array.from({ length: count * JOINTS.length }, (_, i) => ({
    column: Math.floor(i / JOINTS.length),
    row: i % JOINTS.length,
    value: null,
    valid: 0,
    missing: 0,
  }));
  // Channel membership is constant for the displayed interval. Do not allocate
  // 7 channel/filter arrays for every source frame while zooming the page.
  const rows = JOINTS.map((j) => ({
    joint: j.key,
    sides: channels(j.key).filter((side) => !selected || selected.includes(side)),
  }));
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const values = basis === 'raw' ? f.rawVelocity : f.velocity;
    const col =
      end === start
        ? 0
        : Math.min(count - 1, Math.floor(((f.time - start) / (end - start)) * count));
    for (let row = 0; row < rows.length; row++) {
      const { joint, sides } = rows[row];
      const cell = cells[col * JOINTS.length + row]!;
      for (const side of sides) {
        // The first velocity depends on a frame outside this displayed interval.
        const v = i ? angleValue(values, joint, side) : null;
        if (v === null || !Number.isFinite(v)) cell.missing++;
        else {
          cell.valid++;
          cell.value = Math.max(cell.value ?? 0, Math.abs(v));
        }
      }
    }
  }
  const values = cells.flatMap((c) => (c.value === null ? [] : [c.value])).sort((a, b) => a - b);
  const peak = values.at(-1) ?? null;
  // Robust display cap only; actual peaks and tool statistics retain full values.
  const cap = Math.max(1, values[Math.floor(Math.max(0, values.length - 1) * 0.95)] ?? 1);
  return { buckets, cells, peak, cap, clipped: values.filter((v) => v > cap).length };
}

export function pointSeries(
  frames: PoseFrame[],
  index: number,
  basis: 'raw' | 'filtered',
  threshold: number,
  coordinate: 'x' | 'y',
): [number, number | null][] {
  return frames.map((f) => {
    const p = (basis === 'raw' ? f.rawPoints : f.points)[index];
    return [
      f.time,
      p &&
      Number.isFinite(p[coordinate]) &&
      Number.isFinite(p.visibility) &&
      p.visibility >= threshold
        ? p[coordinate]
        : null,
    ];
  });
}

export function groupMarkers(markers: Marker[], domain: Interval, width: number) {
  const span = domain[1] - domain[0];
  const sorted = markers
    .filter((m) => Number.isFinite(m.time) && m.time >= domain[0] && m.time <= domain[1])
    .slice()
    .sort((a, b) => a.time - b.time);
  const groups: { position: number; markers: Marker[] }[] = [];
  for (const marker of sorted) {
    const position = span > 0 ? (marker.time - domain[0]) / span : 0.5;
    const last = groups.at(-1);
    if (last && (position - last.position) * Math.max(1, width) < 24) last.markers.push(marker);
    else groups.push({ position, markers: [marker] });
  }
  return groups;
}

export const LABEL_ANCHORS: { joint: Joint; channel: Channel; index: number }[] = [
  ...(['shoulder', 'elbow', 'hip', 'knee', 'ankle', 'wrist'] as const).flatMap((joint, i) =>
    (['left', 'right'] as const).map((channel, n) => ({
      joint,
      channel,
      index: [11, 13, 23, 25, 27, 15][i]! + n,
    })),
  ),
  { joint: 'spine', channel: 'midline', index: 23 },
];

export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function placeLabel(
  anchor: { x: number; y: number },
  width: number,
  height: number,
  occupied: LabelBox[],
  bounds: { width: number; height: number },
  preferLeft: boolean,
): LabelBox {
  let best: LabelBox | undefined,
    score = Infinity;
  const direction = preferLeft ? [-1, 1] : [1, -1];
  for (const dy of [-30, 8, -60, 38, -90, 68, -120, 98])
    for (const sign of direction) {
      const box = {
        x: Math.max(
          5,
          Math.min(bounds.width - width - 5, anchor.x + (sign < 0 ? -width - 16 : 16)),
        ),
        y: Math.max(38, Math.min(bounds.height - height - 30, anchor.y + dy)),
        width,
        height,
      };
      const overlap = occupied.reduce(
        (s, b) =>
          s +
          Math.max(0, Math.min(box.x + width, b.x + b.width) - Math.max(box.x, b.x)) *
            Math.max(0, Math.min(box.y + height, b.y + b.height) - Math.max(box.y, b.y)),
        0,
      );
      if (overlap < score) {
        score = overlap;
        best = box;
      }
      if (!overlap) return box;
    }
  return best!;
}
// Display only: retain each time bucket's endpoints and extrema, in source
// order. Null runs remain explicit breaks; every finite run retains its ends.
// Queries, exports and evidence always use the original full-resolution frames.
export function peakDisplaySeries(
  data: readonly (readonly [number, number | null])[],
  width: number,
): (readonly [number, number | null])[] {
  const buckets = Math.max(1, Math.floor(width / 3));
  if (data.length <= buckets * 4) return [...data];
  const first = data[0][0],
    span = data.at(-1)![0] - first;
  const result: (readonly [number, number | null])[] = [];
  let firstIndex = -1,
    lastIndex = -1,
    bucket = -1,
    min = -1,
    max = -1;
  const flush = () => {
    if (firstIndex < 0) return;
    let previous = -1;
    for (const index of [firstIndex, min, max, lastIndex].sort((a, b) => a - b)) {
      if (index !== previous) result.push(data[index]);
      previous = index;
    }
    firstIndex = lastIndex = -1;
    min = max = -1;
  };
  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    if (point[1] === null) {
      flush();
      if (result.at(-1)?.[1] !== null || i === data.length - 1) result.push(point);
      bucket = -1;
      continue;
    }
    const next =
      span > 0 ? Math.min(buckets - 1, Math.floor(((point[0] - first) / span) * buckets)) : 0;
    if (next !== bucket) {
      flush();
      bucket = next;
    }
    if (firstIndex < 0) firstIndex = i;
    lastIndex = i;
    if (min < 0 || point[1] < data[min][1]!) min = i;
    if (max < 0 || point[1] > data[max][1]!) max = i;
  }
  flush();
  return result;
}

export function peakDisplayTrajectory(frames: readonly PoseFrame[], width: number) {
  const data: [number | null, number | null, number][] = frames.map((frame) =>
    frame.center && Number.isFinite(frame.center.x) && Number.isFinite(frame.center.y)
      ? [frame.center.x, frame.center.y, frame.time]
      : [null, null, frame.time],
  );
  const times = new Set<number>();
  for (const coordinate of [0, 1] as const)
    for (const point of peakDisplaySeries(
      data.map((p) => [p[2], p[coordinate]]),
      width,
    ))
      times.add(point[0]);
  return data.filter((point) => times.has(point[2]));
}
