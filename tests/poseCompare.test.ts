import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import ts from 'typescript';
import * as math from '../src/utils/poseMath.ts';
import { stageSize } from '../src/utils/dimensions.ts';
import { humanPose } from '../src/utils/humanPose.ts';
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
// boundaries are replaced; filtering, distance, watchers and lifecycle are real.
async function mount(t: any) {
  const state: any = {
    points: [fixture(), fixture().map((p) => ({ ...p, x: p.x / 2 }))],
    draws: [],
    models: [],
    errors: [],
    callbacks: new Map(),
    create: undefined,
    prepare: async (file: File) => ({ file, transcoded: false }),
  };
  let frameId = 0;
  const oldRAF = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    state.callbacks.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => state.callbacks.delete(id);
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
    '@mediapipe/tasks-vision': {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      PoseLandmarker: {
        createFromOptions: async () => {
          if (state.create) return state.create();
          const lane = state.models.length % 2;
          const model = {
            closed: false,
            close() {
              this.closed = true;
            },
            detectForVideo() {
              return { landmarks: [state.points[lane]], close() {} };
            },
          };
          state.models.push(model);
          return model;
        },
      },
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
    '../utils/humanPose': { humanPose },
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
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      app.unmount();
      mounted = false;
    }
  };
  t.after(() => {
    unmount();
    globalThis.requestAnimationFrame = oldRAF;
    globalThis.cancelAnimationFrame = oldCancel;
  });
  const step = (seconds = 0.11) => {
    videos.forEach((v) => {
      v.currentTime += seconds;
    });
    s.tick();
  };
  const load = (i: number, name: string) =>
    s.load(i, {
      target: { files: [new File(['video'], name, { type: 'video/mp4' })], value: name },
    });
  return { state, settings, s, videos, step, load, unmount };
}
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('comparison uses source aspects, independent filters, window and display settings', async (t) => {
  const q = await mount(t);
  await q.s.play();
  q.step();
  near(q.s.distance, 0);
  q.state.points[0][0].x += 0.33;
  q.step();
  near(q.s.distance, 0.01); // 0.33 / 2-sample mean / 0.5 torso / 33 points
  near(q.s.displayed[1][0].x, 0.2);
  q.s.pause();
  const retained = q.s.distance;
  q.settings.skeleton = false;
  q.settings.labels = false;
  q.settings.trajectory = false;
  await vue.nextTick();
  assert.equal(q.s.distance, retained);
  assert.equal(q.state.draws.at(-1).settings.skeleton, false);
  assert.equal(q.state.draws.at(-1).settings.labels, false);
  assert.equal(q.state.draws.at(-1).trail.length, 0);
  q.settings.window = 1;
  assert.equal(q.s.distance, null);
  assert.equal(q.s.time, 0);
  assert.deepEqual(q.s.displayed, [[], []]);
  await q.s.play();
  q.step();
  near(q.s.distance, 0.02);
  q.settings.threshold = 0.9;
  assert.equal(q.s.distance, null);
  assert.equal(q.s.running, false);
  await q.s.play();
  q.step();
  assert.equal(q.s.distance, null);
  q.settings.threshold = 0.5;
  await q.s.play();
  q.step();
  near(q.s.distance, 0.02);
  assert.deepEqual(q.state.errors, []);
});

test('comparison missing detection resets only its lane; restart clears both histories', async (t) => {
  const q = await mount(t);
  await q.s.play();
  q.step();
  q.state.points[0] = [];
  q.step();
  assert.equal(q.s.distance, null);
  q.state.points[0] = fixture();
  q.state.points[0][0].x += 0.33;
  q.state.points[1][0].x += 0.33 / 2;
  q.step();
  near(q.s.distance, 0.01); // lane 0 fresh, lane 1 still smooths
  q.s.pause();
  await q.s.play();
  q.step();
  near(q.s.distance, 0);
  q.videos[0].ended = true;
  q.step();
  assert.equal(q.s.running, false);
  near(q.s.distance, 0); // retained last valid paused result
});

test('comparison retains one pair per media-time slot and exports gaps and missing values', async (t) => {
  const q = await mount(t);
  await q.s.play();
  q.s.tick();
  q.step(0.04);
  assert.equal(q.s.sampleCount, 1);
  assert.equal(q.s.frame.slot, 0);
  q.state.points[1] = [];
  q.step(0.3);
  assert.equal(q.s.sampleCount, 2);
  assert.equal(q.s.missed, 2);
  assert.equal(q.s.series.distanceCount, 1);
  assert.deepEqual(q.s.series.poses, [2, 1]);
  assert.equal(q.s.frame.distance, null);
  assert.equal(q.s.frame.readings.find((reading: any) => reading.reference !== null).delta, null);
  q.s.pause();
  await q.s.exportSamples();
  const csv = (await q.state.exported.text()).replace(/^\uFEFF/, '');
  const rows: string[][] = csv.split('\r\n').map((row: string) => row.slice(1, -1).split('","'));
  const header = rows.shift()!;
  const value = (slot: number, field: string) => rows[slot][header.indexOf(field)];
  assert.equal(rows.length, 40);
  assert.ok(rows.every((row) => row.length === header.length));
  assert.equal(value(0, 'sample_status'), 'paired');
  assert.equal(value(0, 'candidate_time_s'), '0');
  assert.equal(value(0, 'reference_time_basis'), 'playback_clock');
  assert.equal(value(0, 'normalized_pose_distance'), '0');
  assert.equal(value(2, 'sample_status'), 'missed');
  assert.equal(value(2, 'candidate_pose_detected'), '');
  assert.equal(value(3, 'candidate_pose_detected'), 'false');
  assert.equal(value(3, 'filtered_elbow_left_delta_deg'), '');
  assert.equal(value(4, 'sample_status'), 'not_reached');
  assert.equal(value(39, 'analysis_status'), 'paused');
  await q.s.review(q.s.series.samples[0]);
  assert.equal(q.s.frameIndex, 0);
  await q.s.play(false);
  near(q.videos[0].currentTime, 0.34);
  q.s.tick();
  assert.equal(q.s.sampleCount, 2);
  q.videos[0].ended = true;
  q.s.tick();
  await q.s.exportSamples();
  const lastRow = (await q.state.exported.text()).split('\r\n').at(-1)!;
  assert.equal(lastRow.split('","')[2], 'missed');
  assert.equal(q.s.missed, 38);
  q.settings.window = 3;
  assert.equal(q.s.sampleCount, 0);
});

test('comparison uses presented frame times and skips pairs beyond sync tolerance', async (t) => {
  const q = await mount(t);
  const callbacks: VideoFrameRequestCallback[] = [];
  q.videos.forEach((video, i) =>
    Object.assign(video, {
      requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
        callbacks[i] = callback;
        return i;
      },
      cancelVideoFrameCallback() {},
    }),
  );
  const present = (a: number, b: number) =>
    [a, b].forEach((mediaTime, i) => callbacks[i](0, { mediaTime } as VideoFrameCallbackMetadata));
  await q.s.play();
  q.step(0.04);
  assert.equal(q.s.sampleCount, 0);
  present(0.025, 0.03);
  q.s.tick();
  assert.deepEqual(q.s.frame.times, [0.025, 0.03]);
  assert.deepEqual(q.s.frame.timeBasis, ['presented_frame', 'presented_frame']);
  present(0.23, 0.1);
  q.step(0.2);
  assert.equal(q.s.sampleCount, 1);
  present(0.25, 0.23);
  q.s.tick();
  assert.equal(q.s.sampleCount, 2);
  assert.equal(q.s.missed, 1);
  near(q.s.frame.skew, -0.02);
  assert.deepEqual(comparison.comparisonSchedule(0), { interval: 0.1, slots: 0 });
  assert.deepEqual(comparison.comparisonSchedule(3600), { interval: 0.2, slots: 18000 });
});

test('aligned comparison retains signed joint differences and replays a peak with both source times', async (t) => {
  const q = await mount(t);
  q.settings.window = 1;
  const setStart = (index: number, value: number) => q.s.setStart(index, { target: { value } });
  setStart(0, 0.2);
  setStart(1, 0.8);
  const leftElbow = q.s.measurements.findIndex(
    (m: any) => m.joint === 'elbow' && m.side === 'left',
  );
  const [reference, candidate] = q.state.points as Landmark[][];
  candidate[27].y = 0.35;
  reference[15].x = reference[13].x;
  reference[15].y = 0.7;
  await q.s.play(false);
  q.step();
  const peak = q.s.peaks[leftElbow];
  near(peak.readings[leftElbow].reference, 180);
  near(peak.readings[leftElbow].candidate, 90);
  near(peak.readings[leftElbow].delta, -90);
  near(peak.elapsed, 0.11);
  near(peak.times[0], 0.31);
  near(peak.times[1], 0.91);
  candidate[15].visibility = 0.3;
  q.step();
  assert.equal(q.s.frame.readings[leftElbow].delta, null);
  assert.equal(q.s.peaks[leftElbow], peak);
  for (const video of q.videos) {
    let currentTime = video.currentTime;
    Object.defineProperty(video, 'currentTime', {
      get: () => currentTime,
      set(value: number) {
        currentTime = value;
        video.seeking = true;
      },
    });
  }
  const replay = q.s.review(peak);
  assert.equal(q.s.running, false);
  assert.equal(q.s.reviewing, true);
  q.videos[0].seeking = false;
  q.videos[0].dispatchEvent(new Event('seeked'));
  await Promise.resolve();
  assert.notEqual(q.s.frame, peak);
  q.videos[1].seeking = false;
  q.videos[1].dispatchEvent(new Event('seeked'));
  await replay;
  assert.equal(q.s.frame, peak);
  assert.equal(q.s.showingPeak, true);
  near(q.videos[0].currentTime, 0.31);
  near(q.videos[1].currentTime, 0.91);
  await q.s.play(false);
  near(q.videos[0].currentTime, 0.42);
  near(q.videos[1].currentTime, 1.02);
  q.s.pause();
  setStart(1, 0.5);
  assert.equal(q.s.frame, null);
  assert.deepEqual(q.s.peaks, []);
  near(q.videos[1].currentTime, 0.5);
});

test('comparison replacement cancels old preparation, clears results and ignores late success/error/progress', async (t) => {
  const q = await mount(t);
  await q.s.play();
  q.step();
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

for (const invalidate of ['parameters', 'source', 'unmount']) {
  test(`comparison closes a model completing after ${invalidate} invalidates initialization`, async (t) => {
    const q = await mount(t),
      started = deferred(),
      pending = deferred();
    const model = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    q.state.create = () => {
      started.resolve();
      return pending.promise;
    };
    const playing = q.s.play();
    await started.promise;
    if (invalidate === 'parameters') q.settings.window = 3;
    if (invalidate === 'source') await q.load(0, 'replacement.mp4');
    if (invalidate === 'unmount') q.unmount();
    pending.resolve(model);
    await playing;
    assert.equal(model.closed, true);
    assert.equal(q.s.models.length, 0);
    assert.equal(q.s.running, false);
    assert.equal(q.s.distance, null);
    assert.ok(q.videos.every((v) => v.paused));
    assert.deepEqual(q.state.errors, []);
  });
}

test('comparison pauses late play promises after invalidation and ignores duplicate starts', async (t) => {
  const q = await mount(t),
    pending = deferred(),
    started = deferred();
  q.videos[1].play = async function () {
    started.resolve();
    await pending.promise;
    this.paused = false;
  };
  const playing = q.s.play();
  await Promise.race([started.promise, playing]);
  assert.equal(q.videos[0].paused, false);
  await q.s.play();
  assert.equal(q.state.models.length, 2);
  q.settings.threshold = 0.7;
  pending.resolve();
  await playing;
  assert.ok(q.videos.every((v) => v.paused));
  assert.equal(q.s.running, false);
  assert.equal(q.s.distance, null);
  assert.equal(q.state.callbacks.size, 0);
});

test('comparison keeps start locked until every playback promise settles after one rejects', async (t) => {
  const q = await mount(t),
    pending = deferred(),
    started = deferred();
  q.videos[0].play = async () => {
    throw new Error('play denied');
  };
  q.videos[1].play = async function () {
    started.resolve();
    await pending.promise;
    this.paused = false;
  };
  const playing = q.s.play();
  await Promise.race([started.promise, playing]);
  assert.equal(q.state.models.length, 2);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(q.s.busy, true);
  await q.s.play();
  assert.equal(q.s.busy, true);
  q.settings.window = 3;
  pending.resolve();
  await playing;
  assert.equal(q.s.busy, false);
  assert.equal(q.s.running, false);
  assert.ok(q.videos.every((v) => v.paused));
  assert.deepEqual(q.state.errors, []);
});

test('comparison closes partially initialized models on load failure and can retry', async (t) => {
  const q = await mount(t);
  const first = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  let calls = 0;
  q.state.create = async () => {
    if (++calls === 1) return first;
    throw new Error('model failed');
  };
  await q.s.play();
  assert.equal(first.closed, true);
  assert.equal(q.s.models.length, 0);
  assert.equal(q.s.busy, false);
  assert.equal(q.s.distance, null);
  assert.equal(q.state.errors.length, 1);
  q.state.create = undefined;
  await q.s.play();
  q.step();
  near(q.s.distance, 0);
  q.unmount();
  assert.ok(q.state.models.every((model: any) => model.closed));
});
