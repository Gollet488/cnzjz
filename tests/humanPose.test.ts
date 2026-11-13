import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisSession } from '../src/analysis/session.ts';
import type { Landmark } from '../src/types.ts';
import { humanPose } from '../src/utils/humanPose.ts';

const settings = { threshold: 0.5, window: 4, aspect: 1, metricVersion: '2.1' as const };
function sideView(kneeX = 0.5) {
  const points: Landmark[] = Array.from({ length: 33 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    visibility: 0,
  }));
  points[23] = { x: 0.45, y: 0.4, z: 0, visibility: 0.9 };
  points[25] = { x: kneeX, y: 0.58, z: 0, visibility: 0.9 };
  points[27] = { x: 0.6, y: 0.8, z: 0, visibility: 0.9 };
  return points;
}

test('a cropped side keeps the visible knee while invalid and out-of-frame points stay unavailable', () => {
  const input = sideView();
  input[26] = { x: 1.1, y: 0.55, z: 0, visibility: 0.98 };
  input[28] = { x: NaN, y: 0.8, z: 0, visibility: 0.99 };
  const points = humanPose(input);
  assert.equal(points.length, 33);
  assert.equal(points[26].visibility, 0);
  assert.equal(points[28].visibility, 0);
  assert.deepEqual(points[25], input[25]);
  const session = new AnalysisSession('file', settings);
  assert(session.append(points, 0));
  assert.notEqual(session.frames[0].angles.knee.left, null);
  assert.equal(session.frames[0].angles.knee.right, null);
  session.recalculate({ ...settings, threshold: 0 });
  assert.equal(session.frames[0].angles.knee.right, null);
  assert.equal(session.frames[0].angles.ankle.left, null);
});

test('detection uses the source aspect before judging visible limb lengths', () => {
  const wide = sideView();
  for (const [i, x] of [
    [23, 0.5],
    [25, 0.505],
    [27, 0.51],
  ]) {
    wide[i].x = x;
    wide[i].y = 0.5;
  }
  const square = wide.map((p) => ({ ...p, x: 0.5 + (p.x - 0.5) * 2 }));
  assert.equal(humanPose(wide, 2).length, 33);
  assert.equal(humanPose(square, 1).length, 33);
  assert.deepEqual(humanPose(wide, 1), []);
  assert.deepEqual(humanPose(wide, NaN), []);
});

test('loss and reacquisition keep ordered samples and do not invent motion across gaps', () => {
  const session = new AnalysisSession('camera', settings);
  const first = humanPose(sideView());
  const recovered = humanPose(sideView(0.59));
  const noise = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
  assert.deepEqual(humanPose(noise), []);
  session.append(first, 0);
  session.append(humanPose(noise), 0.033);
  session.append(recovered, 0.066);
  session.append(first, 0.8);
  assert.deepEqual(
    session.frames.map((f) => f.time),
    [0, 0.033, 0.066, 0.8],
  );
  assert.deepEqual(
    session.frames.map((f) => f.velocity.knee.left),
    [null, null, null, null],
  );
  assert.equal(session.frames[1].angles.knee.left, null);
  assert.equal(session.frames[2].points[25].x, recovered[25].x);
  assert.equal(session.frames[3].points[25].x, first[25].x);
  session.recalculate(settings);
  assert.equal(session.frames[3].velocity.knee.left, null);
});
