import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angle,
  centerOfMass,
  jointAngles,
  LandmarkFilter,
  measureFrame,
  poseDistance,
  stabilityVariance,
} from '../src/utils/poseMath.ts';
import type { Landmark } from '../src/types.ts';
const point = (x: number, y: number, visibility = 1): Landmark => ({ x, y, z: 0, visibility });
const fixture = () =>
  Array.from({ length: 33 }, (_, i) => point((i % 6) / 6, Math.floor(i / 6) / 6));
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-7, `${a} ≠ ${b}`);
test('angles handle right angles, straight lines, aspect ratio and zero-length vectors', () => {
  near(angle(point(1, 0), point(0, 0), point(0, 1)), 90);
  near(angle(point(-1, 0), point(0, 0), point(1, 0)), 180);
  near(angle(point(1, 1), point(0, 0), point(0, 1), 2), (Math.atan(2) * 180) / Math.PI);
  assert.equal(angle(point(0, 0), point(0, 0), point(1, 1)), null);
});
test('weighted hip center rejects occluded hips', () => {
  const p = fixture();
  p[23] = point(0.2, 0.3, 0.5);
  p[24] = point(0.8, 0.9, 1);
  near(centerOfMass(p)!.x, 0.6);
  p[23].visibility = 0.49;
  assert.equal(centerOfMass(p), null);
});
test('joint metrics reject low-confidence landmarks instead of generating angles', () => {
  const p = fixture();
  p[13].visibility = 0.1;
  assert.equal(jointAngles(p).elbow.left, null);
  assert.notEqual(jointAngles(p).elbow.right, null);
});
test('filter honors its window, reset and current low confidence', () => {
  const filter = new LandmarkFilter();
  filter.apply([point(0, 0)], 2);
  near(filter.apply([point(1, 1)], 2)[0].x, 0.5);
  near(filter.apply([point(3, 3, 0.1)], 2)[0].x, 3);
  assert.equal(filter.apply([point(4, 4, 0.1)], 2)[0].visibility, 0.1);
  near(filter.apply([point(7, 7)], 5)[0].x, 7);
  filter.clear();
  near(filter.apply([point(8, 8)], 5)[0].x, 8);
});
test('stability is zero for static points and unavailable without reliable samples', () => {
  const p = fixture();
  near(stabilityVariance([p, p]), 0);
  assert.ok(stabilityVariance([p, p.map((v) => ({ ...v, x: v.x + 0.1 }))])! > 0);
  assert.equal(stabilityVariance([p]), null);
  assert.equal(
    stabilityVariance([
      p.map((v) => ({ ...v, visibility: 0 })),
      p.map((v) => ({ ...v, visibility: 0 })),
    ]),
    null,
  );
});
test('angle velocity uses actual frame interval and avoids zero-time division', () => {
  const p = fixture();
  p[11] = point(0, 0);
  p[13] = point(1, 0);
  p[15] = point(1, 1);
  const a = measureFrame(p, 0, undefined, [p]);
  const q = p.map((v) => ({ ...v }));
  q[15] = point(2, 0);
  const b = measureFrame(q, 0.5, a, [p, q]);
  near(b.velocity.elbow.left, 180);
  assert.equal(measureFrame(q, 0, a, [q]).velocity.elbow.left, null);
});
test('normalized pose distance is invariant to translation and scale', () => {
  const a = fixture(),
    b = a.map((p) => ({ ...p, x: p.x * 2 + 0.2, y: p.y * 2 - 0.1 }));
  near(poseDistance(a, b), 0);
  assert.equal(poseDistance([], b), null);
  const occluded = a.map((p) => ({ ...p, visibility: 0.1 }));
  assert.equal(poseDistance(occluded, b), null);
});
test('missing detections preserve a timestamp with null metrics and no fabricated points', () => {
  const frame = measureFrame([], 1, undefined, []);
  assert.equal(frame.confidence, 0);
  assert.equal(frame.angles.knee.left, null);
  assert.equal(frame.center, null);
  assert.equal(frame.rawPoints.length, 0);
  assert.equal(frame.time, 1);
});
test('raw model landmarks are preserved separately from filtered calculation inputs', () => {
  const raw = fixture(),
    filtered = raw.map((p) => ({ ...p, x: p.x + 0.1 }));
  const frame = measureFrame(filtered, 0, undefined, [filtered], 0.5, 1, raw);
  assert.equal(frame.rawPoints, raw);
  assert.equal(frame.points, filtered);
  near(frame.points[0].x - frame.rawPoints[0].x, 0.1);
});
