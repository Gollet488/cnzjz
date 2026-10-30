import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AnalysisSession, METRIC_VERSION } from '../src/analysis/session.ts';
import { FrameSummaryIndex } from '../src/analysis/frameIndex.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { demoPose } from '../src/utils/demo.ts';
import { writeCSV } from '../src/utils/csvExport.ts';

const count = Number(process.argv[2] ?? 18000);
if (![202, 18000].includes(count))
  throw Error(
    'Usage: node --expose-gc scripts/benchmark-session.mjs [202|18000] [output-directory]',
  );
const output = resolve(process.argv[3] ?? '.qa/task5-benchmark');
await mkdir(output, { recursive: true });
const memory = () => process.memoryUsage();
const maxMemory = (a, b) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.max(a[k], b[k])]));
globalThis.gc?.();
const baseline = memory();
const session = new AnalysisSession('demo', {
  threshold: 0.5,
  window: 5,
  aspect: 850 / 590,
  metricVersion: METRIC_VERSION,
});
const index = new FrameSummaryIndex();
const start = performance.now();
for (let i = 0; i < count; i++) {
  session.append(i % 67 === 66 ? [] : demoPose(i / 30), i / 30);
  if (i % 32 === 31) index.update(session.frames);
}
index.update(session.frames);
const acquisitionMs = performance.now() - start;
globalThis.gc?.();
const resident = memory();
const tools = createToolRegistry(session);
const reference = session.info();
const selection = {
  sessionId: reference.sessionId,
  revision: reference.revision,
  joint: 'knee',
  channels: ['left', 'right'],
  basis: 'filtered',
};
const end = reference.range[1];
const timings = {};
const measure = (label, callback, repeats = 1) => {
  const times = [];
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    const result = callback();
    if (result?.ok === false) throw Error(JSON.stringify(result));
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  timings[label] = {
    medianMs: times[Math.floor(times.length / 2)],
    maxMs: times.at(-1),
    runs: repeats,
  };
};
measure('fullQueryCold', () =>
  tools.execute('query_metrics', { ...selection, interval: [0, end] }),
);
measure(
  'fullQueryCached',
  () => tools.execute('query_metrics', { ...selection, interval: [0, end] }),
  100,
);
measure('narrowQueryCold', () =>
  tools.execute('query_metrics', { ...selection, interval: [1, 2] }),
);
measure('qualityCold', () =>
  tools.execute('get_quality_summary', {
    sessionId: reference.sessionId,
    revision: reference.revision,
    interval: [0, end],
  }),
);
measure('compareCold', () =>
  tools.execute('compare_intervals', { ...selection, first: [0, 2], second: [end - 2, end] }),
);
measure('summaryFull', () => index.query(), 100);
measure('summaryClip', () => index.query([1.1, end - 1.1]), 100);
const exports = [];
const markers = [
  { time: 0, label: '中文,逗号"引号"\r\n换行' },
  { time: end, label: '末帧' },
];
for (const run of [1, 2]) {
  globalThis.gc?.();
  const before = memory();
  let peak = before,
    maxChunkBytes = 0;
  const hash = createHash('sha256');
  const file = run === 1 ? await open(join(output, `synthetic-${count}.csv`), 'w') : undefined;
  let previous = performance.now(),
    maxHeartbeatGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - previous);
    previous = now;
    peak = maxMemory(peak, memory());
  }, 10);
  const t = performance.now();
  const result = await writeCSV(
    session.frames,
    markers,
    reference,
    {
      async write(chunk) {
        hash.update(chunk);
        maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
        if (file) {
          let offset = 0;
          while (offset < chunk.byteLength)
            offset += (await file.write(chunk, offset)).bytesWritten;
        }
      },
      async close() {
        await file?.close();
      },
      async abort() {
        await file?.close();
      },
    },
    {
      onProgress() {
        peak = maxMemory(peak, memory());
      },
    },
  );
  clearInterval(heartbeat);
  const elapsedMs = performance.now() - t;
  globalThis.gc?.();
  exports.push({
    run,
    destination: file ? 'file' : 'hash-only',
    ...result,
    elapsedMs,
    maxChunkBytes,
    maxHeartbeatGapMs,
    sha256: hash.digest('hex'),
    before,
    peak,
    peakExtra: Object.fromEntries(Object.keys(before).map((k) => [k, peak[k] - before[k]])),
    afterGC: memory(),
  });
}
if (exports[0].sha256 !== exports[1].sha256) throw Error('REPEAT_EXPORT_MISMATCH');
const result = {
  synthetic: true,
  runtime: process.version,
  platform: process.platform,
  count,
  acquisitionMs,
  baseline,
  resident,
  sessionRetained: Object.fromEntries(
    Object.keys(baseline).map((k) => [k, resident[k] - baseline[k]]),
  ),
  timings,
  exports,
  limitations:
    'Node synthetic geometry; not camera/inference/browser memory. RSS includes runtime and GC high-water effects; sampled peaks are lower bounds.',
};
await writeFile(join(output, `result-${count}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
