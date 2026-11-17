import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { downloadFile, fullCSV } from './files';

test('single-frame manual angle uses the rotated source and preserves automatic exports @pages', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 380, height: 760 });
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }),
  );
  await page.goto('./');
  const trigger = page.getByRole('button', { name: '复核当前帧', exact: true });
  await expect(trigger).toHaveCount(0);
  await page.getByRole('button', { name: '上传视频', exact: true }).click();
  await page.getByRole('checkbox', { name: '生成/合成视频素材（synthetic）' }).check();
  await page
    .locator('.pose-stage input[type=file]')
    .setInputFiles(resolve('tests/fixtures/rotate.mp4'));
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page.locator('.offline-progress')).toContainText('全部完成');
  const original = await fullCSV(page, info, 'automatic-before.csv');

  await page.locator('nav').getByRole('button', { name: '采集与分析', exact: true }).click();
  const timeline = page.getByRole('slider', { name: '历史帧时间轴' });
  await timeline.press('End');
  const expected = original.at(-1)!;
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '逐帧角度复核' });
  const frame = dialog.getByLabel('复核原始画面');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('width', '48');
  await expect(frame).toHaveAttribute('height', '64');
  await expect(dialog).toContainText(`${Number(expected.time_s).toFixed(6)} s`);
  const points = dialog.getByRole('group', { name: '复核点位' });
  await expect(points.getByRole('button')).toHaveCount(3);
  await expect(points.getByRole('button', { name: '第 1 点（髋）' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(points.getByRole('button', { name: '第 2 点（膝）' })).toBeDisabled();
  const save = dialog.getByRole('button', { name: '下载复核记录', exact: true });
  await expect(save).toBeDisabled();

  // Three very short segments must not yield a usable angle; clear and re-pick.
  await frame.press('Enter');
  await frame.press('Enter');
  await frame.press('Enter');
  await expect(dialog.getByRole('status')).toContainText('肢段投影过短');
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: '清空点位' }).click();
  const zoom = dialog.getByRole('group', { name: '复核画面缩放' });
  const fitted = (await frame.boundingBox())!.width;
  await zoom.getByRole('button', { name: '2×' }).click();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeGreaterThan(fitted);
  await zoom.getByRole('button', { name: '适应画面' }).click();
  const sides = dialog.getByRole('group', { name: '复核侧别' });
  await sides.getByRole('button', { name: '右侧' }).click();
  await expect(dialog.getByRole('status')).toContainText('第 1 点');
  const { width, height } = (await frame.boundingBox())!;
  for (const [x, y] of [
    [0.25, 0.5],
    [0.5, 0.5],
    [0.5, 0.75],
  ])
    await frame.click({ position: { x: width * x, y: height * y } });
  await expect(dialog).toContainText('90.00°');
  const markers = dialog.locator('.review-marker');
  await expect(markers).toHaveCount(3);
  const markerWidth = (await markers.nth(1).boundingBox())!.width;
  const { bytes } = await downloadFile(page, info, save, 'manual-angle.json');
  const measurement = JSON.parse(bytes.toString());
  expect(measurement).toMatchObject({
    basis: 'manual-points',
    joint: 'knee',
    channel: 'right',
    angleDeg: 90,
    synthetic: true,
    sessionId: expected.session_id,
    timeSeconds: Number(expected.time_s),
    frame: { width: 48, height: 64, aspect: 48 / 64 },
    automatic: {
      rawAngleDeg: expected.raw_knee_right_deg === '' ? null : Number(expected.raw_knee_right_deg),
      filteredAngleDeg:
        expected.filtered_knee_right_deg === '' ? null : Number(expected.filtered_knee_right_deg),
    },
  });
  expect(measurement.points.map((point: { label: string }) => point.label)).toEqual([
    '髋',
    '膝',
    '踝',
  ]);
  await sides.getByRole('button', { name: '左侧' }).click();
  await expect(save).toBeDisabled();
  await sides.getByRole('button', { name: '右侧' }).click();
  await expect(save).toBeEnabled();
  const vertex = points.getByRole('button', { name: '第 2 点（膝）' });
  await vertex.click();
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: '取消调整' }).click();
  await expect(save).toBeEnabled();
  await vertex.click();
  await zoom.getByRole('button', { name: '4×' }).click();
  const picture = dialog.getByRole('region', { name: '可滚动的复核画面' });
  await expect.poll(() => picture.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => picture.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await markers.nth(1).boundingBox())!.width).toBe(markerWidth);
  await frame.press('Shift+ArrowRight');
  await frame.press('Enter');
  const adjusted = await downloadFile(page, info, save, 'edited-angle.json');
  const edits = JSON.parse(adjusted.bytes.toString());
  expect(edits.points[0]).toEqual(measurement.points[0]);
  expect(edits.points[2]).toEqual(measurement.points[2]);
  expect(edits.points[1].x).toBeCloseTo(measurement.points[1].x + 10 / 48, 9);
  expect(edits.points[1].y).toBe(measurement.points[1].y);
  expect(edits.angleDeg).not.toBe(measurement.angleDeg);
  const undo = dialog.getByRole('button', { name: '撤销上一步' });
  await undo.click();
  await expect(dialog).toContainText('90.00°');

  await zoom.getByRole('button', { name: '适应画面' }).click();
  await page.setViewportSize({ width: 320, height: 760 });
  const surface = dialog.locator('.el-dialog');
  await expect.poll(async () => (await surface.boundingBox())!.width).toBeLessThanOrEqual(320);
  await expect(page.locator('.el-message')).toHaveCount(0);
  await surface.screenshot({ path: info.outputPath('review-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(async () => {
      const view = (await picture.boundingBox())!;
      const results = (await dialog.locator('.review-result').boundingBox())!;
      return results.x - (view.x + view.width);
    })
    .toBeGreaterThanOrEqual(12);
  await surface.screenshot({ path: info.outputPath('review-desktop.png') });
  await undo.click();
  await expect(save).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await fullCSV(page, info, 'automatic-after.csv')).toEqual(original);
});
