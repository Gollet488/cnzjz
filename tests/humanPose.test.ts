import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisSession } from '../src/analysis/session.ts';
import type { Landmark } from '../src/types.ts';
import { humanPose } from '../src/utils/humanPose.ts';
import { jointAngles } from '../src/utils/poseMath.ts';
import {
  hasCollapsedBodySegment,
  hasForeshortenedTorso,
  hasUprightTorso,
  keepConsistentJoints,
  recoverCollapsedSegments,
  sameBodyRegion,
  VideoPoseTrack,
} from '../src/utils/poseRecovery.ts';

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

test('a same-frame observation can recover a collapsed segment without losing a neighboring angle', () => {
  const points = sideView();
  points[11] = { x: 0.45, y: 0.2, z: 0, visibility: 0.9 };
  points[25] = { ...points[23], x: 0.452 };
  const retry = sideView();
  assert(hasCollapsedBodySegment(points, 1));
  assert.equal(jointAngles(points).knee.left, null);
  const recovered = recoverCollapsedSegments(points, retry, 1);
  assert.notEqual(jointAngles(recovered).knee.left, null);
  assert.strictEqual(recovered[27], points[27]);

  retry[25] = { ...points[27] };
  assert.strictEqual(recoverCollapsedSegments(points, retry, 1), points);
  retry[25] = { ...sideView()[25], visibility: 0.1 };
  assert.strictEqual(recoverCollapsedSegments(points, retry, 1), points);
});

test('a compact video track needs consecutive evidence before it becomes a recovery target', () => {
  const track = new VideoPoseTrack();
  const compact = sideView().map((p) => ({ ...p, x: 0.4 + p.x / 4, y: 0.4 + p.y / 4 }));
  const elsewhere = compact.map((p) => ({ ...p, x: p.x - 0.3 }));
  assert(!track.accept(compact, 0, 1));
  assert(!track.accept(compact, 33, 1));
  assert(!track.accept([], 66, 1));
  assert.equal(track.recent(66), undefined);
  assert(!track.accept(compact, 100, 1));
  assert(!track.accept(elsewhere, 200, 1));
  assert(!track.accept(elsewhere, 250, 1));
  assert(track.accept(elsewhere, 300, 1));
  assert.strictEqual(track.recent(700), elsewhere);
  assert.equal(track.recent(701), undefined);
  assert(track.accept(sideView(), 702, 1));
});

test('a same-region retry blanks uncertain joints in a deep bend while preserving agreed joints', () => {
  const points = sideView();
  points[11] = { x: 0.45, y: 0.45, z: 0, visibility: 0.9 };
  points[12] = { ...points[11], x: 0.55 };
  points[24] = { ...points[23], x: 0.55 };
  points[31] = { ...points[27], y: 0.82 };
  assert(hasForeshortenedTorso(points, 1));
  assert(!hasForeshortenedTorso(sideView(), 1));
  const other = points.map((p) => ({ ...p, x: p.x + 0.3 }));
  assert(!sameBodyRegion(points, other, 1));
  assert.strictEqual(keepConsistentJoints(points, other, 1), points);
  const crop = points.slice();
  crop[27] = { ...points[27], x: 0.5 };
  const checked = keepConsistentJoints(points, crop, 1);
  assert.strictEqual(checked[25], points[25]);
  assert.equal(checked[27].visibility, 0);
  assert.equal(checked[31].visibility, 0);
  assert.equal(jointAngles(checked, 0).knee.left, null);

  const lifting = points.slice();
  lifting[11] = { ...points[11], y: 0.38 };
  lifting[12] = { ...points[12], y: 0.38 };
  lifting[0] = { ...points[11], y: 0.42 };
  assert(!hasForeshortenedTorso(lifting, 1));
  assert(!hasUprightTorso(lifting, 1));
  lifting[11] = { ...lifting[11], y: 0.29 };
  lifting[12] = { ...lifting[12], y: 0.29 };
  assert(hasUprightTorso(lifting, 1));
});

test('two same-frame retries can recover a joint that the video tracker and first retry disagree on', () => {
  const points = sideView();
  points[11] = { ...points[23], y: 0.45 };
  points[12] = { ...points[11], x: 0.55 };
  points[24] = { ...points[23], x: 0.55 };
  const crop = points.slice();
  crop[27] = { ...points[27], x: 0.5 };
  const mirrored = crop.slice();
  mirrored[27] = { ...crop[27], x: 0.51 };

  assert.equal(keepConsistentJoints(points, crop, 1)[27].visibility, 0);
  assert.strictEqual(keepConsistentJoints(points, crop, 1, mirrored)[27], crop[27]);
  assert.strictEqual(keepConsistentJoints(points, crop, 1, points)[27], points[27]);

  const differentSubject = mirrored.map((p) => ({ ...p, x: p.x + 0.3 }));
  assert.equal(keepConsistentJoints(points, crop, 1, differentSubject)[27].visibility, 0);
  mirrored[27] = { ...mirrored[27], visibility: 0.1 };
  assert.equal(keepConsistentJoints(points, crop, 1, mirrored)[27].visibility, 0);
});
