import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readMP4 } from '../../src/video/mp4.ts';
import { resolve } from 'node:path';
import { trackPagesAssets } from './pages-assets.ts';
import { JOINTS } from '../../src/config.ts';
import { goals, scriptedOllama } from './scripted-ollama.ts';
import {
  FIXED_ROM_FINGERPRINT,
  fixedRomSession,
  romCard,
  setAbsolute,
} from './rom-card-helpers.ts';
import type { RunAudit } from '../../src/agent/audit.ts';
import {
  downloadFile,
  fullCSV,
  parseCSV,
  replayCSV,
  replayFullCSV,
  rom,
  verifyAudit,
} from './files.ts';

test('authorized human video: complete source PTS, lifecycle, full CSV and browser measurements', async ({
  page,
}, info) => {
  test.skip(!process.env.HUMAN_VIDEO_PATH, 'Requires an explicitly authorized human video path');
  test.setTimeout(240_000);
  const path = process.env.HUMAN_VIDEO_PATH!;
  const bytes = await readFile(path);
  const source = await readMP4(new Blob([bytes]));
  const observations: any = {
    input: { path, sha256: createHash('sha256').update(bytes).digest('hex'), humanInput: true },
    expectedFrames: source.presentation.length,
    aspect: source.aspect,
    mediaTimeOffset: source.mediaTimeOffset,
    browser: page.context().browser()!.version(),
    entry: await page.locator('script[type=module]').first().getAttribute('src'),
    productHashes: Object.fromEntries(
      await Promise.all(
        ['src/App.vue', 'src/components/PoseStage.vue', 'src/utils/export.ts'].map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ]),
      ),
    ),
    memory: [],
    errors: [],
    nativeSave: 'not tested; Blob downloads only',
    memoryScope:
      'CDP main-page heap/backing and Windows Chrome process working-set/private-byte snapshots; sums can double-count shared pages and are not peaks',
  };
  const cdp = await page.context().newCDPSession(page);
  const browserCDP = await page.context().browser()!.newBrowserCDPSession();
  const memory = async (stage: string) => {
    const processes = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo;
    const windowsMemory =
      process.platform === 'win32'
        ? JSON.parse(
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                `$taskProcessIds=@(${processes.map((p) => p.id).join(',')}); @($taskProcessIds | ForEach-Object { try { $taskChrome=[System.Diagnostics.Process]::GetProcessById($_); [pscustomobject]@{id=$_; workingSetBytes=$taskChrome.WorkingSet64; privateBytes=$taskChrome.PrivateMemorySize64} } catch {} }) | ConvertTo-Json -Compress`,
              ],
              { encoding: 'utf8', windowsHide: true },
            ),
          )
        : null;
    observations.memory.push({
      stage,
      ...(await cdp.send('Runtime.getHeapUsage')),
      processes,
      windowsMemory,
    });
  };
  const save = () =>
    writeFile(info.outputPath('human-verification.json'), JSON.stringify(observations, null, 2));
  await save();
  page.on('pageerror', (error) => observations.errors.push(error.message));
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.locator('.pose-stage input[type=file]').setInputFiles(path);
  await page.evaluate(() => {
    const q = ((window as any).inputQA = {
      longTasks: [],
      delays: [],
      clicks: [],
      last: performance.now(),
    });
    q.observer = new PerformanceObserver((list) =>
      q.longTasks.push(
        ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
      ),
    );
    q.observer.observe({ type: 'longtask' });
    q.timer = setInterval(() => {
      const now = performance.now();
      q.delays.push(Math.max(0, now - q.last - 50));
      q.last = now;
    }, 50);
    document.addEventListener(
      'click',
      (event) => {
        const at = performance.now();
        requestAnimationFrame(() =>
          q.clicks.push({
            target: (event.target as HTMLElement).textContent?.slice(0, 50),
            eventDelay: at - event.timeStamp,
            nextAnimationFrameMs: performance.now() - at,
          }),
        );
      },
      { capture: true },
    );
  });
  await memory('before');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress progress')).toHaveAttribute('value', /[1-9]\d*/);
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const count = Number(await page.locator('.offline-progress progress').getAttribute('value'));
  await page.waitForTimeout(350);
  expect(Number(await page.locator('.offline-progress progress').getAttribute('value'))).toBe(
    count,
  );
  await memory('paused');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect
    .poll(async () =>
      Number(await page.locator('.offline-progress progress').getAttribute('value')),
    )
    .toBeGreaterThan(count);
  await page.getByRole('button', { name: '取消解码', exact: true }).click();
  const prefix = await fullCSV(page, info, 'human-cancelled-prefix.csv');
  expect(prefix[0].acquisition_status).toBe('cancelled');
  observations.prefix = replayFullCSV(prefix);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '重新逐帧分析', exact: true }).click();
  const start = performance.now();
  await expect(page.locator('.offline-progress')).toContainText('全部完成', { timeout: 160_000 });
  observations.decodeWallMs = performance.now() - start;
  await memory('completed');
  await save();
  const rows = await fullCSV(page, info, 'human-complete.csv');
  expect(rows).toHaveLength(source.presentation.length);
  rows.forEach((r, i) => {
    expect(Number(r.time_s)).toBe(source.presentation[i].timestamp / 1e6);
    expect(Number(r.source_aspect)).toBe(source.aspect);
    expect(Number(r.media_time_offset_s)).toBe(source.mediaTimeOffset);
    expect(r.synthetic).toBe('false');
    expect(r.acquisition_status).toBe('completed');
    expect(Number(r.source_expected_frames)).toBe(rows.length);
    expect(Number(r.source_processed_frames)).toBe(rows.length);
  });
  observations.fullCSV = replayFullCSV(rows);
  await save();
  observations.detected = rows.filter((r) => r.raw_nose_x !== '').length;
  expect(observations.detected).toBeGreaterThan(0);
  // Independent geometry: atan2(cross,dot), not poseMath's acos formula.
  let checked = 0,
    maxAngleDifference = 0;
  for (const row of rows)
    for (const basis of ['raw', 'filtered']) {
      const names = ['left_hip', 'left_knee', 'left_ankle'];
      if (
        names.some(
          (n) =>
            row[`${basis}_${n}_x`] === '' ||
            Number(row[`${basis}_${n}_visibility`]) < Number(row.confidence_threshold),
        )
      )
        continue;
      const [a, b, c] = names.map((n) => [
        Number(row[`${basis}_${n}_x`]) * source.aspect,
        Number(row[`${basis}_${n}_y`]),
      ]);
      const u = [a[0] - b[0], a[1] - b[1]],
        v = [c[0] - b[0], c[1] - b[1]];
      if (Math.hypot(...u) * Math.hypot(...v) < 1e-10) continue;
      const angle =
        (Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]) * 180) /
        Math.PI;
      const difference = Math.abs(angle - Number(row[`${basis}_knee_left_deg`]));
      expect(difference).toBeLessThan(1e-7);
      checked++;
      maxAngleDifference = Math.max(maxAngleDifference, difference);
    }
  expect(checked).toBeGreaterThan(0);
  observations.independentGeometry = {
    checked,
    maxAngleDifference,
    unit: 'deg',
    limitation: '2D projection consistency, not anatomical accuracy or ground truth',
  };
  await writeFile(
    info.outputPath('human-raw-material.json.gz'),
    gzipSync(
      JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(
            Object.entries(r).filter(
              ([k]) =>
                k.startsWith('raw_') ||
                [
                  'time_s',
                  'source_aspect',
                  'confidence_threshold',
                  'filter_window_frames',
                ].includes(k),
            ),
          ),
        ),
      ),
    ),
  );
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '重算指标', exact: true }).click();
  const recalculated = await fullCSV(page, info, 'human-recalculated.csv');
  expect(Number(recalculated[0].session_revision)).toBe(Number(rows[0].session_revision) + 1);
  expect(recalculated.map(({ session_revision: _revision, ...r }) => r)).toEqual(
    rows.map(({ session_revision: _revision, ...r }) => r),
  );
  observations.recalculatedCSV = replayFullCSV(recalculated);
  await page.locator('nav').getByRole('button', { name: '时序可视化' }).click();
  await expect(page.locator('.angle-panel canvas').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('human-charts.png'), fullPage: true });
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('slider', { name: '历史帧时间轴' }).press('Home');
  await expect
    .poll(() =>
      page
        .locator('.pose-stage video')
        .evaluate((v: HTMLVideoElement) => !v.seeking && v.currentTime === 0),
    )
    .toBe(true);
  observations.firstTimeReviewed = 0;
  const runway = page.locator('.timeline-row .el-slider__runway');
  const box = await runway.boundingBox();
  await runway.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect
    .poll(() =>
      page
        .locator('.pose-stage video')
        .evaluate((v: HTMLVideoElement) => !v.seeking && v.currentTime > 1),
    )
    .toBe(true);
  observations.reviewedTime = await page
    .locator('.pose-stage video')
    .evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  const png = await downloadFile(
    page,
    info,
    page.getByRole('button', { name: '下载图片报告', exact: true }),
    'human-report.png',
  );
  expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
  observations.pngPixels = await page.evaluate(async (base64) => {
    const blob = await (await fetch('data:image/png;base64,' + base64)).blob();
    const image = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 100;
    c.height = 100;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(image, 60, 155, 1320, image.height - 615, 0, 0, 100, 100);
    const values = ctx.getImageData(0, 0, 100, 100).data;
    let nonBlack = 0;
    for (let i = 0; i < values.length; i += 4)
      if (values[i] + values[i + 1] + values[i + 2] > 30) nonBlack++;
    image.close();
    return { nonBlack, total: 10000 };
  }, png.bytes.toString('base64'));
  expect(observations.pngPixels.nonBlack).toBeGreaterThan(1000);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/30fps.mp4'));
  await page.locator('nav').getByRole('button', { name: '时序可视化' }).click();
  await expect(page.locator('.time-chart .chart-empty:visible')).toHaveCount(5);
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await expect(page.getByRole('button', { name: '下载 CSV 数据', exact: true })).toBeDisabled();
  await memory('source-replaced');
  observations.responsiveness = await page.evaluate(() => {
    const q = (window as any).inputQA;
    clearInterval(q.timer);
    q.observer.disconnect();
    return { delays: q.delays, clicks: q.clicks, longTasks: q.longTasks };
  });
  observations.sourceReplacementInvalidated = true;
  observations.passed = true;
  await save();
  expect(observations.errors).toEqual([]);
});

test.beforeEach(async ({ page }) => {
  // Explicitly exercise Blob downloads. Native picker is a separate device test.
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }),
  );
  await page.goto('./');
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
});

for (const fixture of [
  'format.mkv',
  'format.mov',
  'format.avi',
  'format.webm',
  'format.flv',
  'format.wmv',
  'format.m2ts',
  'format-hevc.mp4',
  'format-vfr.mkv',
  'fragmented.mp4',
]) {
  test(`video formats: ${fixture} imports and completes real frame analysis${fixture === 'format.avi' ? ' @pages' : ''}`, async ({
    page,
  }, info) => {
    const checkAssets = trackPagesAssets(page, info);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: '上传视频', exact: true }).click();
    await page.getByRole('checkbox', { name: '生成/合成视频素材（synthetic）' }).check();
    await page
      .locator('.pose-stage input[type=file]')
      .setInputFiles(resolve(`tests/fixtures/${fixture}`));
    await expect(page.locator('.status-message')).toContainText(/文件已选择|视频已在本机转换/, {
      timeout: 60_000,
    });
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(page.locator('.offline-progress')).toContainText('全部完成', { timeout: 60_000 });
    const rows = await fullCSV(page, info, `${fixture}.csv`);
    expect(rows.length).toBe(30);
    expect(rows[0].acquisition_mode).toBe(
      fixture === 'format.mov' ? 'webcodecs' : 'webcodecs-transcoded',
    );
    expect(rows.at(-1)!.acquisition_status).toBe('completed');
    expect(
      rows.every(
        (row, index) => index === 0 || Number(row.time_s) > Number(rows[index - 1].time_s),
      ),
    ).toBe(true);
    if (fixture === 'format-vfr.mkv') {
      const gaps = rows
        .slice(1)
        .map((row, index) => Number(row.time_s) - Number(rows[index].time_s));
      expect(Math.max(...gaps) / Math.min(...gaps)).toBeGreaterThan(1.8);
    }
    expect(errors).toEqual([]);
    await checkAssets(/\/ffmpeg\/worker\.js$/, /\/ffmpeg\/ffmpeg-core\.wasm$/);
  });
}

test('video formats: comparison accepts two converted formats and plays both @pages', async ({
  page,
}, info) => {
  const checkAssets = trackPagesAssets(page, info);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('nav').getByRole('button', { name: '姿态对比', exact: true }).click();
  const inputs = page.locator('.comparison-panel input[type=file]');
  await inputs.nth(0).setInputFiles(resolve('tests/fixtures/format.avi'));
  await inputs.nth(1).setInputFiles(resolve('tests/fixtures/format.webm'));
  await expect(page.locator('.comparison-panel [role=status]')).toHaveText(
    ['已在本机转换，使用转换后时间轴。', '已在本机转换，使用转换后时间轴。'],
    { timeout: 60_000 },
  );
  const videos = page.locator('.comparison-panel video');
  await expect(videos.nth(0)).toHaveJSProperty('videoWidth', 64);
  await expect(videos.nth(1)).toHaveJSProperty('videoWidth', 64);
  await page.getByRole('button', { name: '开始对比', exact: true }).click();
  await expect
    .poll(() => videos.nth(0).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.1);
  await expect
    .poll(() => videos.nth(1).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
  await checkAssets(/\/mediapipe\/wasm\/[^/]+\.wasm$/, /\/mediapipe\/pose_landmarker_lite\.task$/);
});

test('comparison lifecycle: settings pause/reset real preview and source replacement clears it', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('nav').getByRole('button', { name: '姿态对比', exact: true }).click();
  const panel = page.locator('.comparison-panel');
  const inputs = panel.locator('input[type=file]');
  await inputs.nth(0).setInputFiles(resolve('tests/fixtures/30fps.mp4'));
  await inputs.nth(1).setInputFiles(resolve('tests/fixtures/rotate.mp4'));
  await expect(panel.locator('.compare-title span')).toHaveText(['30fps.mp4', 'rotate.mp4']);
  const videos = panel.locator('video');
  await expect
    .poll(() => videos.evaluateAll((vs: HTMLVideoElement[]) => vs.every((v) => v.readyState >= 2)))
    .toBe(true);
  await videos.evaluateAll((vs: HTMLVideoElement[]) =>
    vs.forEach((v) => {
      v.playbackRate = 0.1;
    }),
  );
  const start = () => page.getByRole('button', { name: '开始对比', exact: true }).click();
  const playhead = panel.locator('.compare-playhead');
  const alignment = panel.getByRole('slider', { name: '待测视频对齐起点' });
  await expect
    .poll(() =>
      panel.locator('canvas').evaluateAll((canvases: HTMLCanvasElement[]) =>
        canvases.every((canvas) =>
          canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, index) => index % 4 !== 3 && value > 150),
        ),
      ),
    )
    .toBe(true);
  await alignment.fill('0.4');
  await expect(alignment).toHaveAttribute('aria-valuetext', '0.40 秒');
  await expect
    .poll(() => videos.nth(1).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeCloseTo(0.4, 2);
  await expect(panel).toContainText('可对比 0.60 s');
  await start();
  await expect(playhead).toContainText('对齐后');
  await expect(panel).toContainText('双路可比 0 / 13 项');
  await expect(panel).toContainText('当前画面缺少两路都清晰可见的关节');
  await expect
    .poll(() =>
      videos.evaluateAll((vs: HTMLVideoElement[]) => vs[1].currentTime - vs[0].currentTime),
    )
    .toBeCloseTo(0.4, 1);
  await page.getByRole('button', { name: /^分析设置/ }).click();
  const drawer = page.getByRole('dialog', { name: '分析与显示设置' });
  const numbers = drawer.getByRole('spinbutton');
  await numbers.nth(0).fill('0.90');
  await numbers.nth(0).press('Tab');
  await expect(panel).toContainText('可对比 0.60 s');
  await expect(playhead).toHaveCount(0);
  await expect
    .poll(() => videos.evaluateAll((vs: HTMLVideoElement[]) => vs.every((v) => v.paused)))
    .toBe(true);
  await drawer.getByRole('button', { name: 'Close this dialog' }).click();
  await start();
  await expect(playhead).toContainText('分析中');
  await page.getByRole('button', { name: '暂停对比', exact: true }).click();
  await expect(playhead).toContainText('已暂停');
  await page.getByRole('button', { name: '继续分析', exact: true }).click();
  await expect(playhead).toContainText('分析中');
  await page.getByRole('button', { name: '暂停对比', exact: true }).click();
  await page.getByRole('button', { name: /^分析设置/ }).click();
  await numbers.nth(1).fill('1');
  await numbers.nth(1).press('Tab');
  await expect(playhead).toHaveCount(0);
  for (let i = 0; i < 3; i++) {
    await drawer.locator('.el-switch').nth(i).click();
    await expect(drawer.getByRole('switch').nth(i)).not.toBeChecked();
  }
  await drawer.getByRole('button', { name: 'Close this dialog' }).click();
  await start();
  await expect(playhead).toContainText('分析中');
  await inputs.nth(1).setInputFiles(resolve('tests/fixtures/60fps.mp4'));
  await expect(panel.locator('.compare-title span')).toHaveText(['30fps.mp4', '60fps.mp4']);
  await expect(playhead).toHaveCount(0);
  await expect(alignment).toHaveAttribute('aria-valuetext', '0.00 秒');
  await expect
    .poll(() => videos.evaluateAll((vs: HTMLVideoElement[]) => vs.every((v) => v.paused)))
    .toBe(true);
  await expect(panel).toContainText('约 10 Hz');
  await page.screenshot({ path: info.outputPath('comparison-reset.png'), fullPage: true });
  expect(errors).toEqual([]);
});

for (const action of ['replace', 'unmount'] as const) {
  test(`comparison lifecycle: late real model load after ${action} never starts playback`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let release!: () => void, requested!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route('**/mediapipe/pose_landmarker_lite.task', async (route) => {
      requested();
      await held;
      await route.continue().catch(() => {});
    });
    await page.locator('nav').getByRole('button', { name: '姿态对比', exact: true }).click();
    const panel = page.locator('.comparison-panel');
    const inputs = panel.locator('input[type=file]');
    await inputs.nth(0).setInputFiles(resolve('tests/fixtures/30fps.mp4'));
    await inputs.nth(1).setInputFiles(resolve('tests/fixtures/60fps.mp4'));
    await page.getByRole('button', { name: '开始对比', exact: true }).click();
    await seen;
    if (action === 'replace')
      await inputs.nth(0).setInputFiles(resolve('tests/fixtures/rotate.mp4'));
    else await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
    release();
    // This is the old component's real model network completion, not a mock result.
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .some((r) => r.name.endsWith('/mediapipe/pose_landmarker_lite.task')),
        ),
      )
      .toBe(true);
    if (action === 'unmount') {
      await page.locator('nav').getByRole('button', { name: '姿态对比', exact: true }).click();
      await expect(panel.locator('.compare-title span')).toHaveText(['尚未选择', '尚未选择']);
    } else {
      await expect(page.getByRole('button', { name: '开始对比', exact: true })).toBeEnabled();
      await expect(panel.locator('.compare-title span')).toHaveText(['rotate.mp4', '60fps.mp4']);
    }
    await expect(panel.locator('.compare-playhead')).toHaveCount(0);
    await expect
      .poll(() =>
        panel.locator('video').evaluateAll((vs: HTMLVideoElement[]) => vs.every((v) => v.paused)),
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: '暂停对比', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('video formats: cancel preparation and replace file without late writes @pages', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/ffmpeg/ffmpeg-core.wasm', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  const loadingConverter = page.waitForRequest('**/ffmpeg/ffmpeg-core.wasm');
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/format.avi'));
  await loadingConverter;
  await expect(page.getByRole('button', { name: '取消准备', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消准备', exact: true }).click();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/30fps.mp4'));
  release();
  await expect(page.locator('.status-message')).toContainText('文件已选择');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  await expect(page.locator('.offline-progress')).toContainText('30 / 30 帧');
});

test('video formats: corrupt input reports error and allows retry', async ({ page }) => {
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  const input = page.locator('.pose-stage input[type=file]');
  const broken = { name: 'broken.mkv', mimeType: '', buffer: Buffer.from('not a video') };
  await input.setInputFiles(broken);
  await expect(page.locator('.status-message')).toContainText('视频转换失败', { timeout: 60_000 });
  await input.setInputFiles({
    name: 'no-extension',
    mimeType: '',
    buffer: await readFile(resolve('tests/fixtures/30fps.mp4')),
  });
  await expect(page.locator('.status-message')).toContainText('文件已选择');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  await input.setInputFiles(broken);
  await expect(page.locator('.status-message')).toContainText('视频转换失败');
  await expect(page.locator('.offline-progress')).toContainText('30 / 30 帧');
});

test('camera startup diagnostic: pending permission is visible and times out without duplicate requests', async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(() => {
    (window as any).cameraPending = { requests: 0, resolve: null, stream: null };
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        const q = (window as any).cameraPending;
        q.requests++;
        q.resolve = () => {
          q.stream = document.createElement('canvas').captureStream();
          resolve(q.stream);
        };
      });
  });
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.status-message')).toContainText('等待浏览器摄像头授权');
  await page.clock.fastForward(30_001);
  await expect(page.locator('.status-message')).toContainText('超过 30 秒');
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  expect(await page.evaluate(() => (window as any).cameraPending.requests)).toBe(1);
  await page.evaluate(() => (window as any).cameraPending.resolve());
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraPending.stream.getTracks()[0].readyState))
    .toBe('ended');
  await expect(page.locator('.pose-stage video')).toHaveJSProperty('srcObject', null);
});

test('camera startup diagnostic: hardware failure preserves the browser error category', async ({
  page,
}) => {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('synthetic occupied device', 'NotReadableError');
    };
  });
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.status-message')).toContainText('NotReadableError');
  await expect(page.locator('.status-message')).toContainText('占用');
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeVisible();
});

test('camera startup diagnostic: model startup failure releases the acquired stream', async ({
  page,
}) => {
  await page.route('**/mediapipe/pose_landmarker_lite.task', (route) => route.abort());
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      canvas.getContext('2d')!.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(30);
      (window as any).cameraModelFailure = stream;
      return stream;
    };
  });
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.status-message')).toContainText('模型加载失败', { timeout: 30_000 });
  expect(
    await page.evaluate(() => (window as any).cameraModelFailure.getTracks()[0].readyState),
  ).toBe('ended');
  await expect(page.locator('.pose-stage video')).toHaveJSProperty('srcObject', null);
});

test('camera startup diagnostic: stalled video playback releases tracks after its own deadline', async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = document.createElement('canvas').captureStream();
      (window as any).cameraPlaybackFailure = stream;
      return stream;
    };
    document.querySelector<HTMLVideoElement>('.pose-stage video')!.play = () =>
      new Promise(() => {});
  });
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.status-message')).toContainText('正在等待视频画面');
  await page.clock.fastForward(10_001);
  await expect(page.locator('.status-message')).toContainText('TimeoutError');
  expect(
    await page.evaluate(() => (window as any).cameraPlaybackFailure.getTracks()[0].readyState),
  ).toBe('ended');
  await expect(page.locator('.pose-stage video')).toHaveJSProperty('srcObject', null);
});

for (const [name, detail] of [
  ['NotAllowedError', '未允许'],
  ['NotFoundError', '未找到'],
] as const) {
  test(`camera startup diagnostic: ${name} stays distinct`, async ({ page }) => {
    await page.evaluate((name) => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('synthetic rejection', name);
      };
    }, name);
    await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(page.locator('.status-message')).toContainText(name);
    await expect(page.locator('.status-message')).toContainText(detail);
    await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeVisible();
  });
}

test('synthetic camera permission pending: resume shares request and late grants release tracks', async ({
  page,
}) => {
  await page.evaluate(() => {
    const qa = ((window as any).cameraQA = { requests: [], streams: [] });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () =>
        new Promise<MediaStream>((resolve) => {
          qa.requests.push(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const stream = canvas.captureStream(30);
            qa.streams.push(stream);
            resolve(stream);
          });
        }),
    });
  });
  const start = () => page.getByRole('button', { name: '开始分析', exact: true }).click();
  const pause = () => page.getByRole('button', { name: '暂停分析', exact: true }).click();
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await start();
  await expect.poll(() => page.evaluate(() => (window as any).cameraQA.requests.length)).toBe(1);
  await pause();
  await start();
  expect(await page.evaluate(() => (window as any).cameraQA.requests.length)).toBe(1);
  await pause();
  await page.evaluate(() => (window as any).cameraQA.requests[0]());
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraQA.streams[0].getTracks()[0].readyState))
    .toBe('ended');
  await expect(page.locator('.pose-stage video')).toHaveJSProperty('srcObject', null);
  // A previous source's permission response must not stop or install another source's stream.
  await start();
  await expect.poll(() => page.evaluate(() => (window as any).cameraQA.requests.length)).toBe(2);
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await start();
  expect(await page.evaluate(() => (window as any).cameraQA.requests.length)).toBe(2);
  await expect(page.locator('.status-message')).toContainText('上一次浏览器摄像头请求仍未结束');
  await page.evaluate(() => (window as any).cameraQA.requests[1]());
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraQA.streams[1].getTracks()[0].readyState))
    .toBe('ended');
  await start();
  await expect.poll(() => page.evaluate(() => (window as any).cameraQA.requests.length)).toBe(3);
  await pause();
  await page.evaluate(() => (window as any).cameraQA.requests[2]());
  await expect
    .poll(() => page.evaluate(() => (window as any).cameraQA.streams[2].getTracks()[0].readyState))
    .toBe('ended');
});

async function installColorCamera(page: Page, controlledClock = false) {
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.evaluate((controlledClock) => {
    const q = ((window as any).colorCamera = { time: 10, color: '#0000ff', stream: null });
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      ctx.fillStyle = q.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    setInterval(draw, 33);
    if (controlledClock)
      Object.defineProperty(document.querySelector('.pose-stage video'), 'currentTime', {
        get: () => q.time,
      });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        draw();
        q.stream = canvas.captureStream(30);
        return q.stream;
      },
    });
  }, controlledClock);
}

const stageRGB = (page: Page) =>
  page
    .locator('.pose-stage canvas')
    .evaluate((canvas: HTMLCanvasElement) =>
      Array.from(
        canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ).slice(0, 3),
    );

test('synthetic camera clock uses media time, evicts the oldest image at 97 samples and releases tracks', async ({
  page,
}, info) => {
  await installColorCamera(page, true);
  await page.evaluate(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    const thumbnails = ((window as any).cameraThumbnails = new Set<HTMLCanvasElement>());
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args: number[]) {
      if (source instanceof HTMLCanvasElement && source.width === 640 && source.height === 480)
        thumbnails.add(this.canvas);
      Reflect.apply(draw, this, [source, ...args]);
    };
  });
  const pause = () => page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const slider = page.getByRole('slider', { name: '历史帧时间轴' });
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  const counter = page
    .locator('.metric-card')
    .filter({ hasText: '已采集帧数' })
    .locator('.metric-value');
  await expect(counter).toHaveText(/^1\s*帧/, { timeout: 30_000 });
  await page.waitForTimeout(250);
  await expect(counter).toHaveText(/^1\s*帧/);
  const step = async (count: number) => {
    await page.evaluate(
      (count) => ((window as any).colorCamera.time = 10 + (count - 1) / 5),
      count,
    );
    await expect(counter).toHaveText(new RegExp(`^${count}\\s*帧`));
  };
  for (let count = 2; count <= 96; count++) await step(count);
  await pause();
  await slider.press('Home');
  await expect.poll(() => stageRGB(page)).toEqual([0, 0, 255]);
  await expect(page.locator('.camera-history-status')).toHaveCount(0);
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await step(97);
  await pause();
  await slider.press('Home');
  await expect(page.locator('.camera-history-status')).toContainText('历史画面不可用');
  await expect.poll(() => stageRGB(page)).not.toEqual([0, 0, 255]);
  await page
    .locator('.pose-stage')
    .screenshot({ path: info.outputPath('evicted-first-frame.png') });
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  let pngDownloads = 0;
  page.on('download', (download) => {
    if (download.suggestedFilename().endsWith('.png')) pngDownloads++;
  });
  await page.getByRole('button', { name: '下载图片报告', exact: true }).click();
  await expect(page.locator('.el-message').last()).toContainText('无法导出该时刻的 PNG');
  expect(pngDownloads).toBe(0);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  // Verify the next oldest frame is retained, not just the newest one.
  await slider.press('End');
  const runway = (await page.locator('.timeline-row .el-slider__runway').boundingBox())!;
  await page.mouse.click(runway.x + runway.width / 96, runway.y + runway.height / 2);
  await expect(page.locator('.timeline-row > span')).toHaveText('0.20 s');
  await expect.poll(() => stageRGB(page)).toEqual([0, 0, 255]);
  const rows = await fullCSV(page, info, 'synthetic-camera-clock.csv');
  expect(rows.map((r) => Number(r.time_s))).toEqual(
    Array.from({ length: 97 }, (_, i) => 10 + i / 5 - 10),
  );
  replayFullCSV(rows);
  const thumbnails = await page.evaluate(() =>
    Array.from((window as any).cameraThumbnails as Set<HTMLCanvasElement>, (c) => [
      c.width,
      c.height,
    ]),
  );
  expect(thumbnails).toEqual(Array.from({ length: 96 }, () => [384, 288]));
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).colorCamera.stream.getTracks()[0].readyState),
  ).toBe('ended');
  expect(
    await page.evaluate(() =>
      Array.from((window as any).cameraThumbnails as Set<HTMLCanvasElement>).every(
        (c) => c.width === 0 && c.height === 0,
      ),
    ),
  ).toBe(true);
  await writeFile(
    info.outputPath('camera-cache-boundary.json'),
    JSON.stringify(
      {
        samples: rows.length,
        csvColumns: Object.keys(rows[0]).length,
        retainedAt96: rows[0].time_s,
        evictedAt97: rows[0].time_s,
        stillRetained: rows[1].time_s,
        slots: thumbnails.length,
        dimensions: thumbnails[0],
        rgbaBytes: thumbnails.length * 384 * 288 * 4,
        zeroSizedAfterSourceChange: true,
        pngDownloads,
      },
      null,
      2,
    ),
  );
});

test('synthetic camera rewind exports blue pixels at the selected time and rejects stale reports', async ({
  page,
}, info) => {
  await installColorCamera(page);
  await page.evaluate(() => {
    const labels = new WeakMap<HTMLCanvasElement, string>();
    const probe = ((window as any).cameraReport = { hold: false, label: '', release: null });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (text.includes(' · 画面 ')) labels.set(this.canvas, text);
      fillText.call(this, text, x, y, maxWidth);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      probe.label = labels.get(this);
      const encode = () => toBlob.call(this, callback, type, quality);
      if (probe.hold)
        probe.release = () => {
          probe.release = null;
          encode();
        };
      else encode();
    };
  });
  const nav = (name: string) => page.locator('nav').getByRole('button', { name }).click();
  const start = () => page.getByRole('button', { name: '开始分析', exact: true }).click();
  const pause = () => page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const timeline = page.locator('.timeline-row > span');
  const seconds = async () => parseFloat(await timeline.innerText());
  const slider = page.getByRole('slider', { name: '历史帧时间轴' });
  const report = page.getByRole('button', { name: '下载图片报告', exact: true });
  const rewind = async () => {
    await slider.press('Home');
    await expect(timeline).toHaveText('0.00 s');
    await expect.poll(() => stageRGB(page)).toEqual([0, 0, 255]);
  };
  const checkPNG = async (name: string, time: number, color: number[]) => {
    const { bytes } = await downloadFile(page, info, report, name);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    const result = await page.evaluate(async (base64) => {
      const blob = await (await fetch('data:image/png;base64,' + base64)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 720, 650, 1, 1, 0, 0, 1, 1);
      bitmap.close();
      return {
        label: (window as any).cameraReport.label,
        rgb: Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3),
      };
    }, bytes.toString('base64'));
    expect(result.label).toContain(`画面 ${time.toFixed(3)} s ·`);
    expect(result.rgb).toEqual(color);
    return result;
  };
  const holdReport = async () => {
    await page.evaluate(() => ((window as any).cameraReport.hold = true));
    await nav('数据导出');
    await report.click();
    await page.waitForFunction(() => !!(window as any).cameraReport.release);
  };
  const expectStaleReport = async () => {
    const unexpected = page.waitForEvent('download', { timeout: 600 }).catch(() => null);
    await page.evaluate(() => {
      (window as any).cameraReport.release();
      (window as any).cameraReport.hold = false;
    });
    await expect(page.locator('.el-message').last()).toContainText('STALE_SESSION');
    expect(await unexpected).toBeNull();
  };

  await start();
  await expect.poll(() => stageRGB(page), { timeout: 30_000 }).toEqual([0, 0, 255]);
  await expect.poll(seconds).toBeGreaterThan(0.3);
  const lastBlueTime = await seconds();
  await page.evaluate(() => ((window as any).colorCamera.color = '#ff0000'));
  await expect.poll(() => stageRGB(page)).toEqual([255, 0, 0]);
  await expect.poll(seconds).toBeGreaterThan(lastBlueTime + 0.2);
  await pause();
  await expect.poll(() => stageRGB(page)).toEqual([255, 0, 0]);
  const lastRedTime = await seconds();
  await rewind();
  const reviewedRGB = await stageRGB(page);
  await page
    .locator('.pose-stage')
    .screenshot({ path: info.outputPath('reviewed-blue-stage.png') });
  const rows = await fullCSV(page, info, 'camera-history.csv');
  replayFullCSV(rows);
  const selectedTime = Number(rows[0].time_s);
  expect(selectedTime).toBe(0);
  const reviewedPNG = await checkPNG('reviewed-blue-report.png', selectedTime, [0, 0, 255]);

  await holdReport();
  await nav('采集与分析');
  await page.getByRole('button', { name: '重算指标', exact: true }).click();
  await expectStaleReport();
  await expect.poll(() => stageRGB(page)).toEqual([0, 0, 255]);
  await nav('数据导出');
  const recalculatedPNG = await checkPNG('recalculated-blue-report.png', selectedTime, [0, 0, 255]);

  await nav('采集与分析');
  await start();
  await expect.poll(() => stageRGB(page)).toEqual([255, 0, 0]);
  await expect.poll(seconds).toBeGreaterThan(lastRedTime);
  const resumedTime = await seconds();
  const resumedRGB = await stageRGB(page);
  await pause();
  await rewind();
  await holdReport();
  await nav('采集与分析');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await expectStaleReport();
  await nav('数据导出');
  await expect(report).toBeDisabled();
  await nav('采集与分析');
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.evaluate(() => ((window as any).colorCamera.color = '#00ff00'));
  await start();
  await expect.poll(seconds).toBeGreaterThan(0);
  await pause();
  await slider.press('Home');
  // Chrome's captureStream color conversion can round the green sample by 1.
  await expect
    .poll(async () => {
      const [r, g, b] = await stageRGB(page);
      return r <= 2 && g >= 253 && b <= 2;
    })
    .toBe(true);
  const replacementRGB = await stageRGB(page);
  await nav('数据导出');
  const replacedPNG = await checkPNG('replacement-green-report.png', 0, replacementRGB);
  await nav('采集与分析');
  await page.getByRole('button', { name: '重置会话', exact: true }).click();
  await nav('数据导出');
  await expect(report).toBeDisabled();

  await writeFile(
    info.outputPath('camera-history-observations.json'),
    JSON.stringify(
      {
        browser: page.context().browser()!.version(),
        entry: await page.locator('script[type=module]').first().getAttribute('src'),
        selectedTime,
        reviewedRGB,
        reviewedPNG,
        recalculatedPNG,
        resumedTime,
        resumedRGB,
        replacedPNG,
        staleRecalculationAndSourceReportsRejected: true,
        reportDisabledAfterReset: true,
        csvColumns: Object.keys(rows[0]).length,
      },
      null,
      2,
    ),
  );
});

test('retained whole-page charts invalidate on joint, point basis and source changes', async ({
  page,
}) => {
  const nav = (name: string) =>
    page
      .locator('nav')
      .getByRole('button', { name, exact: name !== '采集与分析' })
      .click();
  const bitmap = (kind: string) =>
    page
      .locator(`.time-chart[data-kind="${kind}"] canvas`)
      .first()
      .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await nav('时序可视化');
  await expect(page.locator('.point-panel canvas').first()).toBeVisible();
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const angle = await bitmap('angle'),
    center = await bitmap('center');
  await page.locator('.angle-panel .el-select').click();
  await page.getByRole('option', { name: '肘关节', exact: true }).click();
  await expect.poll(() => bitmap('angle')).not.toBe(angle);
  expect(await bitmap('center')).toBe(center);
  const elbow = await bitmap('angle');
  await nav('数据导出');
  await nav('时序可视化');
  await expect.poll(() => bitmap('angle')).toBe(elbow);
  const filtered = await bitmap('point');
  await page.locator('.point-panel .el-select').nth(1).click();
  await page.getByRole('option', { name: 'raw', exact: true }).click();
  await expect.poll(() => bitmap('point')).not.toBe(filtered);
  await nav('采集与分析');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await nav('时序可视化');
  await expect(page.locator('.time-chart .chart-empty:visible')).toHaveCount(5);
  expect(await bitmap('angle')).not.toBe(elbow);
});

test('PNG waits for reviewed video seek and rejects a source changed while waiting', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('checkbox', { name: '生成/合成视频素材（synthetic）' }).check();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/60fps.mp4'));
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  await page.getByRole('slider', { name: '历史帧时间轴' }).press('Home');
  await page.evaluate(() => {
    (window as any).pendingSeek = true;
    Object.defineProperty(document.querySelector('.pose-stage video'), 'seeking', {
      configurable: true,
      get: () => (window as any).pendingSeek,
    });
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await page.getByRole('button', { name: '下载图片报告', exact: true }).click();
  await page.waitForTimeout(150);
  expect(downloads, 'A PNG must not capture a previous frame while seek is pending').toBe(0);
  const waiting = page.waitForEvent('download');
  await page.evaluate(() => ((window as any).pendingSeek = false));
  await (await waiting).saveAs(info.outputPath('reviewed.png'));
  expect(downloads).toBe(1);
  await page.evaluate(() => ((window as any).pendingSeek = true));
  await page.getByRole('button', { name: '下载图片报告', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.waitForTimeout(150);
  expect(downloads, 'Source replacement must reject the pending report').toBe(1);
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/30fps.mp4'));
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  await page.evaluate(() => {
    const native = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      (window as any).releasePNG = () => native.call(this, callback, type, quality);
    };
  });
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await page.getByRole('button', { name: '下载图片报告', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).releasePNG);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.evaluate(() => (window as any).releasePNG());
  await page.waitForTimeout(150);
  expect(downloads, 'Source replacement during PNG encoding must reject the late download').toBe(1);
});

for (const fixture of ['60fps', 'vfr', 'rotate']) {
  test(`synthetic H.264 ${fixture}: real Worker, every PTS, CSV, PNG${fixture === '60fps' ? ' @pages' : ''}`, async ({
    page,
  }, info) => {
    const checkAssets = trackPagesAssets(page, info);
    const errors: string[] = [],
      workers: string[] = [];
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('worker', (worker) => workers.push(worker.url()));
    const oracle = JSON.parse(await readFile(resolve(`tests/fixtures/${fixture}.json`), 'utf8'));
    await page.getByRole('button', { name: '上传视频', exact: true }).click();
    await page.getByRole('checkbox', { name: '生成/合成视频素材（synthetic）' }).check();
    await page
      .locator('.pose-stage input[type=file]')
      .setInputFiles(resolve(`tests/fixtures/${fixture}.mp4`));
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(page.locator('.offline-progress')).toContainText('全部完成', { timeout: 60_000 });
    // Every fixture has no detected person. A selected video must remain visible
    // instead of asking for another upload when a frame has no landmarks.
    await expect(page.locator('.status-message')).toContainText('未检测到可信人体姿态');
    await expect(page.locator('.pose-stage .stage-empty')).toBeHidden();
    const rows = await fullCSV(page, info, `${fixture}.csv`);
    expect(rows.length).toBe(oracle.count);
    rows.forEach((r, i) => {
      expect(Math.abs(Number(r.time_s) - oracle.ptsSeconds[i])).toBeLessThan(0.0000011);
      expect(r.synthetic).toBe('true');
      expect(r.source).toBe('file');
      expect(r.acquisition_status).toBe('completed');
      expect(Number(r.source_expected_frames)).toBe(oracle.count);
      expect(Number(r.source_processed_frames)).toBe(oracle.count);
    });
    replayCSV(rows);
    expect(
      workers.some((url) =>
        info.project.name === 'dev'
          ? /offline.worker.ts/.test(url)
          : /\/assets\/offline\.worker-[^/]+\.js$/.test(url),
      ),
    ).toBe(true);
    const source = await page
      .locator('.pose-stage canvas')
      .evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }));
    const { bytes, path } = await downloadFile(
      page,
      info,
      page.getByRole('button', { name: '下载图片报告', exact: true }),
      `${fixture}.png`,
    );
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(1440);
    expect(bytes.readUInt32BE(20)).toBe(
      Math.ceil(155 + (1320 * source.height) / source.width + 460),
    );
    await info.attach('worker-paths', {
      body: JSON.stringify(workers),
      contentType: 'application/json',
    });
    await page.screenshot({ path: info.outputPath('final.png'), fullPage: true });
    expect(path).toBeTruthy();
    expect(errors).toEqual([]);
    expect(navigations, 'First upload must not reload the page and erase the session').toEqual([]);
    await checkAssets(
      /\/pose-inference\.worker\.js$/,
      /\/mediapipe\/wasm\/[^/]+\.wasm$/,
      /\/mediapipe\/pose_landmarker_lite\.task$/,
    );
  });
}

test('pause/resume, cancel and reset reject late writes from production pipeline', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('checkbox', { name: '生成/合成视频素材（synthetic）' }).check();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/60fps.mp4'));
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress progress')).toHaveAttribute('value', /[1-9]\d*/);
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('已暂停');
  const snapshot = await fullCSV(page, info, 'paused.csv');
  await page.waitForTimeout(500); // Deliberate late-result observation window.
  const again = await fullCSV(page, info, 'paused-again.csv');
  expect(again).toEqual(snapshot);
  expect(snapshot.length).toBeLessThan(60);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect
    .poll(async () =>
      Number(await page.locator('.offline-progress progress').getAttribute('value')),
    )
    .toBeGreaterThan(snapshot.length);
  await page.getByRole('button', { name: '取消解码', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('已取消');
  const cancelled = await fullCSV(page, info, 'cancelled.csv');
  expect(cancelled[0].acquisition_status).toBe('cancelled');
  await page.waitForTimeout(500);
  expect(await fullCSV(page, info, 'cancelled-again.csv')).toEqual(cancelled);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '重新逐帧分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('逐帧分析中');
  await page.getByRole('button', { name: '重置会话', exact: true }).click();
  await page.waitForTimeout(700);
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await expect(page.getByRole('button', { name: '下载 CSV 数据', exact: true })).toBeDisabled();
  await expect(page.locator('.export-summary')).toContainText('0 帧');
});

test('center fluctuation follows the session, clip and linked chart range', async ({
  page,
}, info) => {
  const nav = (name: string) => page.locator('nav').getByRole('button', { name }).click();
  await page.getByRole('button', { name: '手动打点', exact: true }).click();
  const rows = await fullCSV(page, info, 'center-full.csv');
  const samples = rows.map((row) => ({
    time: Number(row.time_s),
    y: row.center_y === '' ? null : Number(row.center_y),
  }));
  const full: [number, number] = [samples[0].time, samples.at(-1)!.time];
  const card = page.locator('.motion-panel');
  const chart = card.getByRole('img', { name: '重心起伏时序图' });
  const marker = page.locator('.angle-panel .marker-clip');
  const timeLabel = ([start, end]: [number, number]) => `${start.toFixed(2)}–${end.toFixed(2)} s`;

  async function observe(
    step: string,
    scope: string,
    [start, end]: [number, number],
    zoomed = false,
  ) {
    const selected = (a: number, b: number) => samples.filter(({ time }) => time >= a && time <= b);
    const frames = selected(start, end);
    if (zoomed) {
      // Allow for browser serialization of the marker's CSS percentages.
      expect(selected(start - 0.00002, end + 0.00002)).toEqual(
        selected(start + 0.00002, end - 0.00002),
      );
      await expect(marker).toHaveText(`当前区间 ${timeLabel([start, end])}`);
    } else {
      await expect.soft(marker).toHaveCount(0, { timeout: 1000 });
    }
    const values = frames.flatMap(({ y }) => (y === null ? [] : [y]));
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    const fluctuation = min === null || max === null ? null : max - min;
    const csvDisplay = fluctuation === null ? '—' : fluctuation.toFixed(4);
    const value = card.locator('.center-chart-foot b');
    const label = card.locator('.center-stat-scope');
    console.log(
      JSON.stringify({
        step,
        interval: [start, end],
        sampleBounds: [frames[0]?.time, frames.at(-1)?.time],
        valid: values.length,
        sampled: frames.length,
        unit: 'normalized Y',
        min,
        max,
        fluctuation,
        csvDisplay,
        card: await value.innerText(),
        label: (await label.allTextContents())[0] ?? null,
        chartLabel: (await marker.allTextContents())[0] ?? null,
      }),
    );
    await card.screenshot({ path: info.outputPath(`${step}.png`) });
    await expect.soft(value, step).toHaveText(csvDisplay, { timeout: 1000 });
    await expect.soft(label, step).toHaveText(`统计范围：${scope}`, { timeout: 1000 });
  }

  const selection = page.locator('.angle-panel .marker-selection');
  const selectionStyle = () =>
    selection.evaluateAll((elements) => elements[0]?.getAttribute('style'));
  async function wheel(delta: number, count: number) {
    await chart.hover({ position: { x: 190, y: 100 } });
    for (let i = 0; i < count; i++) {
      const previous = await selectionStyle();
      if (delta > 0 && !previous) return;
      await page.mouse.wheel(0, delta);
      await expect.poll(selectionStyle).not.toBe(previous);
    }
  }

  async function zoomInterval([start, end]: [number, number]): Promise<[number, number]> {
    const [left, width] = await selection.evaluate((element: HTMLElement) => [
      parseFloat(element.style.left),
      parseFloat(element.style.width),
    ]);
    const span = end - start;
    return [start + (left / 100) * span, start + ((left + width) / 100) * span];
  }

  async function selectClip(interval: [number, number]) {
    await nav('采集与分析');
    const runway = page.locator('.timeline-row .el-slider__runway');
    const { width, height } = (await runway.boundingBox())!;
    const [start, end] = interval;
    await runway.click({ position: { x: (start / full[1]) * width, y: height / 2 } });
    await expect(page.locator('.timeline-row > span')).toHaveText(`${start.toFixed(2)} s`);
    await page.getByRole('button', { name: '截取片段', exact: true }).click();
    await runway.click({ position: { x: (end / full[1]) * width, y: height / 2 } });
    await expect(page.locator('.timeline-row > span')).toHaveText(`${end.toFixed(2)} s`);
    await page.getByRole('button', { name: '完成截取', exact: true }).click();
    await expect(page.locator('.clip-banner')).toContainText(timeLabel(interval));
    await nav('时序可视化');
    await expect(marker).toHaveCount(0);
  }

  await nav('时序可视化');
  await expect(chart.locator('canvas')).toBeVisible();
  await observe('01-full', '完整会话', full);
  await wheel(-160, 24);
  const fullZoom = await zoomInterval(full);
  await observe('02-full-zoom', `图表区间 ${timeLabel(fullZoom)}`, fullZoom, true);
  await wheel(160, 32);
  await observe('03-full-restored', '完整会话', full);

  const clipA: [number, number] = [2, 5];
  await selectClip(clipA);
  await observe('04-clip', `当前片段 ${timeLabel(clipA)}`, clipA);
  await wheel(-160, 5);
  const clipZoom = await zoomInterval(clipA);
  await observe('05-clip-zoom', `图表区间（片段内） ${timeLabel(clipZoom)}`, clipZoom, true);
  await wheel(160, 12);
  await observe('06-clip-restored', `当前片段 ${timeLabel(clipA)}`, clipA);
  await wheel(-160, 5);
  const beforeSwitch = await zoomInterval(clipA);
  await observe(
    '07-before-switch',
    `图表区间（片段内） ${timeLabel(beforeSwitch)}`,
    beforeSwitch,
    true,
  );

  const clipB: [number, number] = [6, 7.5];
  await selectClip(clipB);
  await observe('08-after-switch', `当前片段 ${timeLabel(clipB)}`, clipB);
  await page.getByRole('button', { name: '查看完整会话' }).click();
  await observe('09-clip-cleared', '完整会话', full);
});

test('correction cues follow the selected frame, joint and user range', async ({ page }) => {
  await page.goto('/');
  const correction = page.getByRole('region', { name: '动作纠正提示' });
  const status = correction.getByRole('status');
  const min = correction.getByLabel('目标下限（°）');
  const max = correction.getByLabel('目标上限（°）');
  await expect(status).toHaveText('待设置目标');

  const timeline = page.getByRole('slider', { name: '历史帧时间轴' });
  await timeline.press('Home');
  await expect(correction.getByText(/^0\.00 s · \d/)).toBeVisible();
  await min.fill('180');
  await max.fill('180');
  await expect(status).toHaveText('夹角偏小');
  await min.fill('0');
  await max.fill('0');
  await expect(status).toHaveText('夹角偏大');
  await min.fill('1');
  await expect(status).toHaveText('目标范围无效');
  await min.fill('0');
  await max.fill('180');
  await expect(status).toHaveText('夹角在目标范围内');
  await timeline.press('End');
  await expect(correction.getByText(/^[1-9]\d*\.\d{2} s · \d/)).toBeVisible();

  await correction.getByLabel('侧别').selectOption('right');
  await expect(min).toHaveValue('');
  await expect(max).toHaveValue('');
  const rightKnee = await page
    .getByRole('button', { name: /^膝关节/ })
    .locator('.right-value')
    .innerText();
  await expect(correction.getByText(`${rightKnee}°`, { exact: false })).toBeVisible();
  await correction.getByLabel('提示关节').selectOption('spine');
  await expect(correction.getByLabel('侧别')).toBeDisabled();
  await min.fill('0');
  await max.fill('180');
  await expect(status).toHaveText('夹角在目标范围内');

  await page.getByRole('button', { name: '显示与分析设置' }).click();
  const settings = page.getByRole('dialog', { name: '分析与显示设置' });
  const threshold = settings.getByRole('spinbutton').first();
  await threshold.fill('1');
  await threshold.press('Enter');
  await threshold.press('Escape');
  await expect(status).toHaveText('当前夹角不可用');

  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await expect(status).toHaveText('等待采样');
  await correction.getByRole('button', { name: '清除目标' }).click();
  await expect(status).toHaveText('待设置目标');
});

test('correction rules can be edited and removed independently, with the largest deviation highlighted', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('slider', { name: '历史帧时间轴' }).press('Home');
  const panel = page.getByRole('region', { name: '动作纠正提示' });
  const first = panel.getByRole('group', { name: '纠正规则 1' });
  const second = panel.getByRole('group', { name: '纠正规则 2' });
  await first.getByLabel('目标下限（°）').fill('180');
  await first.getByLabel('目标上限（°）').fill('180');
  await panel.getByRole('button', { name: '添加规则' }).click();
  await second.getByLabel('侧别').selectOption('right');
  const lower = second.getByLabel('目标下限（°）');
  const upper = second.getByLabel('目标上限（°）');
  await lower.fill('0');
  await upper.fill('0');
  await expect(first.getByRole('status')).toHaveText('夹角偏小');
  await expect(first).toContainText(/目标 180–180°。\s*低于下限 \d+\.\d°，尝试增大夹角/);
  await expect(second.getByRole('status')).toHaveText('夹角偏大');
  await expect(second).toContainText(/目标 0–0°。\s*高于上限 \d+\.\d°，尝试减小夹角/);
  await expect(second.getByText('优先提示')).toBeVisible();
  await expect(panel.getByText('优先提示')).toHaveCount(1);

  await upper.fill('180');
  await lower.fill('10.5');
  await expect(second.getByRole('status')).toHaveText('目标范围无效');
  await lower.fill('0');
  await expect(second.getByRole('status')).toHaveText('夹角在目标范围内');
  await expect(first.getByText('优先提示')).toBeVisible();
  await first.getByRole('button', { name: '删除规则' }).click();
  await expect(panel.getByRole('group', { name: /纠正规则/ })).toHaveCount(1);
  await expect(first.getByLabel('侧别')).toHaveValue('right');
  await expect(first.getByLabel('目标上限（°）')).toHaveValue('180');
  await expect(panel.getByText('优先提示')).toHaveCount(0);
  await first.getByRole('button', { name: '清除目标' }).click();
  await expect(first.getByRole('status')).toHaveText('待设置目标');
  await expect(first.getByLabel('侧别')).toHaveValue('right');
});

function kneeLandmarks(ankleY: number, visibility: number) {
  return Array.from({ length: 33 }, (_, i) => ({
    x: i === 27 ? 0.75 : i === 13 ? 0.37 : i === 15 ? 0.25 : 0.5,
    y: i === 23 || i === 24 ? 0.25 : i === 27 ? ankleY : 0.5,
    z: 0,
    visibility: i === 27 ? visibility : 1,
  }));
}

test('camera keeps partially visible joints and resumes after loss and a Worker error', async ({
  page,
}, info) => {
  await page.route('**/pose-inference.worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `onmessage = ({data}) => {
        if (data.type === 'init') postMessage({type: 'ready'});
        else if (data.fail) {
          data.bitmap.close();
          postMessage({type: 'error', message: 'simulated worker error'});
        } else {
          postMessage({type: 'result', points: data.points, bitmap: data.bitmap}, [data.bitmap]);
        }
      };`,
    }),
  );
  await installColorCamera(page, true);
  await page.evaluate(() => {
    const qa = ((window as any).trackingQA = { mode: 'visible', redetections: 0, workers: 0 });
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message.type === 'init') qa.workers++;
      if (message.type === 'detect') {
        qa.redetections += Number(message.redetect);
        message.fail = qa.mode === 'fail';
        message.points =
          qa.mode === 'lost'
            ? []
            : Array.from({ length: 33 }, (_, i) => ({
                x: i === 27 ? 0.7 : 0.5,
                y: i === 23 ? 0.3 : i === 27 ? 0.75 : 0.5,
                z: 0,
                visibility: [23, 25, 27].includes(i) ? 0.95 : 0,
              }));
      }
      return send.call(this, message, transfer);
    };
  });
  const counter = page.locator('.metric-card').filter({ hasText: '已采集帧数' });
  const count = (n: number) =>
    expect(counter.locator('.metric-value')).toHaveText(new RegExp(`^${n}\\s*帧`));
  const step = async (n: number, mode: string) => {
    await page.evaluate(
      ({ n, mode }) => {
        (window as any).trackingQA.mode = mode;
        (window as any).colorCamera.time = 10 + (n - 1) * 0.125;
      },
      { n, mode },
    );
    await count(n);
  };
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await count(1);
  await expect(counter).toContainText('当前帧可用 3 / 33');
  await step(2, 'lost');
  await expect(page.locator('.status-message').filter({ hasText: '仍在采集' })).toBeVisible();
  await step(3, 'visible');
  await step(4, 'fail');
  await expect.poll(() => page.evaluate(() => (window as any).trackingQA.workers)).toBe(2);
  await step(5, 'visible');
  expect(await page.evaluate(() => (window as any).trackingQA.redetections)).toBe(1);
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const rows = await fullCSV(page, info, 'reacquired.csv');
  expect(rows.map((r) => Number(r.time_s))).toEqual([0, 0.125, 0.25, 0.375, 0.5]);
  expect(rows.map((r) => Boolean(r.filtered_knee_left_deg))).toEqual([
    true,
    false,
    true,
    false,
    true,
  ]);
  expect(rows.every((r) => !r.filtered_knee_right_deg)).toBe(true);
});

test('correction camera cues settle on sample time and review uses the selected frame immediately', async ({
  page,
}) => {
  // Supply deterministic worker results while camera capture, human pose
  // acceptance, measurement and UI still run through their real paths.
  await page.route('**/pose-inference.worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `onmessage = ({data}) => {
      if (data.type === 'init') postMessage({type: 'ready'});
      else {
        data.bitmap.close();
        postMessage({type: 'result', points: data.points});
      }
    };`,
    }),
  );
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message.type === 'detect')
        message.points = (window as Window & { correctionLandmarks?: unknown }).correctionLandmarks;
      return send.call(this, message, transfer);
    };
  });
  await installColorCamera(page, true);
  await page.getByRole('button', { name: '显示与分析设置' }).click();
  const settings = page.getByRole('dialog', { name: '分析与显示设置' });
  const windowSize = settings
    .locator('.setting-row')
    .filter({ hasText: '滑动滤波窗口' })
    .getByRole('spinbutton');
  await windowSize.fill('1');
  await windowSize.press('Enter');
  await windowSize.press('Escape');
  const panel = page.getByRole('region', { name: '动作纠正提示' });
  const status = panel.getByRole('status');
  const start = page.getByRole('button', { name: '开始分析', exact: true });
  await panel.getByLabel('目标下限（°）').fill('90');
  const upper = panel.getByLabel('目标上限（°）');
  await upper.fill('110');

  const counter = page
    .locator('.metric-card')
    .filter({ hasText: '已采集帧数' })
    .locator('.metric-value');
  let count = 0;
  async function sample(time: number, reading: 'below' | 'edge' | 'invalid') {
    const points = kneeLandmarks(
      reading === 'below' ? 0.4999 : 0.5,
      reading === 'invalid' ? 0.1 : 1,
    );
    await page.evaluate(
      ({ time, points }) => {
        const camera = window as typeof window & {
          colorCamera: { time: number };
          correctionLandmarks: typeof points;
        };
        camera.correctionLandmarks = points;
        camera.colorCamera.time = 10 + time;
      },
      { time, points },
    );
    if (count === 0) await start.click();
    await expect(counter).toHaveText(new RegExp(`^${++count}\\s*帧`), { timeout: 30_000 });
  }

  await sample(0, 'below');
  await expect(status).toHaveText('等待读数稳定');
  await expect(panel.getByText('0.00 s · 90.0°')).toBeVisible();
  await sample(0.13, 'below');
  await page.waitForTimeout(350); // An idle wall clock does not advance the source clock.
  await expect(status).toHaveText('等待读数稳定');
  await sample(0.29, 'edge');
  await expect(status).toHaveText('夹角在目标范围内');
  await expect(panel).toContainText('距最近边界 0.0°');

  await sample(0.34, 'below');
  await sample(0.63, 'below');
  await expect(status).toHaveText('夹角在目标范围内');
  await expect(panel).not.toContainText('尝试增大夹角');
  await sample(0.64, 'below');
  await expect(status).toHaveText('夹角偏小');
  await expect(panel).toContainText('低于下限 0.0°，尝试增大夹角');

  await sample(0.73, 'edge');
  await expect(status).toHaveText('夹角偏小');
  await expect(panel).toContainText('上次稳定状态');
  await expect(panel).toContainText('尝试增大夹角');
  await expect(panel.getByText('优先提示')).toBeVisible();
  await sample(0.85, 'below');
  await sample(1.02, 'edge');
  await sample(1.31, 'edge');
  await expect(status).toHaveText('夹角偏小');
  await sample(1.32, 'edge');
  await expect(status).toHaveText('夹角在目标范围内');
  await expect(panel.getByText('优先提示')).toHaveCount(0);

  await sample(1.4, 'below');
  await sample(1.65, 'invalid');
  await expect(status).toHaveText('当前夹角不可用');
  await sample(1.7, 'below');
  await sample(1.95, 'below');
  await expect(status).toHaveText('等待读数稳定');
  await sample(2, 'below');
  await expect(status).toHaveText('夹角偏小');
  await upper.fill('109');
  await expect(status).toHaveText('等待读数稳定');
  await sample(2.2, 'below');
  await sample(2.49, 'below');
  await expect(status).toHaveText('等待读数稳定');
  await sample(2.5, 'below');
  await expect(status).toHaveText('夹角偏小');

  await sample(2.57, 'edge');
  await expect(status).toHaveText('夹角偏小');
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  await expect(status).toHaveText('夹角在目标范围内');
  const timeline = page.getByRole('slider', { name: '历史帧时间轴' });
  await timeline.press('Home');
  await expect(status).toHaveText('夹角偏小');
  await timeline.press('End');
  await expect(status).toHaveText('夹角在目标范围内');
  const lower = panel.getByLabel('目标下限（°）');
  await lower.fill('70');
  await upper.fill('90');
  await expect(status).toHaveText('夹角在目标范围内');
  await expect(panel).toContainText('距最近边界 0.0°');
  await lower.fill('90');
  await start.click();
  await sample(2.8, 'below');
  await expect(status).toHaveText('等待读数稳定');
  await timeline.press('Home');
  await expect(status).toHaveText('夹角偏小');
  await start.click();
  await sample(3, 'below');
  await sample(3.3, 'below');
  await expect(status).toHaveText('夹角偏小');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await expect(status).toHaveText('等待采样');
});

test('clip, quoted marker, recalculate preserve snapshot and downloadable CSV @pages', async ({
  page,
}, info) => {
  const baseline = await fullCSV(page, info, 'baseline.csv');
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  const slider = page.getByRole('slider', { name: '历史帧时间轴' });
  await slider.focus();
  await slider.press('Home');
  await page.getByRole('button', { name: '手动打点', exact: true }).click();
  await page.getByRole('button', { name: '截取片段', exact: true }).click();
  await slider.press('End');
  for (let i = 0; i < 10; i++) await slider.press('ArrowLeft');
  await page.getByRole('button', { name: '完成截取', exact: true }).click();
  await page.getByRole('button', { name: '重算指标', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: '数据导出' }).click();
  await page.getByRole('textbox', { name: '标记 1 名称' }).fill('F,"quoted" synthetic');
  const rows = await fullCSV(page, info, 'clipped.csv');
  expect(rows.length).toBeLessThan(baseline.length);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0].session_id).toBe(baseline[0].session_id);
  expect(Number(rows[0].session_revision)).toBe(Number(baseline[0].session_revision) + 1);
  expect(rows[0].markers).toBe('F,"quoted" synthetic');
  replayCSV(rows);
  await page.locator('nav').getByRole('button', { name: '时序可视化' }).click();
  const table = page.locator('.stats-table');
  await expect(table.locator('th')).toContainText([
    '关节',
    '左侧 / 中线最小 / 最大',
    '左侧 / 中线 ROM',
    '右侧最小 / 最大',
    '右侧 ROM',
    '左侧 / 中线有效样本',
    '右侧有效样本',
  ]);
  await expect(table.locator('xpath=../..').locator('.unit-label')).toContainText('当前片段');
  for (const j of JOINTS) {
    const cells = table.locator('tbody tr').filter({ hasText: j.label }).locator('td');
    for (const [side, column] of [
      ['left', 5],
      ['right', 6],
    ] as const) {
      if (j.key === 'spine' && side === 'right') {
        await expect(cells.nth(column)).toHaveText('—');
        continue;
      }
      const channel = j.key === 'spine' ? 'midline' : side;
      const valid = rows.filter((row) => row[`filtered_${j.key}_${channel}_deg`] !== '').length;
      await expect(cells.nth(column)).toHaveText(
        `${valid} / ${rows.length} · ${((valid / rows.length) * 100).toFixed(1)}%`,
      );
    }
  }
  await page.screenshot({ path: info.outputPath('joint-coverage.png'), fullPage: true });
});

for (const provider of ['ollama', 'deepseek'] as const)
  test(`scripted protocol only (${provider}): Agent final chart, report/CSV saves, stale disabled`, async ({
    page,
  }, info) => {
    const archive =
      provider === 'ollama' && process.env.QA_QWEN_ARCHIVE
        ? JSON.parse(await readFile(process.env.QA_QWEN_ARCHIVE, 'utf8'))
        : null;
    const requests = await scriptedOllama(
      page,
      provider,
      archive?.requests[0].reply.calls[0].arguments,
    );
    let downloads = 0;
    page.on('download', () => downloads++);
    const { rows, material } = await fixedRomSession(page, info);
    expect(material).toBe(FIXED_ROM_FINGERPRINT);
    replayCSV(rows);
    await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
    const choice =
      provider === 'deepseek'
        ? ['deepseek', 'deepseek-flash', '']
        : ['ollama', 'scripted-protocol-only', 'http://127.0.0.1:11434'];
    await page.getByLabel('模型', { exact: true }).selectOption(JSON.stringify(choice));
    expect(requests).toHaveLength(0);
    const nav = (name: string) => page.locator('nav').getByRole('button', { name }).click();
    const chart = page.locator('#agent-chart-view');
    const heading = chart.getByRole('heading', { level: 2 });
    const plot = chart.locator('.echart');
    const angle = page.locator('.angle-panel');
    const bitmap = (surface: typeof plot) =>
      surface
        .locator('canvas')
        .first()
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    for (const [turn, goal] of goals.entries()) {
      if (provider === 'deepseek' && turn === 1) {
        const before = requests.length;
        await page
          .getByLabel('模型', { exact: true })
          .selectOption(JSON.stringify(['deepseek', 'deepseek-v4-pro', '']));
        expect(requests).toHaveLength(before);
      }
      await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goal);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const run = page.locator('.run-panel').first();
      const review = romCard(page);
      await expect(run.locator('h3').first()).toHaveText(goal);
      await expect(review.getByText('自由目标 · 请核对或编辑模型声明后确认')).toBeVisible();
      await expect(run.locator('.evidence-card')).toHaveCount(0);
      await expect(run.locator('.artifact-card')).toHaveCount(0);
      const requestCount = requests.length;
      if (turn === 0) await expect(chart).toContainText('图表区间 完整会话');
      if (archive && turn === 0) {
        await expect(review.getByLabel('统计后段类型', { exact: true })).toHaveValue('end');
        await expect(review.getByLabel('统计后段时长', { exact: true })).toHaveValue('5');
        await expect(review.locator('[data-rom-range="second"]')).toHaveText(
          '实际区间 16.5–21.5 s',
        );
        await review.screenshot({ path: info.outputPath('free-goal-archived-before-confirm.png') });
        await setAbsolute(page, '统计后段', 15, 20);
        await review.getByLabel('图表范围类型', { exact: true }).selectOption('cover');
        await review.getByLabel('单独统计前段').uncheck();
      }
      await expect(review.locator('[data-rom-range="second"]')).toHaveText(
        turn ? '实际区间 12–17 s' : '实际区间 15–20 s',
      );
      await expect(review.locator('[data-rom-range="chart"]')).toHaveText(
        turn ? '实际区间 0–17 s' : '实际区间 0–20 s',
      );
      expect(requests.length).toBe(requestCount);
      await review.getByRole('button', { name: '确认并运行比较', exact: true }).click();
      await expect(page.locator('.run-panel').first().locator('.run-status')).toHaveText('已完成');
      if (provider === 'deepseek') {
        await expect(page.locator('.run-panel').first().locator('.run-meta').first()).toContainText(
          turn ? 'DeepSeek / deepseek-v4-pro' : 'DeepSeek / deepseek-flash',
        );
        await expect(page.locator('.run-panel').last().locator('.run-meta').first()).toContainText(
          'DeepSeek / deepseek-flash',
        );
        expect(requests.at(-1).model).toBe(turn ? 'deepseek-v4-pro' : 'deepseek-flash');
      }
      // A completed model outcome precedes the application/audit barrier.
      // Wait for the end-to-end receipt before hovering the final chart.
      await expect(
        page
          .locator('.run-panel')
          .first()
          .getByRole('button', { name: '保存完整本地审计', exact: true }),
      ).toBeVisible();
      const sides = turn ? '右侧' : '左侧 / 右侧';
      const interval = turn ? '0–17 s' : '0–20 s';
      await expect(heading).toHaveText(`Agent 视图 · 膝关节 · filtered · ${sides}`);
      await expect(chart).toContainText(`图表区间 ${interval}`);
      await plot.hover({ position: { x: 350, y: 120 } });
      await expect(plot).toContainText('右侧');
      if (turn) await expect(plot).not.toContainText('左侧');
      else await expect(plot).toContainText('左侧');
      if (turn === goals.length - 1) continue;

      await heading.hover();
      const deliveredCurve = await bitmap(plot);
      await nav('时序可视化');
      await expect(angle.locator('.el-select')).toHaveText('膝关节');
      await expect(angle.locator('.chart-legend')).toHaveText('左侧右侧');
      const manualPlot = angle.locator('.echart');
      await manualPlot.hover({ position: { x: 350, y: 120 } });
      await expect(manualPlot).toContainText('左侧');
      await expect(manualPlot).toContainText('右侧');
      await angle.locator('.el-select').click();
      await page.getByRole('option', { name: '脊柱', exact: true }).click();
      await expect(angle.locator('.el-select')).toHaveText('脊柱');
      await expect(angle.locator('.chart-legend')).toHaveText('中线');
      await manualPlot.hover({ position: { x: 350, y: 120 } });
      await expect(manualPlot).toContainText('中线');
      await expect(manualPlot).not.toContainText('右侧');
      await angle.screenshot({ path: info.outputPath(`manual-spine-turn-${turn + 1}.png`) });

      await nav('AI Agent 分析');
      await expect(heading).toHaveText(`Agent 视图 · 膝关节 · filtered · ${sides}`);
      await expect(chart).toContainText(`图表区间 ${interval}`);
      await expect(page.locator('.run-panel').first().locator('.run-status')).toHaveText('已完成');
      await expect.poll(() => bitmap(plot)).toBe(deliveredCurve);
      await chart.screenshot({ path: info.outputPath(`agent-restored-turn-${turn + 1}.png`) });
    }
    expect(downloads, 'prepare must not trigger automatic downloads').toBe(1);
    await page.screenshot({ path: info.outputPath('agent-final.png'), fullPage: true });
    const run = page.locator('.run-panel').first();
    const report = JSON.parse(
      (
        await downloadFile(
          page,
          info,
          run.getByRole('button', { name: '保存报告 JSON', exact: true }),
          'agent-report.json',
        )
      ).bytes.toString(),
    );
    expect(report.reference.sessionId).toBe(rows[0].session_id);
    expect(report.reference.revision).toBe(Number(rows[0].session_revision));
    expect(report.result.facts.evidence.interval).toEqual([0, 5]);
    expect(report.result.comparison.second.evidence.interval).toEqual([12, 17]);
    expect(report.result.facts.channels.map((c: any) => c.channel)).toEqual(['right']);
    expect(report.result.quality.selection.joint).toBe('knee');
    expect(report.result.quality.selection.basis).toBe('filtered');
    expect(report.result.quality.selection.channels.map((c: any) => c.channel)).toEqual(['right']);
    expect(report.result.comparisonQuality.evidence.interval).toEqual([12, 17]);
    expect(report.result.comparisonQuality.selection.channels.map((c: any) => c.channel)).toEqual([
      'right',
    ]);
    const localQuality = run.locator('.evidence-card').filter({ hasText: '选中关节角度可用性' });
    await expect(localQuality).toHaveCount(2);
    await expect(localQuality.first()).toContainText('分母为区间全部已采样帧');
    await expect(localQuality.first()).toContainText('检出但角度无效');
    await expect(run.getByText('右侧角度极值（并列取首个源时间）：')).toBeVisible();
    const first = rom(rows, [0, 5], 'right'),
      second = rom(rows, [12, 17], 'right');
    expect(report.result.facts.channels[0].rom).toBeCloseTo(first.value, 8);
    expect(report.result.facts.channels[0].angle.sampleCount).toBe(first.samples);
    expect(report.result.comparison.differences[0].rom).toBeCloseTo(second.value - first.value, 8);
    const exported = parseCSV(
      (
        await downloadFile(
          page,
          info,
          run.getByRole('button', { name: '保存 CSV', exact: true }),
          'agent-prepared.csv',
        )
      ).bytes,
    );
    expect(exported).toEqual(rows.filter((r) => Number(r.time_s) <= 17));
    expect(exported).toHaveLength(305);
    expect(Object.keys(exported[0])).toHaveLength(354);
    const auditFile = await downloadFile(
      page,
      info,
      run.getByRole('button', { name: '保存完整本地审计', exact: true }),
      'agent-audit.json',
    );
    const audit = JSON.parse(auditFile.bytes.toString());
    expect(audit.run.modelProtocolVersion).toBe('3.12.0');
    expect(audit.run.protocolFingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const [i, request] of audit.requests.entries()) {
      expect(request.tools.map((tool: any) => tool.name)).toEqual(
        audit.run.requests[i].offeredTools,
      );
      expect(audit.run.requests[i].toolFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(audit.run.timing.application).toBe('ready');
    expect(audit.run.timing.audit).toBe('saved');
    expect(audit.run.timing.completedAt).toBeGreaterThanOrEqual(audit.run.timing.submittedAt);
    expect(audit.run.timing.wallMs).toBeGreaterThanOrEqual(audit.run.elapsedMs);
    expect(audit.run.timing.manualWaitMs).toBeGreaterThan(0);
    expect(audit.run.timing.computeMs + audit.run.timing.manualWaitMs).toBeCloseTo(
      audit.run.timing.wallMs,
      6,
    );
    expect(audit.run.conversationCosts.turns).toBe(3);
    expect(verifyAudit(rows, audit)).toEqual([
      'get_session_info',
      'compare_intervals',
      'set_chart_view',
      'prepare_report',
      'prepare_export',
    ]);
    const localRange = report.result.quality.selection.channels[0].validIntervals[0].interval;
    const rangeLabel = localRange.map((v: number) => Number(v.toFixed(6))).join('–');
    await localQuality
      .first()
      .getByRole('button', { name: `${rangeLabel} s · 定位`, exact: true })
      .click();
    await expect(heading).toHaveText('Agent 视图 · 膝关节 · filtered · 右侧');
    await expect(chart).toContainText(`图表区间 ${rangeLabel} s`);
    await expect(chart).toContainText(`回看位置 ${localRange[0].toFixed(6)} s`);
    await page.screenshot({ path: info.outputPath('local-quality-located.png'), fullPage: true });
    await plot.hover({ position: { x: 350, y: 120 } });
    await page.mouse.wheel(0, -240);
    await expect(chart).not.toContainText(`图表区间 ${rangeLabel} s`);
    await expect(heading).toHaveText('Agent 视图 · 膝关节 · filtered · 右侧');
    await expect(plot).toContainText('右侧');
    await expect(plot).not.toContainText('左侧');

    // Invalidate a still-current delivery independently through each lifecycle path.
    await nav('采集与分析');
    await page
      .getByRole('button', { name: provider === 'ollama' ? '重算指标' : '上传视频', exact: true })
      .click();
    await nav('AI Agent 分析');
    await expect(run.locator('.run-status')).toContainText('已过期');
    if (provider === 'ollama') await expect(chart).toContainText('图表区间 完整会话');
    else await expect(chart).toHaveCount(0);
    for (const name of ['保存报告 JSON', '保存 CSV'])
      await expect(run.getByRole('button', { name, exact: true })).toBeDisabled();
    expect(await run.locator('.evidence-card button').count()).toBeGreaterThan(0);
    for (const button of await run.locator('.evidence-card button').all())
      await expect(button).toBeDisabled();
    await info.attach('scripted-http-requests', {
      body: JSON.stringify(requests),
      contentType: 'application/json',
    });
  });

test('ROM free-goal review: recalculate invalidates the pending confirmation', async ({
  page,
}, info) => {
  const requests = await scriptedOllama(page, 'deepseek');
  await fixedRomSession(page, info);
  await page
    .getByLabel('模型', { exact: true })
    .selectOption(JSON.stringify(['deepseek', 'deepseek-flash', '']));
  await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goals[0]);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const card = romCard(page);
  await expect(card.getByText('自由目标 · 请核对或编辑模型声明后确认')).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '重算指标', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  await expect(card.getByRole('button', { name: '确认并运行比较', exact: true })).toHaveCount(0);
  const run = page.locator('.run-panel').first();
  await expect(run.locator('.run-status')).toContainText('已过期');
  expect(requests).toHaveLength(1);
  const audit: RunAudit = JSON.parse(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存完整本地审计', exact: true }),
        'free-goal-stale-review.json',
      )
    ).bytes.toString(),
  );
  expect(audit.run.romReview?.confirmation).toBeUndefined();
  expect(audit.run.calls.filter((c) => c.output.ok).map((c) => c.name)).toEqual([
    'get_session_info',
  ]);
  expect(audit.run.citations).toEqual([]);
});

test('scripted DeepSeek cancel never applies a late response or exposes a save entry', async ({
  page,
}) => {
  await page.route('**/__models/catalog', (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            provider: 'deepseek',
            models: ['deepseek-flash', 'deepseek-v4-pro'],
            missing: [],
            endpoint: 'https://api.deepseek.com/chat/completions',
          },
        ],
      },
    }),
  );
  let sent = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/__models/complete', async (route) => {
    sent++;
    requested();
    await pending;
    await route
      .fulfill({ json: { calls: [{ name: 'set_chart_view', arguments: {} }] } })
      .catch(() => {});
  });
  await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  await page
    .getByLabel('模型', { exact: true })
    .selectOption(JSON.stringify(['deepseek', 'deepseek-flash', '']));
  await page.locator('.goal-panel form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await requestSeen;
  await page
    .getByLabel('模型', { exact: true })
    .selectOption(JSON.stringify(['deepseek', 'deepseek-v4-pro', '']));
  await expect(page.locator('.run-panel .run-meta').first()).toContainText(
    'DeepSeek / deepseek-flash',
  );
  await page.getByRole('button', { name: '取消分析', exact: true }).click();
  release();
  await expect(page.locator('.run-status')).toHaveText('已取消');
  await expect(page.getByRole('button', { name: '保存完整本地审计', exact: true })).toBeVisible();
  await expect(page.locator('.artifact-card')).toHaveCount(0);
  expect(sent).toBe(1);
  await expect(page.locator('.call-record')).toHaveCount(0);
});

test('Agent keeps the analyzed video and sampled times with results and downloads after source changes', async ({
  page,
}, info) => {
  const firstName = 'session-first.mp4';
  const secondName = 'session-next.mp4';
  const buffer = await readFile(resolve('tests/fixtures/30fps.mp4'));
  const modelRequests: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.route('http://127.0.0.1:11434/api/tags', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('**/__models/**', (route) => {
    if (route.request().url().endsWith('/catalog'))
      return route.fulfill({
        json: {
          envFile: '.env',
          providers: [{ provider: 'openai', models: [], missing: ['OPENAI_API_KEY'] }],
        },
      });
    if (route.request().url().endsWith('/release'))
      return route.fulfill({ json: { released: true } });
    modelRequests.push(route.request().postData()!);
    return route.fulfill({ status: 502, json: { error: 'CLOUD_UPSTREAM_HTTP_401' } });
  });
  const nav = (name: string) => page.locator('nav').getByRole('button', { name }).click();
  const input = page.locator('.pose-stage input[type=file]');
  await page.goto('/');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await input.setInputFiles({ name: firstName, mimeType: 'video/mp4', buffer });
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成', { timeout: 60_000 });
  await nav('AI Agent 分析');
  const current = page.locator('.agent-source');
  await expect(current).toContainText(firstName);
  await expect(current).toContainText('已采样 0–0.966667 s · 30 帧');
  await page
    .getByLabel('模型', { exact: true })
    .selectOption({ label: 'gpt-6.1-sol · OpenAI GPT' });
  await page.getByLabel('临时 API Key').fill('test-openai-key');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('检查 API Key');
  expect(modelRequests).toHaveLength(1);
  expect(modelRequests[0]).toContain('gpt-6.1-sol');
  expect(modelRequests[0]).not.toContain(firstName);

  const card = romCard(page);
  await card.getByRole('button', { name: '手动填写' }).click();
  await setAbsolute(page, '统计前段', 0.05, 0.29);
  await setAbsolute(page, '统计后段', 0.58, 0.82);
  await card.getByLabel('准备比较报告').check();
  await card.getByLabel('准备 CSV').check();
  await card.getByRole('button', { name: '确认并运行比较' }).click();
  const run = page.locator('.run-panel').first();
  await expect(run.locator('.run-status')).toHaveText('不可比');
  await expect(run.locator('.source-name')).toContainText(firstName);
  const evidence = run.locator('.evidence-card').first();
  await expect(evidence).toContainText(
    '前段 · 请求区间 0.05–0.29 s · 实际采样 0.066667–0.266667 s',
  );
  await expect(evidence).toContainText('后段 · 请求区间 0.58–0.82 s · 实际采样 0.6–0.8 s');
  await expect(run.locator('.citation-list a').first()).toHaveAttribute(
    'href',
    '#' + (await evidence.getAttribute('id')),
  );
  await evidence.getByRole('button', { name: '定位后段' }).click();
  await expect(page.locator('#agent-chart-view')).toContainText('回看位置 0.600000 s');
  const report = JSON.parse(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存报告 JSON', exact: true }),
        'named-source-report.json',
      )
    ).bytes.toString(),
  );
  expect(report.reference.fileName).toBe(firstName);
  expect(report.analysis.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(report.result.comparison.second.evidence.sampledRange).toEqual([0.6, 0.8]);
  const csvDownload = page.waitForEvent('download');
  const csv = parseCSV(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存 CSV', exact: true }),
        'named-source.csv',
      )
    ).bytes,
  );
  expect((await csvDownload).suggestedFilename()).toContain(firstName);
  expect(csv[0].session_id).toBe(report.reference.sessionId);
  expect(csv[0].time_s).toBe('0.066667');
  expect(csv.at(-1)?.time_s).toBe('0.8');

  await nav('采集与分析');
  await input.setInputFiles({ name: secondName, mimeType: 'video/mp4', buffer });
  await expect(page.locator('.status-message')).toContainText('文件已选择');
  await nav('AI Agent 分析');
  await expect(current).toContainText(secondName);
  await expect(current).toContainText('暂无采样');
  await expect(run.locator('.run-status')).toContainText('已过期');
  await expect(evidence).toContainText(firstName);
  await expect(run.getByRole('button', { name: '保存报告 JSON', exact: true })).toBeDisabled();
  await expect(evidence.getByRole('button', { name: '定位后段' })).toBeDisabled();
});

test('Agent model setup, failure, restored preference and unavailable manual analysis', async ({
  page,
}) => {
  let installed = true;
  let requests = 0;
  let probes = 0;
  await page.route('http://127.0.0.1:11434/api/tags', (route) =>
    route.fulfill({
      json: {
        models: installed ? [{ name: 'installed-local' }] : [],
      },
    }),
  );
  await page.route('**/__models/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          envFile: 'D:/project/.env',
          providers: [
            {
              provider: 'deepseek',
              models: ['deepseek-flash'],
              missing: [],
              endpoint: 'https://api.deepseek.com/chat/completions',
            },
            {
              provider: 'openai',
              models: [],
              missing: ['OPENAI_API_KEY', 'OPENAI_MODELS'],
              endpoint: 'https://api.openai.com/v1/responses',
            },
          ],
        },
      });
    if (path.endsWith('/probe')) {
      probes++;
      return route.fulfill({ json: { requests: 1, response: { model: 'deepseek-flash' } } });
    }
    requests++;
    return route.fulfill({ status: 502, json: { error: 'CLOUD_UPSTREAM_HTTP_401' } });
  });
  const openAgent = () =>
    page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  const model = page.getByLabel('模型', { exact: true });
  const send = page.getByRole('button', { name: '发送', exact: true });
  const settings = page.getByRole('region', { name: '模型设置' });
  await openAgent();
  const cloud = JSON.stringify(['deepseek', 'deepseek-flash', '']);
  await expect(model.locator('option').filter({ hasText: 'deepseek-flash' })).toBeAttached();
  await model.selectOption({ label: 'gpt-5.4-mini · OpenAI GPT' });
  await expect(page.getByLabel('临时 API Key')).toBeVisible();
  await page.getByText('首次连接？查看连接指南', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'OpenAI GPT 控制台' })).toHaveAttribute(
    'href',
    'https://platform.openai.com/api-keys',
  );
  await expect(page.getByRole('button', { name: '测试当前模型连接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await settings.getByText('服务配置（可选）', { exact: true }).click();
  await expect(settings).toContainText('OPENAI_API_KEY');
  await expect(settings).toContainText('OPENAI_MODELS');
  await expect(settings).toContainText('D:/project/.env');
  await expect(settings).toContainText('重启本机 Node 服务');
  await expect(settings.locator('.connection-status')).toHaveText('待配置');
  await expect(send).toBeDisabled();
  await settings.getByRole('button', { name: '刷新模型列表' }).click();
  await model.selectOption(cloud);
  await expect(settings.locator('.connection-status')).toHaveText('可发送');
  expect([requests, probes]).toEqual([0, 0]);
  const goal = page.getByLabel('分析目标或后续修改');
  await goal.fill('比较左右膝 ROM');
  await send.click();
  await expect(page.getByRole('alert')).toContainText('检查 API Key 和账户权限');
  await expect(goal).toHaveValue('比较左右膝 ROM');
  await expect(settings.locator('.connection-status')).toHaveText('连接异常');
  expect([requests, probes]).toEqual([1, 0]);
  await settings.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(settings).toContainText('结构化工具调用通过');
  await expect(settings.locator('.connection-status')).toHaveText('已连接');
  expect([requests, probes]).toEqual([1, 1]);

  const local = JSON.stringify(['ollama', 'installed-local', 'http://127.0.0.1:11434']);
  await model.selectOption(local);
  await page.reload();
  await openAgent();
  await expect(model).toHaveValue(local);
  await expect(send).toBeEnabled();
  expect([requests, probes]).toEqual([1, 1]);

  installed = false;
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await settings.getByRole('button', { name: '刷新模型列表' }).click();
  await expect(page.getByText('上次选择的模型当前不可用', { exact: false })).toBeVisible();
  await expect(settings).toContainText('ollama list');
  await expect(model).toHaveValue(local);
  await expect(send).toBeDisabled();
  await page.getByRole('button', { name: '前往采集与分析', exact: true }).click();
  await expect(page.getByRole('button', { name: '手动打点', exact: true })).toBeVisible();
  expect([requests, probes]).toEqual([1, 1]);
});

test('Agent sends with a temporary official key and clears it on demand or reload', async ({
  page,
}) => {
  const temporaryKey = 'scripted-temporary-key';
  const cloudRequests: Array<{ provider: string; model: string; apiKey?: string }> = [];
  const lateReply = Promise.withResolvers<void>();
  await page.route('http://127.0.0.1:11434/api/tags', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route('**/__models/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          envFile: 'D:/project/.env',
          providers: [
            { provider: 'deepseek', models: [], missing: ['DEEPSEEK_API_KEY'] },
            { provider: 'anthropic', models: [], missing: ['ANTHROPIC_API_KEY'] },
          ],
        },
      });
    if (path.endsWith('/complete')) {
      cloudRequests.push(route.request().postDataJSON());
      if (cloudRequests.length === 2) await lateReply.promise;
      return route.fulfill({ status: 502, json: { error: 'CLOUD_UPSTREAM_HTTP_401' } });
    }
    throw new Error('Unexpected model request');
  });
  const openAgent = () =>
    page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  await openAgent();
  const model = page.getByLabel('模型', { exact: true });
  const key = page.getByLabel('临时 API Key');
  const send = page.getByRole('button', { name: '发送', exact: true });
  await model.selectOption({ label: 'deepseek-v4-pro · DeepSeek' });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(send).toBeDisabled();
  await key.fill('  ' + temporaryKey + '  ');
  await send.click();
  await expect(page.getByRole('alert')).toContainText('检查 API Key');
  expect(cloudRequests).toHaveLength(1);
  expect(cloudRequests[0]).toMatchObject({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    apiKey: temporaryKey,
  });
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(temporaryKey);

  await page.getByRole('button', { name: '清除 Key', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(send).toBeDisabled();
  await key.fill(temporaryKey);
  await model.selectOption({ label: 'deepseek-flash · DeepSeek' });
  await expect(key).toHaveValue(temporaryKey);
  await send.click();
  await expect.poll(() => cloudRequests.length).toBe(2);
  await page.getByRole('button', { name: '清除 Key', exact: true }).click();
  lateReply.resolve();
  await expect(page.getByRole('button', { name: '取消分析', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(send).toBeDisabled();
  await key.fill(temporaryKey);
  await model.selectOption({ label: 'claude-sonnet-4-6 · Anthropic Claude' });
  await expect(key).toHaveValue('');
  await key.fill(temporaryKey);
  await page.reload();
  await openAgent();
  await expect(model).toHaveValue(JSON.stringify(['anthropic', 'claude-sonnet-4-6', '']));
  await expect(key).toHaveValue('');
  await expect(send).toBeDisabled();
  expect(cloudRequests).toHaveLength(2);
});
