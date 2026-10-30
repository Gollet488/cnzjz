import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakDisplaySeries, peakDisplayTrajectory } from '../src/utils/visualization.ts';

test('display aggregation retains extrema, endpoints and missing breaks without changing source', () => {
  const data: [number, number | null][] = Array.from({ length: 18000 }, (_, i) => [
    i / 30,
    i % 67 === 66 ? null : Math.sin(i),
  ]);
  data[1234][1] = 1000;
  data[1235][1] = -1000;
  const snapshot = structuredClone(data);
  const display = peakDisplaySeries(data, 900);
  assert.ok(display.length < data.length / 3);
  assert.deepEqual(display[0], data[0]);
  assert.deepEqual(display.at(-1), data.at(-1));
  assert.ok(display.includes(data[1234]));
  assert.ok(display.includes(data[1235]));
  for (let i = 1; i < display.length; i++) {
    assert.ok(display[i][0] > display[i - 1][0]);
    if (display[i][1] !== null && display[i - 1][1] !== null)
      assert.ok(
        !data
          .slice(Math.round(display[i - 1][0] * 30), Math.round(display[i][0] * 30) + 1)
          .some((p) => p[1] === null),
      );
  }
  assert.deepEqual(data, snapshot);
  for (const small of [
    [],
    [[0, null]],
    [[0, 2]],
    [
      [0, 2],
      [1, 2],
    ],
  ])
    assert.deepEqual(peakDisplaySeries(small as [number, number | null][], 900), small);
});

test('trajectory display preserves X and Y peaks, time order and missing segments', () => {
  const frames = Array.from({ length: 18000 }, (_, i) => ({
    time: i / 30,
    center: i % 67 === 66 ? null : { x: Math.sin(i), y: Math.cos(i) },
  })) as PoseFrame[];
  frames[1234].center = { x: -100, y: 100 };
  frames[1235].center = { x: 100, y: -100 };
  const saved = structuredClone(frames);
  const display = peakDisplayTrajectory(frames, 600);
  assert.ok(display.length < frames.length / 2);
  for (const index of [0, 1234, 1235, 17999])
    assert.ok(display.some((p) => p[2] === frames[index].time));
  assert.equal(display.filter((p) => p[0] === null).length, frames.filter((f) => !f.center).length);
  assert.ok(display.every((p, i) => !i || p[2] > display[i - 1][2]));
  assert.deepEqual(frames, saved);
});
import { AnalysisSession } from '../src/analysis/session.ts';
import { demoPose } from '../src/utils/demo.ts';
import { emptyAngles, jointAngles, angleValue } from '../src/utils/poseMath.ts';
import {
  trajectoryBounds,
  paddedExtent,
  velocityHeatmap,
  pointSeries,
  groupMarkers,
  LABEL_ANCHORS,
  placeLabel,
} from '../src/utils/visualization.ts';
import { DEMO_SIZE, stageSize, reportSize } from '../src/utils/dimensions.ts';
import type { PoseFrame } from '../src/types.ts';
const session = () =>
  new AnalysisSession('demo', {
    threshold: 0.5,
    window: 1,
    aspect: 850 / 590,
    metricVersion: '2.0',
  });
const make = (times: number[]) => {
  const s = session();
  for (const t of times) s.append(demoPose(t), t);
  return s.frames;
};
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('trajectory fits empty, stationary, outside-frame and extreme-aspect points with source-aware equal scale', () => {
  for (const points of [
    [],
    [{ x: 0.5, y: 0.5 }],
    [
      { x: -0.4, y: 1.7 },
      { x: 1.5, y: -0.1 },
    ],
  ])
    for (const aspect of [0.3, 1, 2]) {
      const frames = points.map((center) => ({ center })) as PoseFrame[];
      const b = trajectoryBounds(frames, 410, 210, aspect);
      assert.ok([...b.x, ...b.y].every(Number.isFinite));
      assert.ok(b.x[1] > b.x[0] && b.y[1] > b.y[0]);
      close(410 / (b.x[1] - b.x[0]) / (210 / (b.y[1] - b.y[0])), aspect);
      for (const p of points)
        assert.ok(p.x > b.x[0] && p.x < b.x[1] && p.y > b.y[0] && p.y < b.y[1]);
    }
  assert.deepEqual(paddedExtent([NaN, Infinity]), [0, 1]);
});

test('heatmap bins source time, includes last frame and all seven joints, excludes boundary velocity and preserves true peaks', () => {
  const frames = make([0, 0.01, 0.02, 0.9, 1]);
  frames.forEach((f, i) => {
    f.velocity = emptyAngles();
    f.velocity.wrist = { left: i === 4 ? 20000 : 0, right: null };
    f.velocity.spine.midline = 3;
  });
  frames[0]!.velocity.wrist.left = 90000;
  const heat = velocityHeatmap(frames, 24);
  assert.equal(heat.buckets.length, 2);
  assert.equal(heat.cells.length, 14);
  const wrist = heat.cells.filter((c) => c.row === 6);
  assert.equal(wrist[0]!.value, 0);
  assert.equal(wrist[0]!.valid, 2);
  assert.equal(wrist[1]!.value, 20000);
  assert.equal(heat.peak, 20000);
  assert.ok(heat.cap < heat.peak);
  assert.ok(heat.clipped > 0);
  assert.ok(heat.cells.filter((c) => c.row === 0).every((c) => c.value === null));
  assert.equal(heat.cells.find((c) => c.row === 5)!.value, 3);
});

test('heatmap respects raw/right, missing speed is null and a single frame has no interval velocity', () => {
  const frames = make([12, 13, 17]);
  frames.forEach((f) => {
    f.rawVelocity = emptyAngles();
    f.rawVelocity.knee = { left: 100, right: -7 };
  });
  const heat = velocityHeatmap(frames, 120, 'raw', ['right']);
  assert.equal(heat.peak, 7);
  assert.ok(heat.cells.filter((c) => c.row === 5).every((c) => c.value === null));
  assert.equal(velocityHeatmap(frames.slice(0, 1), 500).peak, null);
  assert.equal(velocityHeatmap([], 500).cells.length, 0);
});

test('18000-frame heatmap bounds columns by width and keeps the final isolated peak', () => {
  const base = make([0])[0]!;
  const frames = Array.from({ length: 18000 }, (_, i) => ({ ...base, time: i / 30 }));
  frames.at(-1)!.velocity = structuredClone(base.velocity);
  frames.at(-1)!.velocity.ankle.right = -12345;
  const narrow = velocityHeatmap(frames, 240),
    wide = velocityHeatmap(frames, 5000);
  assert.equal(narrow.buckets.length, 20);
  assert.equal(wide.buckets.length, 160);
  assert.equal(narrow.peak, 12345);
  assert.equal(wide.peak, 12345);
});

test('point X/Y keeps timestamps and missing/low-confidence gaps, raw differs from filtered', () => {
  const frames = make([0, 1, 2]);
  frames[1]!.rawPoints[15]!.visibility = 0.1;
  frames[1]!.points = [];
  frames[2]!.rawPoints[15]!.x = -0.7;
  frames[2]!.points[15]!.x = 1.2;
  assert.deepEqual(
    pointSeries(frames, 15, 'raw', 0.5, 'x').map((p) => p[0]),
    [0, 1, 2],
  );
  assert.equal(pointSeries(frames, 15, 'raw', 0.5, 'x')[1]![1], null);
  assert.equal(pointSeries(frames, 15, 'filtered', 0.5, 'y')[1]![1], null);
  assert.equal(pointSeries(frames, 15, 'raw', 0.5, 'x')[2]![1], -0.7);
  assert.equal(pointSeries(frames, 15, 'filtered', 0.5, 'x')[2]![1], 1.2);
});

test('marker grouping retains duplicate times, clip endpoints and all choices at narrow widths', () => {
  const markers = [
    { time: 5, label: '中点' },
    { time: 0, label: '起点' },
    { time: 0.01, label: '重叠' },
    { time: 0, label: '同刻' },
    { time: 10, label: '终点' },
    { time: 11, label: '片段外' },
  ];
  const groups = groupMarkers(markers, [0, 10], 200);
  assert.equal(groups[0]!.markers.length, 3);
  assert.equal(groups.at(-1)!.position, 1);
  assert.equal(groups.flatMap((g) => g.markers).length, 5);
  assert.deepEqual(
    groupMarkers(markers, [5, 10], 200)
      .flatMap((g) => g.markers)
      .map((m) => m.time),
    [5, 10],
  );
  assert.equal(groupMarkers([{ time: 5, label: '静止' }], [5, 5], 0)[0]!.position, 0.5);
});

test('all joint label anchors cover six bilateral pairs and one midline, with unreliable angles omitted', () => {
  assert.equal(LABEL_ANCHORS.length, 13);
  assert.equal(LABEL_ANCHORS.filter((a) => a.joint === 'spine').length, 1);
  const p = demoPose(0),
    angles = jointAngles(p, 0.5, 850 / 590);
  assert.equal(
    LABEL_ANCHORS.filter((a) => angleValue(angles, a.joint, a.channel) !== null).length,
    13,
  );
  p[11]!.visibility = 0.1;
  const low = jointAngles(p, 0.5, 850 / 590);
  assert.equal(angleValue(low, 'shoulder', 'left'), null);
  assert.equal(low.spine.midline, null);
  const occupied = [];
  for (const anchor of [
    { x: 10, y: 10 },
    { x: 10, y: 10 },
    { x: 1090, y: 750 },
  ]) {
    const box = placeLabel(anchor, 130, 27, occupied, { width: 1100, height: 764 }, true);
    assert.ok(box.x >= 0 && box.x + box.width <= 1100 && box.y >= 0 && box.y + box.height <= 764);
    assert.ok(
      occupied.every(
        (b) =>
          box.x + box.width <= b.x ||
          box.x >= b.x + b.width ||
          box.y + box.height <= b.y ||
          box.y >= b.y + b.height,
      ),
    );
    occupied.push(box);
  }
});

test('stage and report preserve demo/portrait/landscape aspect without a second image border', () => {
  for (const aspect of [DEMO_SIZE.width / DEMO_SIZE.height, 9 / 16, 16 / 9, 2.4]) {
    const stage = stageSize(aspect),
      report = reportSize(stage);
    assert.ok(Math.abs(stage.width / stage.height - aspect) < 0.004);
    close(report.imageWidth / report.imageHeight, stage.width / stage.height);
    assert.equal(report.width - report.imageWidth, 120);
    assert.ok(report.height > 155 + report.imageHeight + 425);
  }
  assert.ok(Number.isFinite(stageSize(NaN).height));
});
