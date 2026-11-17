import type { Landmark } from '../types.ts';
import { MIN_PROJECTED_SEGMENT, reliable } from './poseMath.ts';

const torso = [11, 12, 23, 24];
const limbs = [
  [13, 15, 17, 19, 21],
  [14, 16, 18, 20, 22],
  [25, 27, 29, 31],
  [26, 28, 30, 32],
];
const distance = (a: Landmark, b: Landmark, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

type PoseSample = { points: Landmark[]; timestamp: number };

export class VideoPoseTrack {
  private last?: PoseSample;
  private provisional?: PoseSample;

  recent(timestamp: number) {
    return this.last && timestamp - this.last.timestamp <= 400 ? this.last.points : undefined;
  }

  accept(points: Landmark[], timestamp: number, aspect: number) {
    if (!points.length) {
      this.provisional = undefined;
      return false;
    }
    const anchors = torso.map((i) => points[i]).filter((p) => reliable(p, 0.5));
    const anchorSpan = Math.max(
      0,
      ...anchors.flatMap((a) => anchors.map((b) => distance(a, b, aspect))),
    );
    // A small initial proposal can be a short-lived response to background
    // clutter. Wait for the same region to be detected over consecutive frames.
    if (
      !this.recent(timestamp) &&
      anchorSpan < 0.15 &&
      (bodyRegion(points, aspect)?.span ?? Infinity) < 0.25
    ) {
      if (!this.provisional || !sameBodyRegion(this.provisional.points, points, aspect))
        this.provisional = { points, timestamp };
      if (timestamp - this.provisional.timestamp < 100) return false;
    }
    this.provisional = undefined;
    this.last = { points, timestamp };
    return true;
  }
}

function bodyRegion(points: Landmark[], aspect: number) {
  const observed = points.filter((p) => reliable(p, 0.5));
  const anchors = torso.map((i) => points[i]).filter((p) => reliable(p, 0.5));
  if (observed.length < 3) return;
  const center = anchors.length >= 2 ? anchors : observed;
  const xs = observed.map((p) => p.x * aspect);
  const ys = observed.map((p) => p.y);
  return {
    x: center.reduce((sum, p) => sum + p.x * aspect, 0) / center.length,
    y: center.reduce((sum, p) => sum + p.y, 0) / center.length,
    span: Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
  };
}

// A deep bend can move the landmarks within the same subject's region. Use
// position and scale to reject a different subject without requiring joint agreement.
export function sameBodyRegion(points: Landmark[], retry: Landmark[], aspect: number) {
  const a = bodyRegion(points, aspect);
  const b = bodyRegion(retry, aspect);
  if (!a || !b) return false;
  const shorter = Math.min(a.span, b.span);
  return (
    Math.max(a.span, b.span) <= 3 * shorter &&
    Math.hypot(a.x - b.x, a.y - b.y) <= Math.max(0.035, 0.55 * shorter)
  );
}

function torsoRise(points: Landmark[], aspect: number) {
  if (!torso.every((i) => reliable(points[i], 0.5))) return;
  const [leftShoulder, rightShoulder, leftHip, rightHip] = torso.map((i) => points[i]);
  const rise = (leftHip.y + rightHip.y - leftShoulder.y - rightShoulder.y) / 2;
  const width = Math.max(
    distance(leftShoulder, rightShoulder, aspect),
    distance(leftHip, rightHip, aspect),
  );
  return rise - width / 2;
}

export function hasForeshortenedTorso(points: Landmark[], aspect: number) {
  if ((torsoRise(points, aspect) ?? Infinity) > 0) return false;
  const hipY = (points[23].y + points[24].y) / 2;
  const shoulderY = (points[11].y + points[12].y) / 2;
  return shoulderY - hipY > 0.035 || (reliable(points[0], 0.5) && points[0].y - hipY > 0.06);
}

export function hasUprightTorso(points: Landmark[], aspect: number) {
  return (torsoRise(points, aspect) ?? 0) > 0.03;
}

// Agreement is checked on the same image. Mark uncertain observations as
// missing so the user's confidence slider cannot turn them into measurements.
export function keepConsistentJoints(
  points: Landmark[],
  retry: Landmark[],
  aspect: number,
  alternative: Landmark[] = [],
) {
  const matchedRetry = sameBodyRegion(points, retry, aspect) ? retry : [];
  const matchedAlternative = sameBodyRegion(points, alternative, aspect) ? alternative : [];
  if (!matchedRetry.length && !matchedAlternative.length) return points;
  const scale = Math.max(
    distance(points[11], points[23], aspect),
    distance(points[12], points[24], aspect),
    distance(points[11], points[12], aspect),
    distance(points[23], points[24], aspect),
  );
  const tolerance = Math.max(0.025, Math.min(0.05, scale / 3));
  const supports = (point: Landmark, other: Landmark | undefined) =>
    other !== undefined && reliable(other, 0.5) && distance(point, other, aspect) <= tolerance;
  const retriesAgree = sameBodyRegion(matchedRetry, matchedAlternative, aspect);
  const result = points.map((point, i) => {
    const first = matchedRetry[i];
    const second = matchedAlternative[i];
    if (point.visibility && (supports(point, first) || supports(point, second))) return point;
    if (retriesAgree && reliable(first, 0.5) && supports(first, second)) return first;
    return point.visibility ? { ...point, visibility: 0 } : point;
  });
  for (const [, end, ...detail] of limbs) {
    if (!result[end].visibility)
      detail.forEach((i) => {
        if (result[i].visibility) result[i] = { ...result[i], visibility: 0 };
      });
  }
  return result;
}

const segments = [
  [11, 23],
  [12, 24],
  [11, 13],
  [12, 14],
  [13, 15],
  [14, 16],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
] as const;
const measuredSegments = [...segments, [15, 19], [16, 20], [27, 31], [28, 32]] as const;

const visible = (points: Landmark[], a: number, b: number) =>
  reliable(points[a], 0.5) && reliable(points[b], 0.5);

function collapsed(points: Landmark[], a: number, b: number, aspect: number) {
  return (
    visible(points, a, b) &&
    Math.hypot((points[a].x - points[b].x) * aspect, points[a].y - points[b].y) <
      MIN_PROJECTED_SEGMENT
  );
}

export function hasCollapsedBodySegment(points: Landmark[], aspect: number) {
  return segments.some(([a, b]) => collapsed(points, a, b, aspect));
}

// The caller has matched both detections to the same person on the same frame.
export function recoverCollapsedSegments(points: Landmark[], retry: Landmark[], aspect: number) {
  let result = points;
  for (const [a, b] of segments) {
    if (!collapsed(result, a, b, aspect) || !visible(retry, a, b) || collapsed(retry, a, b, aspect))
      continue;

    // Use both endpoints from the same inference. A shared endpoint can also
    // belong to a currently measurable adjacent segment.
    const next = result.slice();
    next[a] = retry[a];
    next[b] = retry[b];
    const losesDirection = measuredSegments.some(
      ([j, k]) => collapsed(next, j, k, aspect) && !collapsed(result, j, k, aspect),
    );
    if (!losesDirection) result = next;
  }
  return result;
}
