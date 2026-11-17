import type { Landmark, Angles, PoseFrame, Joint, Channel, VarianceSummary } from '../types.ts';

// A very short projection cannot establish a stable direction. This is a
// geometry floor in units of source image height, not an accuracy estimate.
export const MIN_PROJECTED_SEGMENT = 0.005;

// Monocular coordinates yield 2D projection angles, not anatomical 3D measurements.
export type Point2D = Pick<Landmark, 'x' | 'y'>;
export function angle(a: Point2D, b: Point2D, c: Point2D, aspect = 1): number | null {
  if (![aspect, a.x, a.y, b.x, b.y, c.x, c.y].every(Number.isFinite) || aspect <= 0) return null;
  const ux = (a.x - b.x) * aspect,
    uy = a.y - b.y,
    vx = (c.x - b.x) * aspect,
    vy = c.y - b.y;
  const u = Math.hypot(ux, uy),
    v = Math.hypot(vx, vy);
  if (!Number.isFinite(u) || !Number.isFinite(v) || Math.min(u, v) < MIN_PROJECTED_SEGMENT)
    return null;
  const ax = ux / u,
    ay = uy / u,
    bx = vx / v,
    by = vy / v;
  return (Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) * 180) / Math.PI;
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
export const reliable = (p: Landmark | undefined, threshold: number): boolean =>
  !!p &&
  [p.x, p.y, p.z, p.visibility].every(Number.isFinite) &&
  p.visibility > 0 &&
  p.visibility >= threshold;
const jointTriples: Record<Exclude<Joint, 'spine'>, [number, number, number][]> = {
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

// The reference evaluation supports an advisory at 5% of image height for
// these joints. Keep this separate from the angle calculation and its floor.
export function shortProjectionSides(
  points: Landmark[],
  joint: Joint,
  threshold: number,
  aspect: number,
): ('left' | 'right')[] {
  if (
    points.length !== 33 ||
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    joint === 'spine' ||
    joint === 'ankle' ||
    joint === 'wrist'
  )
    return [];

  const short: ('left' | 'right')[] = [];
  jointTriples[joint].forEach(([a, b, c], i) => {
    if (![a, b, c].every((index) => reliable(points[index], threshold))) return;
    const first = Math.hypot((points[a].x - points[b].x) * aspect, points[a].y - points[b].y);
    const second = Math.hypot((points[c].x - points[b].x) * aspect, points[c].y - points[b].y);
    if (Math.min(first, second) < 0.05) short.push(i === 0 ? 'left' : 'right');
  });
  return short;
}

export function jointAngles(p: Landmark[], threshold = 0.5, aspect = 1): Angles {
  const result = emptyAngles();
  if (p.length !== 33) return result;
  for (const [key, pairs] of Object.entries(jointTriples))
    pairs.forEach(([a, b, c], i) => {
      result[key as Exclude<Joint, 'spine'>][i === 0 ? 'left' : 'right'] = [a, b, c].every((n) =>
        reliable(p[n], threshold),
      )
        ? angle(p[a], p[b], p[c], aspect)
        : null;
    });
  const spine = [11, 12, 23, 24, 27, 28].every((i) => reliable(p[i], threshold))
    ? angle(midpoint(p[11], p[12]), midpoint(p[23], p[24]), midpoint(p[27], p[28]), aspect)
    : null;
  result.spine = { midline: spine };
  return result;
}
export function filteredJointAngles(
  points: Landmark[],
  raw: Angles,
  threshold: number,
  aspect: number,
): Angles {
  const result = jointAngles(points, threshold, aspect);
  // Smoothed coordinates cannot rescue an angle that was unobservable in the
  // current raw frame. Keep independently observable joints and sides.
  for (const joint of JOINT_KEYS) {
    if (joint === 'spine') {
      if (raw.spine.midline === null) result.spine.midline = null;
    } else {
      for (const side of ['left', 'right'] as const)
        if (raw[joint][side] === null) result[joint][side] = null;
    }
  }
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
  apply(
    points: Landmark[],
    window: number,
    threshold = 0.5,
    favorRecent = false,
    motionAspect?: number,
  ): Landmark[] {
    this.history.push(points.map((p) => ({ ...p })));
    this.history = this.history.slice(-Math.max(1, Math.round(window)));
    // Stretch the weights for longer windows so their older frames still
    // contribute. The 3- and 5-frame presets use the same decay per frame.
    const decay = favorRecent ? 0.4 ** (4 / Math.max(4, window - 1)) : 1;
    const torso = motionAspect ? visibleTorsoLength(points, threshold, motionAspect) : 0;
    // Low confidence samples must not fabricate reliable coordinates by averaging.
    return points.map((p, i) => {
      if (!reliable(p, threshold)) return { ...p };
      let x = 0,
        y = 0,
        z = 0,
        visibility = 0,
        total = 0,
        weight = 1;
      // An occlusion breaks this landmark's smoothing history.
      for (let n = this.history.length - 1; n >= 0; n--) {
        const sample = this.history[n][i];
        if (!reliable(sample, threshold)) break;
        // Keep small movements smooth. Large offsets from the current frame
        // should not pull a rapidly moving limb toward an earlier pose.
        const displacement = torso
          ? Math.hypot((p.x - sample.x) * motionAspect!, p.y - sample.y) / torso
          : 0;
        const motionWeight = Math.max(0, Math.min(1, (0.16 - displacement) / 0.12));
        const contribution = weight * motionWeight;
        x += contribution * sample.x;
        y += contribution * sample.y;
        z += contribution * sample.z;
        visibility += contribution * sample.visibility;
        total += contribution;
        weight *= decay;
      }
      return {
        x: x / total,
        y: y / total,
        z: z / total,
        visibility: Math.min(p.visibility, visibility / total),
      };
    });
  }
  clear() {
    this.history = [];
  }
}
function visibleTorsoLength(points: Landmark[], threshold: number, aspect: number) {
  const shoulders = [points[11], points[12]].filter((point) => reliable(point, threshold));
  const hips = [points[23], points[24]].filter((point) => reliable(point, threshold));
  if (!shoulders.length || !hips.length) return 0;
  const shoulder = shoulders.length === 2 ? midpoint(shoulders[0], shoulders[1]) : shoulders[0];
  const hip = hips.length === 2 ? midpoint(hips[0], hips[1]) : hips[0];
  return Math.max(0.05, Math.hypot((shoulder.x - hip.x) * aspect, shoulder.y - hip.y));
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
      const speed =
        a !== null && b !== null && Number.isFinite(delta) && delta > 0 ? (a - b) / delta : null;
      const value = speed !== null && Number.isFinite(speed) ? speed : null;
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
  samplingGapLimit: number | null = null,
): PoseFrame {
  const valid = points.length === 33;
  const rawAngles = jointAngles(rawPoints, threshold, aspect);
  const angles =
    points === rawPoints ? rawAngles : filteredJointAngles(points, rawAngles, threshold, aspect);
  const delta = previous && samplingGapLimit === null ? time - previous.time : 0;
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
    samplingGapLimit,
    center: centerOfMass(points, threshold),
    confidence: rawPoints.length === 33 ? rawPoints.reduce((s, p) => s + p.visibility, 0) / 33 : 0,
    asymmetry: diffs.length ? diffs.reduce((s, v) => s + v, 0) / diffs.length : null,
    heightDifference: { shoulder: height(11, 12), hip: height(23, 24), knee: height(25, 26) },
    stability: variance.filtered.value,
  };
}
// Translation/scale normalized mean Euclidean distance. Similarity is descriptive,
// never a correctness score; reference selection belongs to the user.
export function poseDistance(
  a: Landmark[],
  b: Landmark[],
  threshold = 0.5,
  aspectA = 1,
  aspectB = 1,
): number | null {
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    ![aspectA, aspectB].every((v) => Number.isFinite(v) && v > 0) ||
    a.length !== 33 ||
    b.length !== 33 ||
    [a, b].some((p) => [11, 12, 23, 24].some((i) => !reliable(p[i], threshold)))
  )
    return null;
  // Source-height units make x and y commensurate before torso normalization.
  // Canvas dimensions are rounded display sizes, not measurement geometry.
  const normalize = (p: Landmark[], aspect: number) => {
    const c = midpoint(p[23], p[24]),
      s = midpoint(p[11], p[12]),
      scale = Math.hypot((s.x - c.x) * aspect, s.y - c.y);
    return !Number.isFinite(scale) || scale < 1e-8
      ? null
      : p.map((v) => ({ ...v, x: ((v.x - c.x) * aspect) / scale, y: (v.y - c.y) / scale }));
  };
  const na = normalize(a, aspectA),
    nb = normalize(b, aspectB);
  if (!na || !nb) return null;
  const distances = na.flatMap((p, i) =>
    reliable(p, threshold) && reliable(nb[i], threshold)
      ? [Math.hypot(p.x - nb[i].x, p.y - nb[i].y)]
      : [],
  );
  const mean = distances.length ? distances.reduce((s, v) => s + v, 0) / distances.length : null;
  return mean !== null && Number.isFinite(mean) ? mean : null;
}
