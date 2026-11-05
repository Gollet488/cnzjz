// Exercise the ordinary page's actual export path. The adapter only selects an
// OPFS file; it records calls to the real writable, with no fake sink/delay.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

// Playwright may capture the preparation RAF in its injected builtins. Poll
// conditions with a native timer, including after restoreClock closes that RAF.
function waitFor(page, callback, arg = null, options = {}) {
  return page.waitForFunction(callback, arg, { ...options, polling: 25 });
}

// Reuses the production page and the same real OPFS adapter as the I3 run.
// Synthetic preparation is excluded from every native-clock measurement.
export async function runWebLoad(page, cdp, report, save, { output, frames, modalities }) {
  const nav = (name) =>
    page
      .locator('nav')
      .getByRole('button', { name, exact: name !== '采集与分析' })
      .click();
  report.load = { frames, memory: [], exports: [], actions: [], controls: [], phases: [] };
  report.storagePreflight = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      return { opfs: true, kind: root.kind, adapter: window.showSaveFilePicker.toString() };
    } catch (error) {
      return { opfs: false, error: String(error) };
    }
  });
  const load = report.load;
  const memory = async (stage, gc = false) => {
    if (gc) await cdp.send('HeapProfiler.collectGarbage');
    const sample = {
      stage,
      gc,
      at: await page.evaluate(() => performance.now()),
      ...(await cdp.send('Runtime.getHeapUsage')),
    };
    load.memory.push(sample);
    return sample;
  };
  await page.evaluate(() => {
    const q = (window.webLoad = {
      longTasks: [],
      clicks: [],
      paints: {},
      phase: 'idle',
      last: performance.now(),
      gaps: [],
    });
    q.observer = new PerformanceObserver((list) =>
      q.longTasks.push(
        ...list
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration, phase: q.phase })),
      ),
    );
    q.observer.observe({ type: 'longtask' });
    q.timer = setInterval(() => {
      const now = performance.now();
      q.gaps.push({ at: now, delay: Math.max(0, now - q.last - 50), phase: q.phase });
      q.last = now;
    }, 50);
    document.addEventListener(
      'click',
      (event) => {
        const at = performance.now();
        const record = {
          at,
          inputDelayMs: at - event.timeStamp,
          phase: q.phase,
          foreground: document.visibilityState === 'visible',
          nextRAFMs: null,
        };
        q.clicks.push(record);
        requestAnimationFrame(() => (record.nextRAFMs = performance.now() - at));
      },
      { capture: true },
    );
    for (const name of ['stroke', 'fill', 'fillText', 'drawImage', 'clearRect']) {
      const original = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (...args) {
        const result = original.apply(this, args);
        const kind = this.canvas.closest?.('.time-chart')?.dataset.kind;
        if (kind) q.paints[kind] = performance.now();
        return result;
      };
    }
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL);
    q.urls = [];
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      q.urls.push({ url, bytes: blob.size, at: performance.now(), revoked: null });
      return url;
    };
    URL.revokeObjectURL = (url) => {
      const entry = q.urls.find((e) => e.url === url);
      if (entry) entry.revoked = performance.now();
      return revoke(url);
    };
  });
  const phase = async (name) => {
    await page.evaluate((name) => {
      window.webLoad.observer.takeRecords().forEach((e) =>
        window.webLoad.longTasks.push({
          start: e.startTime,
          duration: e.duration,
          phase: window.webLoad.phase,
        }),
      );
      window.webLoad.phase = name;
    }, name);
    load.phases.push({ name, at: await page.evaluate(() => performance.now()) });
  };
  const action = async (kind, callback, expected = []) => {
    await phase(kind);
    const at = await page.evaluate(() => performance.now());
    await callback();
    if (expected.length)
      await waitFor(
        page,
        ({ at, expected }) => expected.every((k) => window.webLoad.paints[k] >= at),
        { at, expected },
      );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const end = await page.evaluate(() => ({
      at: performance.now(),
      click: window.webLoad.clicks.at(-1),
      paints: { ...window.webLoad.paints },
    }));
    load.actions.push({ kind, start: at, automationAndBarrierMs: end.at - at, ...end });
  };
  await memory('session-retained', true);
  await action('charts-first', () => nav('时序可视化'), [
    'angle',
    'center',
    'heatmap',
    'trajectory',
    'point',
  ]);
  await memory('charts-retained', true);
  if (!process.argv.includes('--release-only')) {
    const streamExport = async (name, cancelKind) => {
      await nav('数据导出');
      await phase(name);
      const start = await page.evaluate(() => performance.now());
      let polling = false;
      const timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          await memory(name);
        } finally {
          polling = false;
        }
      }, 100);
      try {
        await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
        await waitFor(page, () => window.sinks.at(-1)?.writes.length > 0);
        if (cancelKind) {
          if (cancelKind !== 'cancel') await nav('采集与分析');
          await page.evaluate(() =>
            document.addEventListener('click', () => (window.cancelAt = performance.now()), {
              once: true,
              capture: true,
            }),
          );
          await page
            .getByRole('button', {
              name: cancelKind === 'cancel' ? '取消导出' : '重置会话',
              exact: true,
            })
            .click();
          await waitFor(page, () => window.sinks.at(-1).state !== 'writing');
          await page.waitForTimeout(300);
          const sample = await page.evaluate(() => {
            const sink = window.sinks.at(-1);
            return {
              kind: sink.state,
              at: window.cancelAt,
              stopped: sink.stopped,
              stopMs: sink.stopped - window.cancelAt,
              lateWrites: sink.writes.filter((w) => w.start > window.cancelAt).length,
              completionsAfterStop: sink.writes.filter((w) => w.end > sink.stopped).length,
            };
          });
          assert.equal(sample.kind, 'aborted');
          assert.equal(sample.lateWrites, 0);
          assert.equal(sample.completionsAfterStop, 0);
          load.controls.push({ name, ...sample });
        } else {
          await action(`${name}-view`, () => nav('时序可视化'), [
            'angle',
            'center',
            'heatmap',
            'trajectory',
            'point',
          ]);
          await page.locator('.angle-panel .el-select').click();
          const label = (await page.locator('.angle-panel .el-select').textContent()).includes(
            '肘关节',
          )
            ? '膝关节'
            : '肘关节';
          await action(
            `${name}-joint`,
            () => page.getByRole('option', { name: label, exact: true }).click(),
            ['angle'],
          );
          await waitFor(page, () => window.sinks.at(-1).state === 'closed');
          const end = await page.evaluate(() => performance.now());
          const waiting = page.waitForEvent('download');
          await page.evaluate(async () => {
            const root = await navigator.storage.getDirectory();
            const file = await (await root.getFileHandle('i3-measure.csv')).getFile();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(file);
            a.download = 'session.csv';
            a.click();
            URL.revokeObjectURL(a.href);
          });
          const path = `${output}/${name}.csv`;
          await (await waiting).saveAs(path);
          const bytes = await readFile(path);
          load.exports.push({
            name,
            mode: 'OPFS-picker-adapter',
            path,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            elapsedMs: end - start,
            sink: await page.evaluate(() => {
              const s = window.sinks.at(-1);
              return {
                elapsedMs: s.stopped - s.opened,
                writes: s.writes.length,
                maxInFlight: s.writes.some((w, i) => i && w.start < s.writes[i - 1].end) ? '>1' : 1,
              };
            }),
          });
        }
      } finally {
        clearInterval(timer);
        while (polling) await new Promise((r) => setTimeout(r, 10));
      }
      await memory(`${name}-settled`, true);
      await save('partial.json', report);
    };
    await streamExport('stream-first');
    await streamExport('stream-repeat');
    assert.equal(load.exports[0].sha256, load.exports[1].sha256);
    if (frames === 18000) await streamExport('stream-cancel', 'cancel');
    else
      load.controls.push({
        name: 'stream-cancel',
        status: 'not-run',
        reason:
          '202-frame export can complete before an automation click; cancellation measured at 18000 frames, no artificial sink delay',
      });
    await nav('数据导出');
    await page.evaluate(() => {
      window.showSaveFilePicker = undefined;
    });
    await phase('blob-export');
    const waiting = page.waitForEvent('download');
    const blobStart = await page.evaluate(() => performance.now());
    let blobPolling = false;
    const timer = setInterval(async () => {
      if (blobPolling) return;
      blobPolling = true;
      try {
        await memory('blob-export');
      } finally {
        blobPolling = false;
      }
    }, 100);
    try {
      await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
      const download = await waiting;
      const end = await page.evaluate(() => performance.now());
      const path = `${output}/blob.csv`;
      await download.saveAs(path);
      const bytes = await readFile(path);
      load.exports.push({
        name: 'blob',
        mode: 'blob-download',
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        elapsedMs: end - blobStart,
      });
      assert.equal(load.exports[0].sha256, load.exports.at(-1).sha256);
    } finally {
      clearInterval(timer);
      while (blobPolling) await new Promise((r) => setTimeout(r, 10));
    }
    await page.waitForTimeout(1200);
    await memory('blob-revoked', true);
    load.nativeMeasurements = await page.evaluate(() => {
      const q = window.webLoad;
      q.longTasks.push(
        ...q.observer
          .takeRecords()
          .map((e) => ({ start: e.startTime, duration: e.duration, phase: q.phase })),
      );
      q.observer.disconnect();
      clearInterval(q.timer);
      return {
        longTasks: q.longTasks,
        clicks: q.clicks,
        timerGaps: q.gaps,
        urls: q.urls,
        sinks: window.sinks,
      };
    });
    await save('partial.json', report);
    await save('exports.json', load.exports);
  }
  // Keep reset/reveal on this document. A navigation can leave an old execution
  // context retained by browser instrumentation and is not a session reset.
  await nav('时序可视化');
  await page.waitForTimeout(500);
  await memory('release-session-charts', true);
  await nav('采集与分析');
  await page.getByRole('button', { name: '重置会话', exact: true }).click();
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  await memory('reset-while-charts-hidden', true);
  if (process.argv.includes('--heap-snapshot')) {
    const file = createWriteStream(`${output}/hidden-reset.heapsnapshot`);
    const chunk = ({ chunk }) => file.write(chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', chunk);
    try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      cdp.off('HeapProfiler.addHeapSnapshotChunk', chunk);
      file.end();
      await once(file, 'finish');
    }
  }
  await nav('时序可视化');
  await page.waitForTimeout(500);
  await memory('reset-charts-revealed', true);
  await page.screenshot({ path: `${output}/reset-charts.png`, fullPage: true });
  for (let cycle = 0; cycle < 3; cycle++) {
    await nav('采集与分析');
    await page.getByRole('button', { name: '上传视频', exact: true }).click();
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    await page.getByRole('button', { name: '暂停分析', exact: true }).click();
    await page.getByRole('button', { name: '重置会话', exact: true }).click();
    await page.getByRole('button', { name: '暂停分析', exact: true }).click();
    await memory(`repeat-small-session-reset-${cycle}`, true);
  }
  if (modalities) load.modalities = await measureModalities(page, cdp, memory, output);
  load.memoryScope =
    'Main-page V8 heap/backing storage snapshots; forced-GC release diagnostic. 100 ms export samples are peak lower bounds, exclude worker WASM/GPU/Blob disk/browser process memory.';
  await save('partial.json', report);
}

async function measureModalities(page, cdp, memory, output) {
  const { parseCSV, replayFullCSV } = await import('../tests/browser/files.ts');
  const nav = (name) =>
    page
      .locator('nav')
      .getByRole('button', { name, exact: name !== '采集与分析' })
      .click();
  const result = {
    offline: [],
    comparison: [],
    camera: 'not collected; no new conditions; C1/C2 suspended',
  };
  await page.evaluate(() => {
    const q = (window.modalityLoad = { phase: '', longTasks: [], clicks: [] });
    q.observer = new PerformanceObserver((list) =>
      q.longTasks.push(
        ...list
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration, phase: q.phase })),
      ),
    );
    q.observer.observe({ type: 'longtask' });
    document.addEventListener(
      'click',
      (e) => {
        const sample = {
          phase: q.phase,
          at: performance.now(),
          inputDelayMs: performance.now() - e.timeStamp,
        };
        q.clicks.push(sample);
        requestAnimationFrame(() => (sample.nextRAFMs = performance.now() - sample.at));
      },
      { capture: true },
    );
  });
  const downloadCSV = async (name) => {
    await nav('数据导出');
    await page.evaluate(() => {
      window.showSaveFilePicker = undefined;
    });
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
    const path = `${output}/${name}.csv`;
    await (await waiting).saveAs(path);
    return { path, rows: parseCSV(await readFile(path)) };
  };
  await nav('采集与分析');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('checkbox', { name: /生成\/合成视频素材/ }).check();
  for (const fixture of ['30fps', '60fps', 'vfr']) {
    await page.evaluate((fixture) => (window.modalityLoad.phase = `offline-${fixture}`), fixture);
    const path = `tests/fixtures/${fixture}.mp4`;
    await page.locator('.pose-stage input[type=file]').setInputFiles(path);
    await waitFor(page, () =>
      /文件已选择/.test(document.querySelector('.status-message')?.textContent),
    );
    await memory(`offline-${fixture}-ready`, true);
    const start = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    if (fixture === '60fps') {
      await waitFor(
        page,
        () => Number(document.querySelector('.offline-progress progress').value) > 0,
      );
      await page.evaluate(() =>
        document.addEventListener('click', () => (window.offlineCancelAt = performance.now()), {
          once: true,
          capture: true,
        }),
      );
      await page.getByRole('button', { name: '取消解码', exact: true }).click();
      await waitFor(page, () =>
        document.querySelector('.offline-progress')?.textContent.includes('已取消'),
      );
      const cancelled = await page.evaluate(() => ({
        at: window.offlineCancelAt,
        settled: performance.now(),
        count: document.querySelector('.offline-progress progress').value,
      }));
      await page.waitForTimeout(300);
      assert.equal(
        await page.locator('.offline-progress progress').getAttribute('value'),
        String(cancelled.count),
      );
      const prefix = await downloadCSV('offline-cancelled');
      result.offline.push({ fixture, cancelled, prefix: replayFullCSV(prefix.rows) });
      await nav('采集与分析');
      await page.getByRole('button', { name: '重新逐帧分析', exact: true }).click();
    }
    await waitFor(
      page,
      () => document.querySelector('.offline-progress')?.textContent.includes('全部完成'),
      null,
      { timeout: 60000 },
    );
    const elapsedMs = await page.evaluate((start) => performance.now() - start, start);
    await memory(`offline-${fixture}-complete`, true);
    const csv = await downloadCSV(`offline-${fixture}`);
    const oracle = JSON.parse(await readFile(`tests/fixtures/${fixture}.json`, 'utf8'));
    assert.equal(csv.rows.length, oracle.count);
    csv.rows.forEach((r, i) => assert.ok(Math.abs(Number(r.time_s) - oracle.ptsSeconds[i]) < 1e-6));
    result.offline.push({
      fixture,
      path,
      inputSha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      syntheticPixels: true,
      realLocalMediaPipe: true,
      elapsedMs,
      includesCancelRestart: fixture === '60fps',
      csv: csv.path,
      replay: replayFullCSV(csv.rows),
      ptsOracle: `${fixture}.json`,
    });
    await nav('采集与分析');
  }
  await nav('姿态对比');
  const panel = page.locator('.comparison-panel');
  const inputs = panel.locator('input[type=file]');
  await inputs.nth(0).setInputFiles('tests/fixtures/30fps.mp4');
  await inputs.nth(1).setInputFiles('tests/fixtures/rotate.mp4');
  await waitFor(page, () =>
    [...document.querySelectorAll('.comparison-panel video')].every((v) => v.readyState >= 2),
  );
  await memory('dual-video-loaded', true);
  for (let run = 0; run < 3; run++) {
    await page.evaluate((run) => (window.modalityLoad.phase = `dual-video-${run}`), run);
    const start = await page.evaluate(() => performance.now());
    await panel.getByRole('button', { name: '从头同步分析', exact: true }).click();
    await waitFor(page, () =>
      [...document.querySelectorAll('.comparison-panel video')].some((v) => v.ended),
    );
    await page.waitForTimeout(150);
    result.comparison.push({
      run,
      wallMs: await page.evaluate((start) => performance.now() - start, start),
      videos: await panel.locator('video').evaluateAll((vs) =>
        vs.map((v) => ({
          width: v.videoWidth,
          height: v.videoHeight,
          duration: v.duration,
          currentTime: v.currentTime,
          paused: v.paused,
          ended: v.ended,
          playbackRate: v.playbackRate,
        })),
      ),
      display: await panel.locator('.compare-controls').textContent(),
    });
    await memory(`dual-video-${run}-settled`, true);
  }
  await nav('数据导出');
  await memory('dual-video-unmounted', true);
  result.measurements = await page.evaluate(() => {
    const q = window.modalityLoad;
    q.longTasks.push(
      ...q.observer
        .takeRecords()
        .map((e) => ({ start: e.startTime, duration: e.duration, phase: q.phase })),
    );
    q.observer.disconnect();
    return { longTasks: q.longTasks, clicks: q.clicks };
  });
  result.workerTargetsAfter = (await cdp.send('Target.getTargets')).targetInfos
    .filter((t) => t.type.includes('worker'))
    .map((t) => ({ type: t.type, url: t.url }));
  result.scope =
    'Fixed 64x48 generated test pixels (rotation changes display dimensions); real local inference. Short desktop diagnostics, no human accuracy, camera, real-time FPS or phone capacity inference. 60fps elapsed includes cancellation/restart.';
  return result;
}

export async function runProductControls(page, report, save) {
  const nav = (name) =>
    page
      .locator('nav')
      .getByRole('button', { name, exact: name !== '采集与分析' })
      .click();
  for (let i = report.controls.length; i < 20; i++) {
    await page.reload();
    await page.getByText('已达到 18,000 帧上限', { exact: false }).waitFor({ timeout: 180000 });
    await page.evaluate(() => window.restoreClock());
    const kind = ['cancel', 'reset', 'source'][i % 3];
    await nav('数据导出');
    await page.getByRole('button', { name: '下载 CSV 数据', exact: true }).click();
    await waitFor(
      page,
      () => window.sinks.at(-1)?.state === 'writing' && window.sinks.at(-1).writes.length > 0,
    );
    if (kind !== 'cancel') await nav('采集与分析');
    await page.evaluate(() => {
      window.control = null;
      document.addEventListener(
        'click',
        () => {
          const sink = window.sinks.at(-1);
          window.control = {
            at: performance.now(),
            foreground: document.visibilityState === 'visible',
            sinkState: sink.state,
            writesAtEvent: sink.writes.length,
            inFlightAtEvent: sink.inFlight,
          };
        },
        { capture: true, once: true },
      );
    });
    await page
      .getByRole('button', {
        name: { cancel: '取消导出', reset: '重置会话', source: '上传视频' }[kind],
        exact: true,
      })
      .click();
    await waitFor(page, () => window.sinks.at(-1)?.state !== 'writing');
    // Keep observing real write invocations after cancellation has settled.
    await page.waitForTimeout(1000);
    const measured = await page.evaluate(() => {
      const sink = window.sinks.at(-1),
        event = window.control;
      const lateWrites = sink.writes.filter((w) => w.start > event.at);
      const completionsAfterEvent = sink.writes.filter((w) => w.end > event.at);
      const completionsAfterStop = sink.writes.filter((w) => w.end > sink.stopped);
      return {
        ...event,
        stopped: sink.stopped,
        state: sink.state,
        stopWritingMs: sink.stopped - event.at,
        lateWrites: lateWrites.length,
        completionsAfterEvent: completionsAfterEvent.length,
        completionsAfterStop: completionsAfterStop.length,
        observedUntil: performance.now(),
        writes: sink.writes,
      };
    });
    measured.kind = kind;
    measured.index = i;
    measured.correct =
      measured.sinkState === 'writing' &&
      measured.state === 'aborted' &&
      measured.lateWrites === 0 &&
      measured.completionsAfterStop === 0 &&
      measured.foreground;
    report.controls.push(measured);
    await save('controls-partial.json', report.controls);
    console.log(
      `product control ${i + 1}/20 ${kind}: ${measured.stopWritingMs.toFixed(1)}ms, late writes ${measured.lateWrites}`,
    );
  }
}
