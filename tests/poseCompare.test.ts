import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import * as math from '../src/utils/poseMath.ts';
import { stageSize } from '../src/utils/dimensions.ts';
import { SampleContinuity } from '../src/analysis/sampleTiming.ts';
import { AnalysisSession, OFFLINE_METRIC_VERSION } from '../src/analysis/session.ts';
import * as comparison from '../src/video/comparison.ts';
import type { Landmark } from '../src/types.ts';

const fixture = (): Landmark[] => {
  const points = Array.from({ length: 33 }, () => ({ x: 0.4, y: 0.5, z: 0, visibility: 0.8 }));
  for (const i of [11, 12]) points[i].y = 0.25;
  for (const i of [23, 24]) points[i].y = 0.75;
  points[15].x = 0.2;
  return points;
};
const deferred = () => {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Compile and mount the actual SFC setup with Vue's renderer. Only browser/media
// boundaries are replaced; the tracking coordinator, filtering and lifecycle are real.
async function mount(t: any) {
  const makeSource = (name: string) => ({
    file: new File(['video'], name, { type: 'video/mp4' }),
    transcoded: false,
    probe: { timestamps: Float64Array.from({ length: 40 }, (_, i) => i * 100_000) },
  });
  const state: any = {
    points: [fixture(), fixture().map((p) => ({ ...p, x: p.x / 2 }))],
    draws: [],
    jobs: [],
    errors: [],
    prepare: async (file: File) => ({ ...makeSource(file.name), file }),
  };
  class OfflineVideoJob {
    closed = false;
    paused = false;
    callbacks: any;
    previewTimestamps: number[];
    constructor(
      file: File,
      _limit: number,
      callbacks: any,
      _clip: unknown,
      _mode: unknown,
      previewTimestamps: number[],
    ) {
      if (state.failStart?.(file)) throw new Error('worker failed');
      this.callbacks = callbacks;
      this.previewTimestamps = previewTimestamps;
      const i = state.jobs.length % 2;
      callbacks.state('preparing');
      callbacks.metadata({ aspect: i ? 2 : 1 });
      state.jobs.push(this);
    }
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    cancel() {
      this.closed = true;
      this.callbacks.state('cancelled');
    }
  }
  const bitmap = () => ({
    closed: false,
    close() {
      this.closed = true;
    },
  });
  const settings = vue.reactive({
    threshold: 0.5,
    window: 2,
    skeleton: true,
    labels: true,
    trajectory: true,
    labelJoints: ['knee'],
  });
  const modules: any = {
    vue,
    'lucide-vue-next': {},
    '../config': { MAX_FRAMES: 18000 },
    '../analysis/sampleTiming': { SampleContinuity },
    '../video/job': {
      OfflineVideoJob,
      readVideoStill: (...args: any[]) => state.readStill?.(...args) ?? Promise.resolve(bitmap()),
    },
    '../utils/renderer': {
      renderPose: (...args: any[]) =>
        state.draws.push(
          structuredClone({
            points: args[1],
            settings: { ...args[2], labelJoints: [...args[2].labelJoints] },
            trail: args[4],
          }),
        ),
    },
    '../utils/poseMath': math,
    '../video/comparison': comparison,
    '../utils/download': { download: (blob: Blob) => (state.exported = blob) },
    '../utils/dimensions': { stageSize },
    './PlaybackTransport.vue': { default: {} },
    '../video/prepare': {
      VIDEO_ACCEPT: 'video/*',
      prepareVideo: (...args: any[]) => state.prepare(...args),
    },
  };
  const source = await readFile(
    new URL('../src/components/PoseCompare.vue', import.meta.url),
    'utf8',
  );
  const compiled = compileScript(parse(source).descriptor, { id: 'compare-unit' });
  const js = ts.transpileModule(
    compiled.content.replaceAll('import.meta.env.BASE_URL', '"/cnzjz/"'),
    {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const key = `compareUnit${Math.random().toString(36).slice(2)}`;
  (globalThis as any)[key] = modules;
  const injected = `const moduleMocks = globalThis[${JSON.stringify(key)}];\n${js
    .replace(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?$/gm, (_, binding, specifier) => {
      assert.ok(modules[specifier], `Unexpected dependency: ${specifier}`);
      return `const ${binding} = moduleMocks[${JSON.stringify(specifier)}].default;`;
    })
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm, (_, bindings, specifier) => {
      assert.ok(modules[specifier], `Unexpected dependency: ${specifier}`);
      return `const {${bindings.replace(/\s+as\s+/g, ':')}} = moduleMocks[${JSON.stringify(specifier)}];`;
    })
    .replace(/\bimport\(['"]([^'"]+)['"]\)/g, (_, specifier) => {
      assert.ok(modules[specifier], `Unexpected dependency: ${specifier}`);
      return `Promise.resolve(moduleMocks[${JSON.stringify(specifier)}])`;
    })}`;
  const component = (
    await import(`data:text/javascript;base64,${Buffer.from(injected).toString('base64')}`)
  ).default;
  delete (globalThis as any)[key];
  component.render = () => null;
  const renderer = vue.createRenderer<any, any>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp(component, {
    settings,
    onError: (message: string) => state.errors.push(message),
  });
  app.mount({});
  const s = app._instance!.setupState as any;
  const videos = [0, 1].map((i) =>
    Object.assign(new EventTarget(), {
      readyState: 4,
      videoWidth: i ? 2000 : 1000,
      videoHeight: 1000,
      duration: 4,
      currentTime: 0,
      ended: false,
      seeking: false,
      paused: true,
      src: '',
      pause() {
        this.paused = true;
      },
      async play() {
        this.paused = false;
      },
      load() {},
      removeAttribute() {
        this.src = '';
        this.readyState = 0;
      },
    }),
  );
  s.videos.push(...videos);
  s.canvases.push({}, {});
  s.durations = [4, 4];
  s.names[0] = 'reference.mp4';
  s.names[1] = 'candidate.mp4';
  const sources = ['reference.mp4', 'candidate.mp4'].map(makeSource);
  s.preparedVideos.push(...sources);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      app.unmount();
      mounted = false;
    }
  };
  t.after(unmount);
  const send = (i: number, time: number, points = state.points[i]) => {
    const job = s.activeRun.jobs[i];
    assert.equal(job.paused, false);
    const preview = job.previewTimestamps.includes(Math.round(time * 1e6)) ? bitmap() : undefined;
    const ack = job.callbacks.frame({ time, points, preview });
    return { ack, preview };
  };
  const pair = (a: number, b = a) => {
    send(0, a);
    send(1, b);
  };
  const finish = () => {
    const { jobs } = s.activeRun;
    jobs.forEach((job: OfflineVideoJob) => job.callbacks.state('completed'));
  };
  const load = (i: number, name: string) =>
    s.load(i, {
      target: { files: [new File(['video'], name, { type: 'video/mp4' })], value: name },
    });
  return { state, settings, s, videos, sources, send, pair, finish, load, unmount };
}
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('comparison uses independent motion-adaptive filters before pairing and shares file angles', async (t) => {
  const q = await mount(t);
  const capture = new AnalysisSession('file', {
    threshold: q.settings.threshold,
    window: q.settings.window,
    aspect: 1,
    metricVersion: OFFLINE_METRIC_VERSION,
  });
  q.sources.forEach(({ probe }) => {
    probe.timestamps = Float64Array.of(0, 50_000, 100_000, 200_000);
  });
  q.s.play();
  q.pair(0);
  capture.append(q.state.points[0], 0);
  near(q.s.distance, 0);
  q.state.points[0][0].x += 0.01;
  q.send(0, 0.05);
  q.send(1, 0.05);
  capture.append(q.state.points[0], 0.05);
  assert.equal(q.s.sampleCount, 1);
  q.state.points[0][0].x += 0.01;
  q.pair(0.1);
  capture.append(q.state.points[0], 0.1);
  assert.deepEqual(q.s.frame.angles[0], capture.frames.at(-1)!.angles);
  assert.deepEqual(q.s.frame.points[0], capture.frames.at(-1)!.points);
  near(q.s.displayed[0][0].x, (0.42 + 0.4 * 0.41) / 1.4);
  near(q.s.displayed[1][0].x, 0.2);
  q.state.points[0] = [];
  q.pair(0.2);
  assert.equal(q.s.distance, null);
  q.s.pause();
  q.settings.skeleton = false;
  q.settings.labels = false;
  q.settings.trajectory = false;
  await vue.nextTick();
  assert.equal(q.state.draws.at(-1).settings.skeleton, false);
  assert.equal(q.state.draws.at(-1).settings.labels, false);
  assert.equal(q.state.draws.at(-1).trail.length, 0);
  q.settings.window = 1;
  assert.equal(q.s.frame, null);
  assert.deepEqual(q.s.displayed, [[], []]);
  assert.ok(q.state.jobs.every((job: any) => job.closed));
});

test('comparison pairs decoded source times and exports gaps separately from missing poses', async (t) => {
  const q = await mount(t);
  q.sources[0].probe.timestamps = Float64Array.of(25_000, 230_000, 340_000);
  q.sources[1].probe.timestamps = Float64Array.of(30_000, 100_000, 320_000);
  q.s.play();
  q.pair(0.025, 0.03);
  q.send(1, 0.1);
  q.send(0, 0.23);
  q.state.points[1] = [];
  q.pair(0.34, 0.32);
  assert.equal(q.s.sampleCount, 2);
  assert.equal(q.s.missed, 2);
  assert.equal(q.s.series.distanceCount, 1);
  assert.deepEqual(q.s.series.poses, [2, 1]);
  assert.equal(q.s.frame.distance, null);
  near(q.s.frame.skew, -0.02);
  q.s.pause();
  await q.s.exportSamples();
  const csv = (await q.state.exported.text()).replace(/^\uFEFF/, '');
  const rows: string[][] = csv.split('\r\n').map((row: string) => row.slice(1, -1).split('","'));
  const header = rows.shift()!;
  const value = (slot: number, field: string) => rows[slot][header.indexOf(field)];
  assert.equal(rows.length, 40);
  assert.ok(rows.every((row) => row.length === header.length));
  assert.equal(value(0, 'sample_status'), 'paired');
  assert.equal(value(0, 'candidate_time_s'), '0.03');
  assert.equal(value(0, 'reference_time_basis'), 'decoded_frame');
  assert.equal(value(0, 'normalized_pose_distance'), '0');
  assert.equal(value(2, 'sample_status'), 'missed');
  assert.equal(value(2, 'candidate_pose_detected'), '');
  assert.equal(value(3, 'candidate_pose_detected'), 'false');
  assert.equal(value(3, 'filtered_elbow_left_delta_deg'), '');
  assert.equal(value(4, 'sample_status'), 'not_reached');
  assert.equal(value(39, 'analysis_status'), 'paused');
  await q.s.review(q.s.series.samples[0]);
  assert.equal(q.s.frameIndex, 0);
  q.s.play(false);
  q.finish();
  assert.equal(q.s.finished, true);
  assert.equal(q.s.missed, 38);
  assert.deepEqual(comparison.comparisonSchedule(0), { interval: 0.1, slots: 0 });
  assert.deepEqual(comparison.comparisonSchedule(3600), { interval: 0.2, slots: 18000 });
});

test('aligned comparison retains signed differences and replays the exact pair of source frames', async (t) => {
  const q = await mount(t);
  q.settings.window = 1;
  q.s.setStart(0, { target: { value: 0.2 } });
  q.s.setStart(1, { target: { value: 0.8 } });
  const leftElbow = q.s.measurements.findIndex(
    (m: any) => m.joint === 'elbow' && m.side === 'left',
  );
  const [reference, candidate] = q.state.points as Landmark[][];
  reference[15].x = reference[13].x;
  reference[15].y = 0.7;
  q.s.play();
  q.pair(0.2, 0.8);
  const peak = q.s.peaks[leftElbow];
  near(peak.readings[leftElbow].reference, 180);
  near(peak.readings[leftElbow].candidate, 90);
  near(peak.readings[leftElbow].delta, -90);
  candidate[15].visibility = 0.3;
  q.pair(0.3, 0.9);
  assert.equal(q.s.frame.readings[leftElbow].delta, null);
  assert.equal(q.s.peaks[leftElbow], peak);
  const sourceFrames: unknown[] = [];
  q.state.readStill = (file: File, index: number, time: number) => {
    sourceFrames.push([file.name, index, time]);
    return Promise.resolve({ close() {} });
  };
  await q.s.review(peak);
  assert.equal(q.s.running, false);
  assert.equal(q.s.frame, peak);
  assert.equal(q.s.showingPeak, true);
  assert.deepEqual(sourceFrames, [
    ['reference.mp4', 2, 0.2],
    ['candidate.mp4', 8, 0.8],
  ]);
  q.s.play(false);
  assert.ok(q.s.activeRun.jobs.every((job: any) => !job.paused));
  q.pair(0.4, 1);
  assert.equal(q.s.frameIndex, 2);
});

test('comparison replacement cancels old preparation, clears results and ignores late success/error/progress', async (t) => {
  const q = await mount(t);
  await q.s.play();
  q.pair(0);
  const calls: any[] = [];
  q.state.prepare = (file: File, signal: AbortSignal, progress: any) => {
    const d = deferred();
    calls.push({ ...d, file, signal, progress });
    return d.promise;
  };
  const old = q.load(0, 'old.mp4');
  assert.equal(q.s.distance, null);
  assert.equal(q.s.time, 0);
  assert.equal(q.s.running, false);
  const fresh = q.load(0, 'new.mp4');
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve({ file: calls[1].file, transcoded: false });
  await fresh;
  calls[0].progress('old progress');
  calls[0].resolve({ file: calls[0].file, transcoded: true });
  await old;
  assert.equal(q.s.names[0], 'new.mp4');
  assert.equal(q.s.hints[0], '');
  const failed = q.load(0, 'late-failure.mp4');
  const latest = q.load(0, 'latest.mp4');
  calls[2].reject(new Error('old failure'));
  await failed;
  calls[3].resolve({ file: calls[3].file, transcoded: false });
  await latest;
  assert.equal(q.s.names[0], 'latest.mp4');
  assert.deepEqual(q.state.errors, []);
});

for (const action of ['parameters', 'source', 'unmount'] as const) {
  test(`comparison cancels both workers and releases an unmatched image on ${action}`, async (t) => {
    const q = await mount(t);
    q.s.play();
    const jobs = [...q.s.activeRun.jobs];
    const { ack, preview } = q.send(0, 0);
    assert.ok(ack instanceof Promise);
    assert.equal(q.s.frame, null);
    if (action === 'parameters') q.settings.window = 3;
    if (action === 'source') await q.load(0, 'replacement.mp4');
    if (action === 'unmount') q.unmount();
    await ack;
    assert.equal(preview?.closed, true);
    assert.ok(jobs.every((job) => job.closed));
    assert.equal(q.s.running, false);
    assert.equal(q.s.frame, null);
    assert.deepEqual(q.state.errors, []);
  });
}

test('comparison cleans up the first worker if the second fails to start and can retry', async (t) => {
  const q = await mount(t);
  q.state.failStart = (file: File) => file.name === 'candidate.mp4';
  q.s.play();
  assert.equal(q.state.jobs[0].closed, true);
  assert.equal(q.s.activeRun, undefined);
  assert.equal(q.s.running, false);
  assert.equal(q.state.errors.length, 1);
  q.state.jobs.length = 0;
  q.state.failStart = undefined;
  q.s.play();
  q.pair(0);
  near(q.s.distance, 0);
  q.unmount();
  assert.ok(q.state.jobs.every((job: any) => job.closed));
});
