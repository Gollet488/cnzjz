import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readMP4 } from '../src/video/mp4.ts';
import { sourceTimeline, trackRotation, PresentationAudit } from '../src/video/timeline.ts';
import { OfflineVideoJob } from '../src/video/job.ts';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { serializeCSV } from '../src/utils/export.ts';

for (const name of ['30fps', '60fps', 'vfr', 'rotate']) {
  test(`real synthetic ${name} MP4: decode-order index, complete source PTS and final frame match FFmpeg oracle`, async () => {
    const bytes = await readFile(new URL(`./fixtures/${name}.mp4`, import.meta.url));
    const oracle = JSON.parse(
      await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
    );
    const source = await readMP4(new Blob([bytes]));
    assert.equal(source.presentation.length, oracle.count);
    assert.ok(
      source.presentation.every(
        (s, i) => Math.abs(s.timestamp / 1e6 - oracle.ptsSeconds[i]) < 0.0000011,
      ),
    );
    assert.equal(source.presentation[0].timestamp, 0);
    assert.notDeepEqual(
      source.decode.map((s) => s.timestamp),
      source.presentation.map((s) => s.timestamp),
    );
    assert.equal(source.rotation, name === 'rotate' ? 270 : 0);
    assert.equal(source.aspect, name === 'rotate' ? 48 / 64 : 64 / 48);
    const audit = new PresentationAudit(source.presentation.map((s) => s.timestamp));
    for (const sample of source.presentation) audit.accept(sample.timestamp);
    audit.finish();
    if (name === 'vfr')
      assert.deepEqual(
        [
          ...new Set(
            source.presentation
              .slice(1)
              .map((s, i) => Math.round((s.timestamp - source.presentation[i].timestamp) / 1000)),
          ),
        ],
        [33, 67],
      );
  });
}

test('MP4 rejects fragmented/truncated input and checkpoints abort metadata reads', async () => {
  const fragmented = await readFile(new URL('./fixtures/fragmented.mp4', import.meta.url));
  await assert.rejects(readMP4(new Blob([fragmented])), /fragmented/);
  await assert.rejects(readMP4(new Blob([new Uint8Array(12)])), /moov|解封装/);
  await assert.rejects(
    readMP4(new Blob([fragmented]), async () => {
      throw new Error('cancel');
    }),
    /cancel/,
  );
});

test('tail moov is read by skipping a large mdat instead of copying the whole file', async () => {
  const bytes = await readFile(new URL('./fixtures/30fps.mp4', import.meta.url));
  let offset = 0;
  while (bytes.toString('ascii', offset + 4, offset + 8) !== 'mdat')
    offset += bytes.readUInt32BE(offset);
  const size = bytes.readUInt32BE(offset);
  const header = Buffer.from(bytes.subarray(offset, offset + 8));
  const padding = 3 * 1024 * 1024;
  header.writeUInt32BE(size + padding);
  // Unreferenced padding at mdat end does not move any sample offsets.
  const file = new Blob([
    bytes.subarray(0, offset),
    header,
    bytes.subarray(offset + 8, offset + size),
    new Uint8Array(padding),
    bytes.subarray(offset + size),
  ]);
  const source = await readMP4(file);
  assert.equal(source.presentation.length, 30);
  assert.equal(source.presentation.at(-1)!.timestamp, 966667);
  assert.ok(source.bytesRead < 2 * 1024 * 1024);
  assert.ok(source.bytesRead < file.size / 2);
});

test('PTS preserves VFR gaps and edit-list lead/trim without changing decode order', () => {
  const samples = [0, 3, 1, 2, 4].map((cts, i) => ({
    cts: cts * 1000,
    dts: i * 1000,
    duration: 1000,
    offset: i,
    size: 1,
    is_sync: i === 0,
  }));
  const result = sourceTimeline(samples, 1000, 1000, [
    { media_time: -1, segment_duration: 500, media_rate_integer: 1, media_rate_fraction: 0 },
    { media_time: 1000, segment_duration: 3000, media_rate_integer: 1, media_rate_fraction: 0 },
  ]);
  assert.deepEqual(
    result.presentation.map((s) => s.timestamp),
    [500000, 1500000, 2500000],
  );
  assert.deepEqual(
    result.decode.map((s) => s.timestamp),
    [-500000, 2500000, 500000, 1500000, 3500000],
  );
  assert.equal(result.mediaTimeOffset, -0.5);
  assert.throws(
    () =>
      sourceTimeline(samples, 1000, 1000, [
        { media_time: 0, segment_duration: 3000, media_rate_integer: 2, media_rate_fraction: 0 },
      ]),
    /edit list/,
  );
  assert.throws(() => sourceTimeline([samples[0], { ...samples[1], cts: 0 }], 1000, 1000), /重复/);
  assert.throws(() => sourceTimeline([{ ...samples[0], duration: 0 }], 1000, 1000), /时间/);
});

test('rotation matrices are signed fixed point; unsupported transforms fail explicitly', () => {
  for (const [degrees, values] of [
    [0, [1, 0, 0, 1]],
    [90, [0, 1, -1, 0]],
    [180, [-1, 0, 0, -1]],
    [270, [0, -1, 1, 0]],
  ] as const) {
    const [a, b, c, d] = values.map((v) => (v * 65536) >>> 0);
    assert.equal(trackRotation([a, b, 0, c, d, 0, 0, 0, 1073741824]), degrees);
  }
  assert.throws(() => trackRotation([131072, 0, 0, 0, 65536, 0, 0, 0, 1073741824]), /缩放/);
});

test('presentation audit rejects dropped last frame, duplicates and DTS-order outputs', () => {
  const audit = new PresentationAudit([0, 33333, 66667]);
  audit.accept(0);
  assert.throws(() => audit.finish(), /不完整/);
  assert.throws(() => audit.accept(66667), /PTS/);
  audit.accept(33333);
  audit.accept(66667);
  audit.finish();
  assert.throws(() => audit.accept(66667), /PTS/);
});

class FakeWorker {
  static last: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  commands: unknown[] = [];
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(data: unknown) {
    this.commands.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
}
test('offline client holds one unacknowledged frame on pause, resumes once, closes cancelled and late previews', () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const times: number[] = [],
      states: string[] = [];
    let closed = 0;
    const frame = (time: number) => ({
      type: 'frame',
      time,
      index: 1,
      points: [],
      preview: {
        close() {
          closed++;
        },
      },
    });
    const job = new OfflineVideoJob(new File([], 'test.mp4'), 18000, {
      frame(r) {
        times.push(r.time);
        r.preview.close();
      },
      metadata() {},
      state(s) {
        states.push(s);
      },
    });
    const worker = FakeWorker.last;
    job.pause();
    worker.send(frame(0));
    assert.deepEqual(times, []);
    assert.ok(!worker.commands.some((v: any) => v.type === 'ack'));
    job.resume();
    assert.deepEqual(times, [0]);
    job.pause();
    worker.send(frame(1));
    job.cancel();
    worker.send(frame(2));
    job.resume();
    assert.equal(closed, 3);
    assert.deepEqual(times, [0]);
    assert.equal(states.at(-1), 'cancelled');
    assert.equal(worker.terminated, true);
    worker.send({ type: 'done', truncated: false, count: 3 });
    assert.equal(states.at(-1), 'cancelled');
  } finally {
    globalThis.Worker = previous;
  }
});

test('offline acquisition status flows to tools, evidence and CSV; reset rejects old metadata', () => {
  const session = new AnalysisSession('file', {
    threshold: 0.5,
    window: 5,
    aspect: 1.5,
    metricVersion: '2.0',
  });
  const initial = session.info();
  session.setAcquisition({
    mode: 'webcodecs',
    status: 'cancelled',
    expectedFrames: 30,
    processedFrames: 0,
    codec: 'avc1.64000a',
    rotation: 0,
    mediaTimeOffset: -2 / 30,
  });
  session.append([], 0);
  session.append([], 1 / 30);
  const registry = createToolRegistry(session);
  const info = session.info();
  assert.equal(info.acquisition!.processedFrames, 2);
  assert.equal(registry.execute('get_session_info', {}).ok, true);
  const quality = registry.execute('get_quality_summary', {
    sessionId: info.sessionId,
    revision: info.revision,
    interval: [0, 1 / 30],
  });
  assert.equal(quality.ok, true);
  const evidence = (quality as any).result.evidence;
  assert.ok(evidence.limitations.some((s: string) => s.includes('前缀')));
  registry.validateEvidence(evidence);
  assert.throws(
    () =>
      registry.validateEvidence({
        ...evidence,
        acquisition: { ...info.acquisition, status: 'completed' },
      }),
    /EVIDENCE/,
  );
  const csv = serializeCSV(session.frames, [], info);
  assert.ok(csv.includes('"acquisition_status"'));
  assert.ok(csv.includes('"cancelled"'));
  session.reset();
  assert.equal(session.info().acquisition, null);
  assert.throws(() => session.setAcquisition(info.acquisition!, initial), /STALE_SESSION/);
});

test('session frame rejection terminates decoding instead of acknowledging a dropped sample', () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const states: string[] = [];
    const job = new OfflineVideoJob(new File([], 'test.mp4'), 18000, {
      frame(value) {
        value.preview.close();
        return false;
      },
      metadata() {},
      state(value) {
        states.push(value);
      },
    });
    const worker = FakeWorker.last;
    worker.send({ type: 'frame', time: 0, index: 1, points: [], preview: { close() {} } });
    assert.equal(states.at(-1), 'failed');
    assert.equal(worker.terminated, true);
    assert.ok(!worker.commands.some((v: any) => v.type === 'ack'));
    worker.send({ type: 'done', truncated: false, count: 1 });
    assert.equal(states.at(-1), 'failed');
    job.cancel();
  } finally {
    globalThis.Worker = previous;
  }
});
