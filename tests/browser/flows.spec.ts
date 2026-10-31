import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readMP4 } from '../../src/video/mp4.ts';
import { resolve } from 'node:path';
import { goals, scriptedOllama } from './scripted-ollama.ts';
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
  await page.goto('/');
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
  test(`video formats: ${fixture} imports and completes real frame analysis`, async ({
    page,
  }, info) => {
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
  });
}

test('video formats: comparison accepts two converted formats and plays both', async ({ page }) => {
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
  await page.getByRole('button', { name: '从头同步分析', exact: true }).click();
  await expect
    .poll(() => videos.nth(0).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.1);
  await expect
    .poll(() => videos.nth(1).evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('video formats: cancel preparation and replace file without late writes', async ({ page }) => {
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
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles({ name: 'broken.mkv', mimeType: '', buffer: Buffer.from('not a video') });
  await expect(page.locator('.status-message')).toContainText('视频转换失败', { timeout: 60_000 });
  await page.locator('.pose-stage input[type=file]').setInputFiles({
    name: 'no-extension',
    mimeType: '',
    buffer: await readFile(resolve('tests/fixtures/30fps.mp4')),
  });
  await expect(page.locator('.status-message')).toContainText('文件已选择');
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
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

test('synthetic camera clock uses media time and releases active tracks on source change', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
  await page.evaluate(() => {
    const q = ((window as any).clockQA = { time: 10, stream: null, timer: 0 });
    Object.defineProperty(document.querySelector('.pose-stage video'), 'currentTime', {
      get: () => q.time,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const draw = () => {
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#aaa';
          ctx.fillRect(0, 0, 640, 480);
        };
        draw();
        q.stream = canvas.captureStream(30);
        q.timer = setInterval(draw, 30);
        return q.stream;
      },
    });
  });
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  const counter = page
    .locator('.metric-card')
    .filter({ hasText: '已采集帧数' })
    .locator('.metric-value');
  await expect(counter).toContainText('1帧', { timeout: 30_000 });
  await page.waitForTimeout(250);
  await expect(counter).toContainText('1帧');
  await page.evaluate(() => ((window as any).clockQA.time = 10.2));
  await expect(counter).toContainText('2帧');
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const rows = await fullCSV(page, info, 'synthetic-camera-clock.csv');
  expect(rows.map((r) => Number(r.time_s))).toEqual([0, 10.2 - 10]);
  replayFullCSV(rows);
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  expect(await page.evaluate(() => (window as any).clockQA.stream.getTracks()[0].readyState)).toBe(
    'ended',
  );
  await page.evaluate(() => clearInterval((window as any).clockQA.timer));
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
  test(`synthetic H.264 ${fixture}: real Worker, every PTS, CSV, PNG`, async ({ page }, info) => {
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
        info.project.name === 'production'
          ? /\/assets\/offline\.worker-[^/]+\.js$/.test(url)
          : /offline.worker.ts/.test(url),
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

test('clip, quoted marker, recalculate preserve snapshot and downloadable CSV', async ({
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
});

for (const provider of ['ollama', 'deepseek'] as const)
  test(`scripted protocol only (${provider}): Agent final chart, report/CSV saves, stale disabled`, async ({
    page,
  }, info) => {
    const requests = await scriptedOllama(page, provider);
    let downloads = 0;
    page.on('download', () => downloads++);
    // A real running demo supplies synthetic data. No session injection/test hook.
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(page.locator('.transport-time')).toContainText('00:21', { timeout: 25_000 });
    await page.getByRole('button', { name: '暂停分析', exact: true }).click();
    const rows = await fullCSV(page, info, 'agent-session.csv');
    replayCSV(rows);
    await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
    if (provider === 'deepseek') await page.getByLabel('模型服务').selectOption('deepseek');
    else await page.getByLabel('模型名', { exact: true }).fill('scripted-protocol-only');
    await page.getByRole('button', { name: '验证并连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toHaveText('模型已连接');
    for (const goal of goals) {
      await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goal);
      await page.getByRole('button', { name: '执行目标', exact: true }).click();
      await expect(page.locator('.run-panel').first().locator('h3').first()).toHaveText(goal);
      await expect(page.locator('.run-panel').first().locator('.run-status')).toHaveText('已完成');
      // A completed model outcome precedes the application/audit barrier.
      // Wait for the end-to-end receipt before hovering the final chart.
      await expect(
        page
          .locator('.run-panel')
          .first()
          .getByRole('button', { name: '保存完整本地审计', exact: true }),
      ).toBeVisible();
    }
    expect(downloads, 'prepare must not trigger automatic downloads').toBe(1);
    await expect(page.locator('#agent-chart-view h2')).toContainText('右侧');
    await expect(page.locator('#agent-chart-view h2')).not.toContainText('左侧');
    await expect(page.locator('#agent-chart-view')).toContainText('0–17 s');
    // The actual ECharts tooltip verifies the last rendered series, not only a call log.
    const plot = page.locator('#agent-chart-view .echart');
    await plot.hover({ position: { x: 350, y: 120 } });
    await expect(plot).toContainText('右侧');
    await expect(plot).not.toContainText('左侧');
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
    const auditFile = await downloadFile(
      page,
      info,
      run.getByRole('button', { name: '保存完整本地审计', exact: true }),
      'agent-audit.json',
    );
    const audit = JSON.parse(auditFile.bytes.toString());
    expect(audit.run.modelProtocolVersion).toBe('3.10.0');
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
    expect(audit.run.timing.computeMs).toBe(audit.run.timing.wallMs);
    expect(audit.run.conversationCosts.turns).toBe(3);
    expect(verifyAudit(rows, audit)).toEqual([
      'get_session_info',
      'compare_intervals',
      'set_chart_view',
      'prepare_report',
      'prepare_export',
    ]);
    await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
    await page.getByRole('button', { name: '重算指标', exact: true }).click();
    await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
    await expect(run.locator('.run-status')).toContainText('已过期');
    for (const name of ['保存报告 JSON', '保存 CSV'])
      await expect(run.getByRole('button', { name, exact: true })).toBeDisabled();
    expect(await run.locator('.evidence-card button').count()).toBeGreaterThan(0);
    for (const button of await run.locator('.evidence-card button').all())
      await expect(button).toBeDisabled();
    await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
    await page.getByRole('button', { name: '上传视频', exact: true }).click();
    await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
    await expect(run.locator('.run-status')).toContainText('已过期');
    for (const name of ['保存报告 JSON', '保存 CSV'])
      await expect(run.getByRole('button', { name, exact: true })).toBeDisabled();
    await info.attach('scripted-http-requests', {
      body: JSON.stringify(requests),
      contentType: 'application/json',
    });
  });

test('scripted DeepSeek cancel never applies a late response or exposes a save entry', async ({
  page,
}) => {
  await page.route('**/__deepseek/probe', (route) =>
    route.fulfill({
      json: { requests: 1, response: { model: 'deepseek-flash', systemFingerprint: null } },
    }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route('**/__deepseek/complete', async (route) => {
    requested();
    await pending;
    await route
      .fulfill({ json: { calls: [{ name: 'set_chart_view', arguments: {} }] } })
      .catch(() => {});
  });
  await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  await page.getByLabel('模型服务').selectOption('deepseek');
  await page.getByRole('button', { name: '验证并连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toHaveText('模型已连接');
  await page.getByRole('button', { name: '执行目标', exact: true }).click();
  await requestSeen;
  await page.getByRole('button', { name: '取消分析', exact: true }).click();
  release();
  await expect(page.locator('.run-status')).toHaveText('已取消');
  await expect(page.getByRole('button', { name: '保存完整本地审计', exact: true })).toBeVisible();
  await expect(page.locator('.artifact-card')).toHaveCount(0);
  await expect(page.locator('.call-record')).toHaveCount(0);
});
