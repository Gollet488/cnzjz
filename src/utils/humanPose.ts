import type { Landmark } from '../types.ts';

const torsoSides = [
  [11, 23],
  [12, 24],
];
const limbs = [
  [11, 13, 15],
  [12, 14, 16],
  [23, 25, 27],
  [24, 26, 28],
];

// A pose can contain just one usable side or limb. Keep its 33 indices, marking
// invalid coordinates and points outside the image unavailable individually.
export function humanPose(input: Landmark[], aspect = 1): Landmark[] {
  if (input.length !== 33 || !Number.isFinite(aspect) || aspect <= 0) return [];
  const points = Array.from(input, (point) => {
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite))
      return { x: 0, y: 0, z: 0, visibility: 0 };
    const { x, y, z, visibility } = point;
    return {
      x,
      y,
      z,
      visibility:
        x >= 0 &&
        x <= 1 &&
        y >= 0 &&
        y <= 1 &&
        Number.isFinite(visibility) &&
        visibility >= 0 &&
        visibility <= 1
          ? visibility
          : 0,
    };
  });
  // This gate only checks for a plausible person; each measurement still uses
  // the user's confidence threshold and all of that joint's required points.
  const visible = (i: number) => points[i].visibility >= 0.5;
  const length = (a: number, b: number) =>
    Math.hypot((points[a].x - points[b].x) * aspect, points[a].y - points[b].y);
  const torso = torsoSides.filter(([a, b]) => visible(a) && visible(b) && length(a, b) >= 0.015);
  if (torso.length === 2) return points;
  const limb = limbs.some(([root, mid, end]) => {
    if (!visible(root) || !visible(mid) || !visible(end)) return false;
    const upper = length(root, mid);
    const lower = length(mid, end);
    return Math.min(upper, lower) >= 0.008 && Math.max(upper, lower) <= 6 * Math.min(upper, lower);
  });
  const torsoWithSegment = torso.some(([shoulder, hip]) =>
    [
      [shoulder, shoulder + 2],
      [hip, hip + 2],
    ].some(
      ([a, b]) =>
        visible(b) && length(a, b) >= 0.008 && length(a, b) <= 2.5 * length(shoulder, hip),
    ),
  );
  return limb || torsoWithSegment ? points : [];
}
