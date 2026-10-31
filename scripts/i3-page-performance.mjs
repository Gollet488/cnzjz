import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { runProductControls } from './i3-product-controls.mjs';

const output = process.argv[2];
const dist = process.argv.find((a) => a.startsWith('--dist='))?.slice(7) ?? 'dist';
const sourceBefore = process.argv.find((a) => a.startsWith('--source-before='))?.slice(16);
if (!output) throw new Error('unique output directory required');
await mkdir(output, { recursive: false });
const save = (name, data) => writeFile(`${output}/${name}`, JSON.stringify(data, null, 2));
const report = { at: new Date().toISOString(), samples: [], controls: [], errors: [] };
const fingerprints = {};
for (const path of [
  'src/App.vue',
  'src/components/TimeChart.vue',
  'src/components/PoseStage.vue',
  'src/utils/visualization.ts',
  'src/utils/csv.ts',
  'src/utils/csvExport.ts',
  'src/composables/useCSVExport.ts',
  'pnpm-lock.yaml',
]) {
  const beforeName = path.split('/').at(-1);
  const bytes = await readFile(
    sourceBefore &&
      ['App.vue', 'TimeChart.vue', 'PoseStage.vue', 'visualization.ts', 'useCSVExport.ts'].includes(
        beforeName,
      )
      ? `${sourceBefore}/${beforeName}`
      : path,
  );
  fingerprints[path] = createHash('sha256').update(bytes).digest('hex');
}
await save('conditions.json', {
  fingerprints,
  node: process.version,
  os: os.release(),
  cpu: os.cpus()[0].model,
  memory: os.totalmem(),
  viewport: [1440, 1000],
  synthetic: true,
  models: 'not invoked',
  backgroundLoad: null,
  thermalState: null,
  powerPlan: 'unchanged',
  clock: 'input RAF +50ms only during preparation; native before measurement',
  sink: 'real OPFS writable via picker adapter; no artificial latency; no native dialog claim',
});
const server = await preview({
  build: { outDir: dist },
  preview: { host: '127.0.0.1', port: 5193, strictPort: true },
});
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: false });
  report.browser = browser.version();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.addInitScript(() => {
    const nativeRAF = requestAnimationFrame.bind(window),
      nativeCancel = cancelAnimationFrame.bind(window);
    const channel = new MessageChannel(),
      callbacks = new Map();
    let next = 1,
      virtual = 1000,
      scheduled = false;
    window.requestAnimationFrame = (callback) => {
      const id = next++;
      callbacks.set(id, callback);
      if (!scheduled) {
        scheduled = true;
        channel.port2.postMessage(0);
      }
      return id;
    };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
    channel.port1.onmessage = () => {
      scheduled = false;
      const batch = [...callbacks.values()];
      callbacks.clear();
      virtual += 50;
      for (const cb of batch) cb(virtual);
    };
    window.restoreClock = () => {
      window.requestAnimationFrame = nativeRAF;
      window.cancelAnimationFrame = nativeCancel;
      for (const cb of callbacks.values()) nativeRAF(cb);
      callbacks.clear();
      channel.port1.close();
      channel.port2.close();
    };
    window.sinks = [];
    window.showSaveFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('i3-measure.csv', { create: true });
      return {
        createWritable: async () => {
          const stream = await handle.createWritable();
          const log = { opened: performance.now(), writes: [], state: 'writing', inFlight: 0 };
          window.sinks.push(log);
          return {
            async write(chunk) {
              const w = { start: performance.now(), bytes: chunk.byteLength, end: null };
              log.writes.push(w);
              log.inFlight++;
              try {
                await stream.write(chunk);
              } finally {
                w.end = performance.now();
                log.inFlight--;
              }
            },
            async close() {
              await stream.close();
              log.state = 'closed';
              log.stopped = performance.now();
            },
            async abort(reason) {
              try {
                await stream.abort(reason);
              } finally {
                log.state = 'aborted';
                log.stopped = performance.now();
              }
            },
          };
        },
      };
    };
  });
  await page.goto('http://127.0.0.1:5193/');
  if (process.argv.includes('--controls-only')) {
    const resume = process.argv.find((a) => a.startsWith('--resume-controls='))?.slice(18);
    if (resume) {
      const partial = JSON.parse(await readFile(resume, 'utf8'));
      report.controls = partial.controls.map((s) => ({ ...s, sourceEvidence: resume }));
      report.resumedFrom = { path: resume, status: partial.status, error: partial.error };
    }
    await runProductControls(page, report, save);
  } else {
    await page.getByText('已达到 18,000 帧上限', { exact: false }).waitFor({ timeout: 180000 });
    await page.evaluate(() => window.restoreClock());
    await page.locator('nav').getByRole('button', { name: '数据导出', exact: true }).click();
    await cdp.send('HeapProfiler.collectGarbage');
    report.memoryBefore = await cdp.send('Runtime.getHeapUsage');
    await page.evaluate(() => {
      window.perf = { longTasks: [], events: [], active: null, paintCounts: {} };
      const p = window.perf;
      for (const name of ['stroke', 'fill', 'fillText', 'drawImage', 'clearRect']) {
        const original = CanvasRenderingContext2D.prototype[name];
        CanvasRenderingContext2D.prototype[name] = function (...args) {
          const result = original.apply(this, args);
          const kind = this.canvas.closest?.('.time-chart')?.dataset.kind;
          if (kind) {
            p.paintCounts[kind] = (p.paintCounts[kind] || 0) + 1;
            if (p.active) {
              p.active.paints[kind] = performance.now();
              p.active.lastPaint = performance.now();
            }
          }
          return result;
        };
      }
      for (const type of ['click', 'wheel'])
        document.addEventListener(
          type,
          () => {
            if (!p.armed) return;
            const { kind, expected } = p.armed;
            p.armed = null;
            const sink = window.sinks.at(-1);
            const event = {
              kind,
              expected,
              at: performance.now(),
              paints: {},
              lastPaint: 0,
              ms: null,
              correct: false,
              foreground: document.visibilityState === 'visible',
              sinkState: sink?.state ?? 'none',
              writesAtEvent: sink?.writes.length ?? 0,
              inFlightAtEvent: sink?.inFlight ?? 0,
            };
            p.events.push(event);
            p.active = event;
            let quiet = 0;
            const finish = () => {
              if (expected.every((k) => event.paints[k] >= event.at)) {
                if (performance.now() - event.lastPaint >= 8) quiet++;
                else quiet = 0;
                if (quiet >= 2) {
                  event.ms = performance.now() - event.at;
                  event.correct = true;
                  p.active = null;
                  return;
                }
              }
              if (performance.now() - event.at > 3000) {
                event.reason = 'missing paint barrier';
                p.active = null;
                return;
              }
              requestAnimationFrame(finish);
            };
            requestAnimationFrame(finish);
          },
          { capture: true },
        );
      window.observer = new PerformanceObserver((list) =>
        p.longTasks.push(
          ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
        ),
      );
      window.observer.observe({ type: 'longtask' });
    });
    const nav = (name) => page.locator('nav').getByRole('button', { name, exact: true }).click();
    const startExport = async () => {
      await nav('数据导出');
      await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
      await page.waitForFunction(
        () => window.sinks.at(-1)?.state === 'writing' && window.sinks.at(-1).writes.length > 0,
      );
    };
    const stopExport = async () => {
      const cancel = page.getByRole('button', { name: '取消导出', exact: true });
      if (await cancel.isVisible()) await cancel.click();
      await page.waitForFunction(() => window.sinks.at(-1)?.state !== 'writing');
    };
    const measure = async (kind, expected, action) => {
      const n = report.samples.length;
      await page.evaluate(
        ({ kind, expected }) => {
          window.perf.armed = { kind, expected };
        },
        { kind, expected },
      );
      await action();
      await page.waitForFunction(() => !window.perf.armed && !window.perf.active);
      const sample = await page.evaluate(() => window.perf.events.at(-1));
      report.samples.push({ ...sample, index: n });
      await save('partial.json', report);
    };
    // Profile a separate representative cycle; it is not a measured performance sample.
    await cdp.send('Profiler.enable');
    report.profileStartBefore = await page.evaluate(() => performance.now());
    await cdp.send('Profiler.start');
    report.profileStartAfter = await page.evaluate(() => performance.now());
    await cdp.send('Performance.enable');
    const clockBefore = await page.evaluate(() => performance.now());
    const clockMetrics = await cdp.send('Performance.getMetrics');
    const clockAfter = await page.evaluate(() => performance.now());
    report.clockProbe = {
      before: clockBefore,
      after: clockAfter,
      timestampMs: clockMetrics.metrics.find((m) => m.name === 'Timestamp').value * 1000,
      note: 'CDP monotonic Timestamp bounded by page-clock reads, independent of Profiler.start latency',
    };
    await startExport();
    await measure('profile-view', ['angle', 'center', 'heatmap', 'trajectory', 'point'], () =>
      nav('时序可视化'),
    );
    await page.locator('.angle-panel .el-select').click();
    await measure('profile-joint', ['angle'], () =>
      page.getByRole('option', { name: '肘关节', exact: true }).click(),
    );
    const wheel = async (delta) => {
      const box = await page.locator('.angle-panel .echart').boundingBox();
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
      await page.mouse.wheel(0, delta);
    };
    await measure('profile-zoom', ['angle', 'center', 'heatmap', 'trajectory', 'point'], () =>
      wheel(-120),
    );
    report.profileEndBefore = await page.evaluate(() => performance.now());
    await save('cpu-profile.json', (await cdp.send('Profiler.stop')).profile);
    report.profileSamples = report.samples.splice(0);
    await stopExport();
    await page.evaluate(() => {
      window.perf.events = [];
      window.perf.longTasks = [];
      window.observer.takeRecords();
    });
    report.measureStart = await page.evaluate(() => performance.now());
    for (
      let batch = 0;
      batch <
      (process.argv.includes('--profile-only') ? 0 : process.argv.includes('--probe') ? 2 : 20);
      batch++
    ) {
      await startExport();
      await measure('view', ['angle', 'center', 'heatmap', 'trajectory', 'point'], () =>
        nav('时序可视化'),
      );
      for (const label of ['膝关节', '肘关节']) {
        await page.locator('.angle-panel .el-select').click();
        await measure('joint', ['angle'], () =>
          page.getByRole('option', { name: label, exact: true }).click(),
        );
      }
      await measure('zoom-in', ['angle', 'center', 'heatmap', 'trajectory', 'point'], () =>
        wheel(-120),
      );
      await measure('zoom-out', ['angle', 'center', 'heatmap', 'trajectory', 'point'], () =>
        wheel(120),
      );
      await stopExport();
      console.log(`batch ${batch + 1}/20`);
    }
    report.measureEnd = await page.evaluate(() => performance.now());
    report.longTasks = await page.evaluate(() => {
      window.perf.longTasks.push(
        ...window.observer.takeRecords().map((e) => ({ start: e.startTime, duration: e.duration })),
      );
      window.observer.disconnect();
      return window.perf.longTasks;
    });
    report.memoryAfter = await cdp.send('Runtime.getHeapUsage');
    report.otherMemory = {
      blob: null,
      wasm: null,
      graphics: null,
      processRSS: null,
      totalPeak: null,
      reason: 'CDP heap/backing storage are separate snapshots, not complete browser peaks',
    };
    await page.screenshot({ path: `${output}/analysis.png`, fullPage: true });
    if (!process.argv.includes('--profile-only')) {
      // Save the actual product's entire CSV, independently of display aggregation.
      await startExport();
      await page.waitForFunction(() => window.sinks.at(-1)?.state === 'closed');
      const waiting = page.waitForEvent('download');
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('i3-measure.csv');
        const file = await handle.getFile();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = 'session.csv';
        a.click();
      });
      await (await waiting).saveAs(`${output}/session.csv`);
      report.material = {
        path: `${output}/session.csv`,
        sha256: createHash('sha256')
          .update(await readFile(`${output}/session.csv`))
          .digest('hex'),
        frames: 18000,
        columns: 354,
        synthetic: true,
      };
      await save('interaction-sinks.json', await page.evaluate(() => window.sinks));
    }
    if (process.argv.includes('--controls')) {
      await runProductControls(page, report, save);
    }
    // Baseline and after retain exactly the same interaction procedure.
    report.summary = {
      count: report.samples.length,
      missing: report.samples.filter((s) => s.ms === null).length,
      p95: report.samples.every((s) => s.ms !== null)
        ? report.samples.map((s) => s.ms).sort((a, b) => a - b)[94]
        : null,
      longTasks: report.longTasks.length,
    };
  }
  report.status = 'measured';
} catch (e) {
  report.status = 'failed';
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await save('result.json', report);
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
