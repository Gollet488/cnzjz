import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession, METRIC_VERSION } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { FrameSummaryIndex, timeBound } from '../src/analysis/frameIndex.ts';
import { csvChunks, CSV_CHUNK_ROWS } from '../src/utils/csv.ts';
import { writeCSV, blobCSVSink, exportCSV } from '../src/utils/csvExport.ts';
import type { CSVSink, CSVProgress } from '../src/utils/csvExport.ts';
import { SessionPublication } from '../src/utils/publication.ts';
import { demoPose } from '../src/utils/demo.ts';
import { angleValue, channels } from '../src/utils/poseMath.ts';
import { JOINTS } from '../src/config.ts';

const parameters = { threshold: 0.5, window: 5, aspect: 850 / 590, metricVersion: METRIC_VERSION };
export function syntheticSession(count: number) {
  const s = new AnalysisSession('demo', parameters);
  for (let i = 0; i < count; i++) s.append(i % 67 === 66 ? [] : demoPose(i / 30), i / 30);
  return s;
}
// Independent CSV reader handles embedded delimiters/newlines and doubled quotes.
function records(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\r')) {
      row.push(value);
      value = '';
      if (c === '\r') {
        assert.equal(text[++i], '\n');
        rows.push(row);
        row = [];
      }
    } else value += c;
  }
  assert.equal(quoted, false);
  row.push(value);
  rows.push(row);
  return rows;
}
for (const count of [202, 18000])
  test(`CSV ${count} synthetic frames: every row/column, full precision, nulls, marker escaping and repeat`, async () => {
    const s = syntheticSession(count);
    const label = '中文,逗号"引号"\r\n第二行\n末行';
    const markers = [
      { time: s.frames.at(-1)!.time + 0.05, label: '尾部' },
      { time: 0, label },
      { time: 0.01, label: '同桶' },
      { time: 1, label: '边界' },
      { time: -1, label: '区间外' },
      { time: s.frames.at(-1)!.time + 0.051, label: '尾部外' },
    ];
    let rowIndex = 0,
      header: string[] = [],
      maxChunk = 0,
      bytes = 0;
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const blob = blobCSVSink();
    const progress: CSVProgress[] = [];
    const sink: CSVSink = {
      async write(data) {
        maxChunk = Math.max(maxChunk, data.byteLength);
        bytes += data.byteLength;
        if (!header.length) {
          assert.deepEqual([...data.slice(0, 3)], [239, 187, 191]);
          header = records(decoder.decode(data))[0];
          assert.equal(header.length, 354);
          assert.equal(new Set(header).size, header.length);
        } else {
          const rows = records(decoder.decode(data).slice(2));
          assert.ok(rows.length <= CSV_CHUNK_ROWS);
          for (const row of rows) {
            assert.equal(row.length, header.length);
            const f = s.frames[rowIndex];
            const get = (key: string) => row[header.indexOf(key)];
            assert.equal(Number(get('time_s')), f.time);
            assert.equal(get('raw_nose_x'), f.rawPoints[0] ? String(f.rawPoints[0].x) : '');
            assert.equal(get('filtered_nose_x'), f.points[0] ? String(f.points[0].x) : '');
            assert.equal(get('raw_knee_left_deg'), String(f.rawAngles.knee.left ?? ''));
            assert.equal(
              get('filtered_knee_left_velocity_deg_s'),
              String(f.velocity.knee.left ?? ''),
            );
            assert.equal(get('raw_coordinate_variance_norm2'), String(f.variance.raw.value ?? ''));
            assert.equal(get('session_revision'), String(s.info().revision));
            if (!rowIndex) assert.equal(get('markers'), label + ' / 同桶');
            if (rowIndex === 30) assert.equal(get('markers'), '边界');
            if (rowIndex === count - 1) assert.equal(get('markers'), '尾部');
            rowIndex++;
          }
        }
        await blob.sink.write(data);
      },
      close: () => blob.sink.close(),
      abort: (reason) => blob.sink.abort(reason),
    };
    const first = await writeCSV(s.frames, markers, s.info(), sink, {
      onProgress: (p) => progress.push(p),
    });
    assert.equal(rowIndex, count);
    assert.equal(first.bytes, bytes);
    assert.equal(blob.getBlob()!.size, bytes);
    assert.ok(maxChunk < 256 * 1024);
    assert.equal(progress.at(-1)!.state, 'completed');
    let repeatBytes = 0;
    const repeat = await writeCSV(s.frames, markers, s.info(), {
      async write(data) {
        repeatBytes += data.byteLength;
      },
      async close() {},
      async abort() {},
    });
    assert.equal(repeat.bytes, first.bytes);
    assert.equal(repeatBytes, bytes);
    // Every fresh iterator restarts its marker cursor and BOM.
    assert.equal([...csvChunks(s.frames.slice(0, 1), markers, s.info())].length, 2);
  });

test('CSV backpressure, cancellation and failed write/close never report completion or retain Blob', async () => {
  const s = syntheticSession(202);
  const controller = new AbortController();
  let release!: () => void,
    writes = 0,
    aborted = false,
    completed = false;
  const pending = writeCSV(
    s.frames,
    [],
    s.info(),
    {
      async write() {
        writes++;
        await new Promise<void>((r) => {
          release = r;
        });
      },
      async close() {
        completed = true;
      },
      async abort() {
        aborted = true;
      },
    },
    { signal: controller.signal },
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(writes, 1);
  controller.abort();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(writes, 1);
  assert.equal(aborted, true);
  assert.equal(completed, false);
  for (const stage of ['write', 'close']) {
    const blob = blobCSVSink();
    let done = false;
    await assert.rejects(
      writeCSV(
        s.frames,
        [],
        s.info(),
        {
          ...blob.sink,
          async write(data) {
            if (stage === 'write') throw Error('DISK_FULL');
            await blob.sink.write(data);
          },
          async close() {
            throw Error('DISK_FULL');
          },
        },
        {
          onProgress: (p) => {
            if (p.state === 'completed') done = true;
          },
        },
      ),
      /DISK_FULL/,
    );
    assert.equal(done, false);
    assert.equal(blob.getBlob(), undefined);
  }
});

test('export snapshot checks session during write and while save picker is pending', async () => {
  const s = syntheticSession(202),
    ref = s.info();
  const blob = blobCSVSink();
  await assert.rejects(
    writeCSV(s.frames.slice(), [], ref, blob.sink, {
      assertCurrent: () => s.assertCurrent(ref),
      onProgress: (p) => {
        if (p.rows > 0) s.recalculate(parameters);
      },
    }),
    /STALE_SESSION/,
  );
  assert.equal(blob.getBlob(), undefined);
  const host = globalThis as any;
  const original = host.showSaveFilePicker;
  let created = false;
  host.showSaveFilePicker = async () => {
    s.reset();
    return {
      async createWritable() {
        created = true;
        throw Error('unexpected');
      },
    };
  };
  try {
    await assert.rejects(
      exportCSV([], [], ref, { assertCurrent: () => s.assertCurrent(ref) }),
      /STALE_SESSION/,
    );
    assert.equal(created, false);
  } finally {
    if (original === undefined) delete host.showSaveFilePicker;
    else host.showSaveFilePicker = original;
  }
});

test('immediately resolved CSV sink delivers real timer cancellation before completion', async () => {
  const session = syntheticSession(1800);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acceptedAt: number | undefined;
  let writes = 0;
  let lateWrites = 0;
  let closed = false;
  let aborted = false;
  let completed = false;
  try {
    await assert.rejects(
      writeCSV(
        session.frames,
        [],
        session.info(),
        {
          async write() {
            writes++;
            if (acceptedAt !== undefined) lateWrites++;
            if (!timer)
              timer = setTimeout(() => {
                acceptedAt = performance.now();
                controller.abort();
              }, 0);
          },
          async close() {
            closed = true;
          },
          async abort() {
            aborted = true;
          },
        },
        {
          signal: controller.signal,
          onProgress(progress) {
            completed ||= progress.state === 'completed';
          },
        },
      ),
      { name: 'AbortError' },
    );
    assert.notEqual(acceptedAt, undefined);
    assert.ok(performance.now() - acceptedAt! <= 300);
    assert.ok(writes > 0 && writes < 76);
    assert.equal(lateWrites, 0);
    assert.equal(closed, false);
    assert.equal(completed, false);
    assert.equal(aborted, true);
  } finally {
    clearTimeout(timer);
  }
});

test('immediately resolved CSV sink rejects a version changed by an event-loop task', async () => {
  const session = syntheticSession(1800),
    reference = session.info();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = false,
    lateWrites = 0,
    aborted = false;
  try {
    await assert.rejects(
      writeCSV(
        session.frames,
        [],
        reference,
        {
          async write() {
            if (changed) lateWrites++;
            if (!timer)
              timer = setTimeout(() => {
                changed = true;
                session.reset();
              }, 0);
          },
          async close() {
            throw Error('MUST_NOT_CLOSE');
          },
          async abort() {
            aborted = true;
          },
        },
        { assertCurrent: () => session.assertCurrent(reference) },
      ),
      /STALE_SESSION/,
    );
    assert.equal(changed, true);
    assert.equal(lateWrites, 0);
    assert.equal(aborted, true);
  } finally {
    clearTimeout(timer);
  }
});

test('file picker preserves native receiver; file export awaits close and aborts stale writable', async () => {
  const s = syntheticSession(202),
    host = globalThis as any;
  const old = host.showSaveFilePicker;
  let writes = 0,
    closed = false,
    aborted = false;
  host.showSaveFilePicker = async function (this: unknown) {
    assert.equal(this, globalThis);
    return {
      async createWritable() {
        return {
          async write() {
            writes++;
          },
          async close() {
            closed = true;
          },
          async abort() {
            aborted = true;
          },
        };
      },
    };
  };
  try {
    const result = await exportCSV(s.frames, [], s.info());
    assert.equal(result.mode, 'file');
    assert.equal(writes, 10);
    assert.equal(closed, true);
    assert.equal(aborted, false);
    const before = s.info();
    host.showSaveFilePicker = async () => ({
      async createWritable() {
        s.recalculate(parameters);
        return {
          async write() {
            throw Error('MUST_NOT_WRITE');
          },
          async close() {},
          async abort() {
            aborted = true;
          },
        };
      },
    });
    await assert.rejects(
      exportCSV(s.frames, [], before, { assertCurrent: () => s.assertCurrent(before) }),
      /STALE_SESSION/,
    );
    assert.equal(aborted, true);
  } finally {
    if (old === undefined) delete host.showSaveFilePicker;
    else host.showSaveFilePicker = old;
  }
});

test('time index and incremental block summaries match direct scans for clips, missing data and recalculation', () => {
  const s = syntheticSession(310),
    index = new FrameSummaryIndex();
  index.update(s.frames);
  for (const interval of [
    [0, 309 / 30],
    [0, 0],
    [0.7, 7.8],
    [4.2667, 8.6],
    [20, 21],
    [3, 2],
  ] as [number, number][]) {
    const frames = s.frames.filter((f) => f.time >= interval[0] && f.time <= interval[1]);
    const result = index.query(interval);
    const asym = frames.flatMap((f) => (f.asymmetry === null ? [] : [f.asymmetry]));
    assert.ok(
      result.meanAsym === null
        ? !asym.length
        : Math.abs(result.meanAsym - asym.reduce((a, b) => a + b, 0) / asym.length) < 1e-10,
    );
    const speeds = frames.slice(1).flatMap((f) =>
      JOINTS.flatMap((j) =>
        channels(j.key).flatMap((c) => {
          const n = angleValue(f.velocity, j.key, c);
          return n === null ? [] : [Math.abs(n)];
        }),
      ),
    );
    assert.equal(result.maxVelocity, speeds.length ? Math.max(...speeds) : null);
    for (const j of result.joints) {
      const values = frames.flatMap((f) => {
        const n = angleValue(f.angles, j.key, j.key === 'spine' ? 'midline' : 'left');
        return n === null ? [] : [n];
      });
      assert.equal(
        j.left.rom,
        values.length < 2 ? null : Math.max(...values) - Math.min(...values),
      );
    }
  }
  const old = index.query().joints[3].left.rom;
  s.append(demoPose(20), 20);
  index.update(s.frames);
  assert.equal(timeBound(s.frames, 20), 310);
  assert.equal(timeBound(s.frames, 20, true), 311);
  s.recalculate({ ...parameters, threshold: 1 });
  index.update(s.frames);
  assert.notEqual(index.query().joints[3].left.rom, old);
  s.reset();
  index.update(s.frames);
  assert.equal(index.query().centerRange, null);
});

test('query cache protects returned objects and invalidates append, parameters, acquisition and reset', () => {
  const s = syntheticSession(202),
    registry = createToolRegistry(s);
  const args = () => ({
    sessionId: s.info().sessionId,
    revision: s.info().revision,
    interval: [0, 5],
    joint: 'knee',
    channels: ['left'],
    basis: 'filtered',
  });
  const first = registry.execute('query_metrics', args());
  assert.ok(first.ok);
  const original = structuredClone(first.result) as any;
  (first.result as any).channels[0].rom = 999;
  const next = registry.execute('query_metrics', args());
  assert.ok(next.ok);
  assert.deepEqual(next.result, original);
  for (const change of [
    () => s.append([], 7),
    () => s.recalculate({ ...parameters, window: 1 }),
    () =>
      s.setAcquisition({
        mode: 'webcodecs',
        status: 'cancelled',
        expectedFrames: 300,
        processedFrames: s.frames.length,
        codec: 'avc1',
        rotation: 0,
        mediaTimeOffset: 0,
      }),
    () => s.reset(),
  ]) {
    const before = args();
    change();
    const stale = registry.execute('query_metrics', before);
    assert.ok(!stale.ok);
    assert.equal(stale.error.code, 'STALE_SESSION');
    if (s.frames.length) {
      const fresh = registry.execute('query_metrics', args());
      assert.ok(fresh.ok);
      assert.equal((fresh.result as any).evidence.revision, s.info().revision);
    }
  }
});

test('batched publication coalesces appends and flushes the last frame; cancelled timers do not publish', async () => {
  let count = 0;
  const publication = new SessionPublication(() => count++, 10);
  for (let i = 0; i < 202; i++) publication.schedule();
  assert.equal(count, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count, 1);
  publication.schedule();
  publication.flush();
  assert.equal(count, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count, 2);
  publication.schedule();
  publication.cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count, 2);
});
