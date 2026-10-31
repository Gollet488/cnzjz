import type { Landmark, Angles, PoseFrame, Joint, Channel, VarianceSummary } from '../types.ts';

// Monocular coordinates yield 2D projection angles, not anatomical 3D measurements.
export function angle(a: Landmark, b: Landmark, c: Landmark, aspect = 1): number | null {
  if (![aspect, a.x, a.y, b.x, b.y, c.x, c.y].every(Number.isFinite) || aspect <= 0) return null;
  const ux = (a.x - b.x) * aspect,
    uy = a.y - b.y,
    vx = (c.x - b.x) * aspect,
    vy = c.y - b.y;
  const denominator = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return denominator < 1e-10
    ? null
    : (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator))) * 180) / Math.PI;
}
const midpoint = (a: Landmark, b: Landmark): Landmark => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
  visibility: Math.min(a.visibility, b.visibility),
});
export const JOINT_KEYS: Joint[] = ['shoulder', 'elbow', 'hip', 'knee', 'ankle', 'spine', 'wrist'];
export const channels = (joint: Joint): Channel[] =>
  joint === 'spine' ? ['midline'] : ['left', 'right'];
export function angleValue(values: Angles, joint: Joint, channel: Channel): number | null {
  if (joint === 'spine') return channel === 'midline' ? values.spine.midline : null;
  return channel === 'midline' ? null : values[joint][channel];
}
export function emptyAngles(): Angles {
  return {
    shoulder: { left: null, right: null },
    elbow: { left: null, right: null },
    hip: { left: null, right: null },
    knee: { left: null, right: null },
    ankle: { left: null, right: null },
    wrist: { left: null, right: null },
    spine: { midline: null },
  };
}
const reliable = (p: Landmark | undefined, threshold: number): boolean =>
  !!p && [p.x, p.y, p.z, p.visibility].every(Number.isFinite) && p.visibility >= threshold;
export function jointAngles(p: Landmark[], threshold = 0.5, aspect = 1): Angles {
  const result = emptyAngles();
  if (p.length !== 33) return result;
  const triples: Record<Exclude<Joint, 'spine'>, [number, number, number][]> = {
    shoulder: [
      [13, 11, 23],
      [14, 12, 24],
    ],
    elbow: [
      [11, 13, 15],
      [12, 14, 16],
    ],
    hip: [
      [11, 23, 25],
      [12, 24, 26],
    ],
    knee: [
      [23, 25, 27],
      [24, 26, 28],
    ],
    ankle: [
      [25, 27, 31],
      [26, 28, 32],
    ],
    wrist: [
      [13, 15, 19],
      [14, 16, 20],
    ],
  };
  for (const [key, pairs] of Object.entries(triples))
    pairs.forEach(([a, b, c], i) => {
      result[key as Exclude<Joint, 'spine'>][i === 0 ? 'left' : 'right'] = [a, b, c].every((n) =>
        reliable(p[n], threshold),
      )
        ? angle(p[a], p[b], p[c], aspect)
        : null;
    });
  const spinePoints = [midpoint(p[11], p[12]), midpoint(p[23], p[24]), midpoint(p[27], p[28])];
  const spine = spinePoints.every((v) => reliable(v, threshold))
    ? angle(spinePoints[0], spinePoints[1], spinePoints[2], aspect)
    : null;
  result.spine = { midline: spine };
  return result;
}
export function centerOfMass(p: Landmark[], threshold = 0.5): { x: number; y: number } | null {
  if (p.length !== 33 || !reliable(p[23], threshold) || !reliable(p[24], threshold)) return null;
  const a = p[23],
    b = p[24],
    w = a.visibility + b.visibility;
  return w
    ? {
        x: (a.x * a.visibility + b.x * b.visibility) / w,
        y: (a.y * a.visibility + b.y * b.visibility) / w,
      }
    : null;
}
export class LandmarkFilter {
  private history: Landmark[][] = [];
  apply(points: Landmark[], window: number, threshold = 0.5): Landmark[] {
    this.history.push(points.map((p) => ({ ...p })));
    this.history = this.history.slice(-Math.max(1, Math.round(window)));
    // Low confidence samples must not fabricate reliable coordinates by averaging.
    return points.map((p, i) => {
      if (!reliable(p, threshold)) return { ...p };
      const samples: Landmark[] = [];
      // An occlusion breaks this landmark's smoothing history.
      for (let n = this.history.length - 1; n >= 0; n--) {
        const sample = this.history[n][i];
        if (!reliable(sample, threshold)) break;
        samples.push(sample);
      }
      return {
        x: samples.reduce((s, v) => s + v.x, 0) / samples.length,
        y: samples.reduce((s, v) => s + v.y, 0) / samples.length,
        z: samples.reduce((s, v) => s + v.z, 0) / samples.length,
        visibility: Math.min(
          p.visibility,
          samples.reduce((s, v) => s + v.visibility, 0) / samples.length,
        ),
      };
    });
  }
  clear() {
    this.history = [];
  }
}
export function varianceSummary(history: Landmark[][], threshold = 0.5): VarianceSummary {
  const variances: number[] = [],
    counts: number[] = [];
  for (let i = 0; i < 33; i++) {
    const samples = history.map((f) => f[i]).filter((p) => reliable(p, threshold));
    if (samples.length < 2) continue;
    const mx = samples.reduce((s, p) => s + p.x, 0) / samples.length;
    const my = samples.reduce((s, p) => s + p.y, 0) / samples.length;
    variances.push(
      samples.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / samples.length,
    );
    counts.push(samples.length);
  }
  return {
    value: variances.length ? variances.reduce((s, v) => s + v, 0) / variances.length : null,
    unit: 'normalized_coordinate²',
    windowFrames: history.length,
    validPoints: counts.length,
    validSamples: counts.reduce((s, n) => s + n, 0),
    minSamplesPerPoint: counts.length ? Math.min(...counts) : 0,
    maxSamplesPerPoint: counts.length ? Math.max(...counts) : 0,
  };
}
export function stabilityVariance(history: Landmark[][], threshold = 0.5): number | null {
  return varianceSummary(history, threshold).value;
}
function angularVelocity(current: Angles, previous: Angles | undefined, delta: number): Angles {
  const result = emptyAngles();
  for (const joint of JOINT_KEYS)
    for (const side of channels(joint)) {
      const a = angleValue(current, joint, side),
        b = previous ? angleValue(previous, joint, side) : null;
      const value =
        a !== null && b !== null && Number.isFinite(delta) && delta > 0 ? (a - b) / delta : null;
      if (joint === 'spine') result.spine.midline = value;
      else if (side !== 'midline') result[joint][side] = value;
    }
  return result;
}
export function measureFrame(
  points: Landmark[],
  time: number,
  previous: PoseFrame | undefined,
  history: Landmark[][],
  threshold = 0.5,
  aspect = 1,
  rawPoints: Landmark[] = points,
  rawHistory: Landmark[][] = rawPoints === points ? history : [rawPoints],
  windowInterval: [number, number] = [time, time],
): PoseFrame {
  const valid = points.length === 33;
  const angles = jointAngles(points, threshold, aspect),
    rawAngles = jointAngles(rawPoints, threshold, aspect);
  const delta = previous ? time - previous.time : 0;
  const velocity = angularVelocity(angles, previous?.angles, delta);
  const rawVelocity = angularVelocity(rawAngles, previous?.rawAngles, delta);
  // Each spine measurement is one midline value and never enters bilateral asymmetry.
  const diffs = JOINT_KEYS.filter((k) => k !== 'spine').flatMap((k) => {
    const left = angleValue(angles, k, 'left'),
      right = angleValue(angles, k, 'right');
    return left !== null && right !== null ? [(Math.abs(left - right) / 180) * 100] : [];
  });
  const height = (a: number, b: number) =>
    reliable(points[a], threshold) && reliable(points[b], threshold)
      ? Math.abs(points[a].y - points[b].y)
      : null;
  const variance = {
    raw: varianceSummary(valid ? rawHistory : [], threshold),
    filtered: varianceSummary(valid ? history : [], threshold),
  };
  return {
    time,
    rawPoints: rawPoints.length === 33 ? rawPoints : [],
    points: valid ? points : [],
    angles,
    velocity,
    rawAngles,
    rawVelocity,
    variance,
    windowInterval,
    center: centerOfMass(points, threshold),
    confidence: rawPoints.length === 33 ? rawPoints.reduce((s, p) => s + p.visibility, 0) / 33 : 0,
    asymmetry: diffs.length ? diffs.reduce((s, v) => s + v, 0) / diffs.length : null,
    heightDifference: { shoulder: height(11, 12), hip: height(23, 24), knee: height(25, 26) },
    stability: variance.filtered.value,
  };
}
// Translation/scale normalized mean Euclidean distance. Similarity is descriptive,
// never a correctness score; reference selection belongs to the user.
export function poseDistance(a: Landmark[], b: Landmark[], threshold = 0.5): number | null {
  if (
    a.length !== 33 ||
    b.length !== 33 ||
    [a, b].some((p) => [11, 12, 23, 24].some((i) => p[i].visibility < threshold))
  )
    return null;
  const normalize = (p: Landmark[]) => {
    const c = midpoint(p[23], p[24]),
      s = midpoint(p[11], p[12]),
      scale = Math.hypot(s.x - c.x, s.y - c.y);
    return scale < 1e-8
      ? null
      : p.map((v) => ({ ...v, x: (v.x - c.x) / scale, y: (v.y - c.y) / scale }));
  };
  const na = normalize(a),
    nb = normalize(b);
  if (!na || !nb) return null;
  const distances = na.flatMap((p, i) =>
    p.visibility >= threshold && nb[i].visibility >= threshold
      ? [Math.hypot(p.x - nb[i].x, p.y - nb[i].y)]
      : [],
  );
  return distances.length ? distances.reduce((s, v) => s + v, 0) / distances.length : null;
}
