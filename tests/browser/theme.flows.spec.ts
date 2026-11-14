import { expect, test } from '@playwright/test';

test('theme follows the system until explicitly chosen and recolors the current charts', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('./');
  const root = page.locator('html');
  const toggle = page.getByRole('button', { name: '深色模式', exact: true });
  const guide = page.getByRole('button', { name: '使用指南', exact: true });
  const dialog = page.getByRole('dialog').locator('.el-dialog');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const metric = page.locator('.metric-primary');
  const chart = page.locator('.angle-panel canvas').first();
  const bitmap = () => chart.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

  await nav.getByRole('button', { name: '时序可视化' }).click();
  await expect(chart).toBeVisible();
  await expect(page.locator('.angle-panel .chart-loading')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(metric).toHaveCSS('background-color', 'rgb(252, 254, 250)');
  const bounds = await metric.boundingBox();
  const light = await bitmap();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(metric).toHaveCSS('background-color', 'rgb(25, 30, 27)');
  await expect.poll(bitmap).not.toBe(light);
  expect(await metric.boundingBox()).toEqual(bounds);
  await guide.click();
  await expect(dialog).toHaveCSS('background-color', 'rgb(25, 30, 27)');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await nav.getByRole('button', { name: '数据导出' }).click();
  await toggle.press('Space');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await nav.getByRole('button', { name: '时序可视化' }).click();
  await expect.poll(bitmap).toBe(light);

  await guide.click();
  await expect(dialog).toHaveCSS('background-color', 'rgb(252, 254, 250)');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await page.setViewportSize({ width: 320, height: 830 });
  const brand = (await page.locator('.brand').boundingBox())!;
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(guide).toBeFocused();
  expect((await toggle.boundingBox())!.x).toBeGreaterThanOrEqual(brand.x + brand.width);
});
