import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { trackPagesAssets } from './pages-assets.ts';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream'] },
  permissions: ['camera'],
});

declare global {
  interface Window {
    terminatedWorkers: string[];
  }
}

test.describe('static Pages artifact', { tag: '@pages' }, () => {
  test.skip(({ baseURL }) => !baseURL?.endsWith('/cnzjz/'), 'Requires the strict Pages mount');

  test('starts at /cnzjz/ and returns real 404s outside the mount', async ({ page, request }) => {
    expect((await page.goto('./'))?.status()).toBe(200);
    await expect(page.getByText('合成序列 · 非推理结果', { exact: true })).toBeVisible();
    const entry = await page.locator('script[type=module][src]').getAttribute('src');
    expect(entry).toMatch(/^\/cnzjz\/assets\//);
    for (const path of [
      '/',
      entry!.replace('/cnzjz', ''),
      '/pose-inference.worker.js',
      '/mediapipe/pose_landmarker_lite.task',
      '/mediapipe/wasm/vision_wasm_internal.wasm',
      '/ffmpeg/worker.js',
      '/ffmpeg/ffmpeg-core.js',
      '/ffmpeg/ffmpeg-core.wasm',
      '/cnzjz/missing.js',
    ])
      expect((await request.get(path)).status(), path).toBe(404);
  });

  test('two-video comparison survives a slow FFmpeg WASM response', async ({ page }) => {
    await page.route('**/ffmpeg/ffmpeg-core.wasm', async (route) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 17_000));
      await route.continue();
    });
    await page.goto('./');
    await page.locator('nav').getByRole('button', { name: '姿态对比', exact: true }).click();
    const panel = page.locator('.comparison-panel');
    const files = panel.locator('input[type=file]');
    await files.nth(0).setInputFiles(resolve('tests/fixtures/format.avi'));
    await files.nth(1).setInputFiles(resolve('tests/fixtures/format.webm'));
    await expect(panel.locator('[role=status]')).toHaveText(
      ['已在本机转换，使用转换后时间轴。', '已在本机转换，使用转换后时间轴。'],
      { timeout: 30_000 },
    );
  });

  for (const failure of ['worker 404', 'WASM 404', 'unresponsive initialization'] as const) {
    test(`FFmpeg: ${failure} closes the worker and allows AVI retry`, async ({ page }, info) => {
      const resource =
        failure === 'worker 404' ? '**/ffmpeg/worker.js' : '**/ffmpeg/ffmpeg-core.wasm';
      const stalled = failure === 'unresponsive initialization';
      const { promise: hold, resolve: release } = Promise.withResolvers<void>();
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        const urls = new WeakMap<Worker, string>();
        window.terminatedWorkers = [];
        window.Worker = class extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            urls.set(this, String(url));
          }
          override terminate() {
            super.terminate();
            window.terminatedWorkers.push(urls.get(this)!);
          }
        };
      });
      await page.route(resource, async (route) => {
        if (stalled) await hold;
        await route.fulfill({ status: 404, body: 'deliberately unavailable' }).catch((error) => {
          if (!stalled) throw error;
        });
      });
      try {
        await page.goto('./');
        await page.getByRole('button', { name: '暂停分析', exact: true }).click();
        await page.getByRole('button', { name: '上传视频', exact: true }).click();
        const input = page.locator('.pose-stage input[type=file]');
        const avi = resolve('tests/fixtures/format.avi');
        const loading = page.waitForRequest(resource);
        const start = Date.now();
        await input.setInputFiles(avi);
        const requested = await loading;
        expect(new URL(requested.url()).pathname).toMatch(/^\/cnzjz\/ffmpeg\//);
        const status = page.locator('.status-message');
        await expect(status).toContainText(
          stalled ? '视频转换器初始化超时' : '视频转换器加载失败',
          { timeout: stalled ? 55_000 : 8_000 },
        );
        const elapsedMs = Date.now() - start;
        const httpStatus = stalled ? null : (await requested.response())?.status();
        if (!stalled) expect(httpStatus).toBe(404);
        const worker = new URL('ffmpeg/worker.js', page.url()).href;
        await expect
          .poll(() =>
            page.evaluate(
              (url) => window.terminatedWorkers.filter((entry) => entry === url),
              worker,
            ),
          )
          .toEqual([worker]);
        await info.attach('converter-failure', {
          body: JSON.stringify({
            failure,
            resource: requested.url(),
            httpStatus,
            worker,
            elapsedMs,
            message: await status.innerText(),
            workerClosed: true,
          }),
          contentType: 'application/json',
        });
        await expect(page.getByRole('button', { name: '取消准备', exact: true })).toBeHidden();
        await page.unroute(resource);
        await input.setInputFiles(avi);
        await expect(status).toContainText('视频已在本机转换');
        release();
        await page.getByRole('button', { name: '开始分析', exact: true }).click();
        await expect(page.locator('.offline-progress')).toContainText('全部完成');
        await expect(page.locator('.offline-progress')).toContainText('30 / 30 帧');
      } finally {
        release();
      }
    });
  }
});

test.describe('Pages camera with a browser-generated device', { tag: '@pages' }, () => {
  test('loads the pose engine and releases the stream on source change', async ({ page }, info) => {
    const checkAssets = trackPagesAssets(page, info);
    await page.goto('./');
    await page.getByRole('button', { name: '暂停分析', exact: true }).click();
    await page.getByRole('button', { name: '实时摄像头', exact: true }).click();
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    const video = page.locator('.pose-stage video');
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(0.5);
    const track = await video.evaluateHandle(
      (el: HTMLVideoElement) => (el.srcObject as MediaStream).getVideoTracks()[0],
    );
    const count = page
      .locator('.metric-card')
      .filter({ hasText: '已采集帧数' })
      .locator('.metric-value');
    await expect.poll(async () => Number.parseInt(await count.innerText(), 10)).toBeGreaterThan(3);
    await page.getByRole('button', { name: '演示模式', exact: true }).click();
    await expect.poll(() => track.evaluate((t) => t.readyState)).toBe('ended');
    await track.dispose();
    await checkAssets(
      /\/mediapipe\/wasm\/[^/]+\.wasm$/,
      /\/mediapipe\/pose_landmarker_lite\.task$/,
    );
  });
});
