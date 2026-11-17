import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { demoPose } from '../../src/utils/demo';

test(
  'capture preview fits desktop and mobile while keeping the video visible',
  { tag: '@pages' },
  async ({ page }) => {
    await page.goto('./');
    const capture = page.getByRole('region', { name: '姿态采集', exact: true });
    const preview = capture.locator('.capture-preview');
    const transport = capture.getByRole('group', { name: '采集播放器' });
    const stage = capture.locator('.pose-stage');
    const canvas = stage.locator('canvas');
    await expect(canvas).toBeVisible();
    const canvasSize = () =>
      canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
    const demoSize = await canvasSize();

    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [844, 390],
      [320, 700],
    ]) {
      await page.setViewportSize({ width, height });
      const panelBounds = (await capture.boundingBox())!;
      const previewBounds = (await preview.boundingBox())!;
      const stageBounds = (await stage.boundingBox())!;
      const transportBounds = (await transport.boundingBox())!;
      expect(stageBounds.height).toBeLessThanOrEqual(Math.max(244, height * 0.56) + 1);
      expect(stageBounds.width).toBeLessThanOrEqual(stageBounds.height * 1.9 + 1);
      expect(stageBounds.x + stageBounds.width / 2).toBeCloseTo(
        previewBounds.x + previewBounds.width / 2,
      );
      if (width > 1000) {
        expect(transportBounds.x).toBeGreaterThan(stageBounds.x + stageBounds.width);
      } else {
        expect(transportBounds.y).toBeGreaterThan(stageBounds.y + stageBounds.height);
      }
      expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect(canvas).toHaveCSS('object-fit', 'contain');
      expect(await canvasSize()).toEqual(demoSize);
    }

    await capture.getByRole('button', { name: '上传视频', exact: true }).click();
    const hint = stage.locator('.stage-empty p');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveCSS('white-space', 'normal');
    await expect(stage.locator('.stage-bottom')).toBeHidden();
    await expect(stage.getByRole('button', { name: '选择本地视频' })).toBeVisible();
    await stage.locator('input[type=file]').setInputFiles(resolve('tests/fixtures/rotate.mp4'));
    await capture.getByRole('button', { name: '开始分析', exact: true }).click();
    const progress = capture.locator('.offline-progress');
    await expect(progress).toContainText('全部完成');
    const [videoWidth, videoHeight] = await canvasSize();
    expect(videoHeight).toBeGreaterThan(videoWidth);

    for (const [width, height] of [
      [320, 700],
      [1366, 768],
    ]) {
      await page.setViewportSize({ width, height });
      const stageBounds = (await stage.boundingBox())!;
      const progressBounds = (await progress.boundingBox())!;
      expect(progressBounds.y).toBeGreaterThanOrEqual(stageBounds.y + stageBounds.height);
      expect(progressBounds.width).toBeCloseTo(stageBounds.width);
      expect(await progress.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
        await progress.evaluate((element) => element.clientWidth),
      );
      expect(await canvasSize()).toEqual([videoWidth, videoHeight]);
    }
  },
);

test('varying in-frame warnings keep the video and controls in place @pages', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const normal = demoPose(0.4);
  const short = normal.map((point, index) => {
    if (index === 27) return { ...normal[25], y: normal[25].y + 0.03 };
    if (index === 7) return { ...point, visibility: 0.4 };
    return point;
  });
  await page.route(/\/offline\.worker(?:-[\w-]+\.js|\.ts)(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `let index = 0;
      function next() {
        if (index === 30) return postMessage({type: 'done', count: 30, truncated: false});
        const warn = [2, 4, 6, 8].includes(index) || (index >= 10 && index < 16);
        const points = warn ? ${JSON.stringify(short)} : ${JSON.stringify(normal)};
        const time = Math.round(index * 1e6 / 30) / 1e6;
        index++;
        setTimeout(() => postMessage({type: 'frame', points, index, time}), 125);
      }
      onmessage = ({data}) => {
        if (data.type === 'start') {
          postMessage({ type: 'metadata', metadata: { codec: 'avc1', total: 30, sampleTotal: 30,
            firstTime: 0, lastTime: 0.966667, aspect: 4 / 3, rotation: 0, mediaTimeOffset: 0 } });
          next();
        }
        if (data.type === 'ack') next();
      };`,
    }),
  );
  await page.goto('./');
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/30fps.mp4'));
  const measured = page.evaluate(
    () =>
      new Promise<{ frame: number; y: number[]; warning: boolean; confidence: boolean }[]>(
        (resolve) => {
          const samples = [] as {
            frame: number;
            y: number[];
            warning: boolean;
            confidence: boolean;
          }[];
          const selectors = ['.pose-stage', '.center-summary', '.transport', '.correction-panel'];
          const observe = () => {
            const frame =
              document.querySelector<HTMLProgressElement>('.offline-progress progress')?.value ?? 0;
            if (frame >= 2 && frame <= 25) {
              samples.push({
                frame,
                y: selectors.map((selector) => {
                  const top =
                    document.querySelector(selector)!.getBoundingClientRect().top + window.scrollY;
                  return Math.round(top * 10) / 10;
                }),
                warning:
                  document.querySelector('.projection-note')?.textContent?.includes('较短') ??
                  false,
                confidence:
                  document.querySelector('.capture-quality')?.textContent?.includes('部分关键点') ??
                  false,
              });
            }
            if (frame >= 26) resolve(samples);
            else requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        },
      ),
  );
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  await expect(page.locator('.offline-progress')).toContainText('检测到人体 30 帧');
  const samples = await measured;
  expect(samples.length).toBeGreaterThan(10);
  for (const [index, name] of ['视频', '重心数值', '播放控制', '动作纠正'].entries())
    expect([...new Set(samples.map(({ y }) => y[index]))], `${name}垂直位置`).toEqual([
      samples[0].y[index],
    ]);
  expect(
    samples
      .filter(({ frame }) => frame <= 10)
      .every(({ warning, confidence }) => !warning && !confidence),
  ).toBe(true);
  expect(
    samples.some(
      ({ frame, warning, confidence }) => frame >= 12 && frame <= 16 && warning && confidence,
    ),
  ).toBe(true);
  expect(samples.at(-1)).toMatchObject({ warning: false, confidence: false });
});
