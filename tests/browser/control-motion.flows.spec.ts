import { expect, test } from '@playwright/test';

test('source and chart controls distinguish selection, hover and keyboard focus', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');

  const sources = page.getByRole('group', { name: '采集来源' });
  const demo = sources.getByRole('button', { name: '演示模式' });
  const upload = sources.getByRole('button', { name: '上传视频' });
  await expect(demo).toHaveAttribute('aria-pressed', 'true');
  await upload.hover();
  await expect(upload).not.toHaveCSS('box-shadow', 'none');
  await upload.press('Space');
  await expect(upload).toHaveAttribute('aria-pressed', 'true');
  await expect(demo).toHaveAttribute('aria-pressed', 'false');

  await demo.press('Space');
  const chart = page.locator('.angle-panel');
  const select = chart.getByRole('combobox');
  const wrapper = chart.locator('.el-select__wrapper');
  const restingShadow = await wrapper.evaluate((element) => getComputedStyle(element).boxShadow);
  await select.focus();
  await expect(wrapper).not.toHaveCSS('box-shadow', restingShadow);
  await expect(wrapper).toHaveClass(/is-focused/);
});

test('primary button stays still as the glow follows the pointer and resets', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const button = page.getByRole('button', { name: '导出数据' });
  const bounds = (await button.boundingBox())!;
  const glow = () => button.evaluate((element) => element.style.getPropertyValue('--glow-x'));
  const position = (fraction: number) =>
    page.mouse.move(bounds.x + bounds.width * fraction, bounds.y + bounds.height / 2);

  await position(0.25);
  await expect.poll(async () => Number.parseFloat(await glow())).toBeLessThan(40);
  await expect
    .poll(() => button.evaluate((element) => getComputedStyle(element, '::after').opacity))
    .toBe('1');
  await position(0.75);
  await expect.poll(async () => Number.parseFloat(await glow())).toBeGreaterThan(60);
  await expect(button).toHaveCSS('translate', 'none');
  expect(await button.boundingBox()).toEqual(bounds);
  await page.mouse.move(0, 0);
  await expect.poll(glow).toBe('');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await position(0.75);
  await expect.poll(glow).toBe('');
  await expect(button).toHaveCSS('translate', 'none');
});

test('floating fields retain the label and expose validation with reduced-motion support', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('http://127.0.0.1:11434/api/tags', (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'AI Agent 分析' }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();

  const address = page.getByRole('textbox', { name: '本地 Ollama 地址' });
  const label = page.locator('label').filter({ hasText: /^本地 Ollama 地址$/ });
  const apply = page.getByRole('button', { name: '应用地址' });
  await address.fill('');
  await address.blur();
  await expect(label).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 13)');
  await address.focus();
  await expect(label).toHaveCSS('transform', 'matrix(0.84, 0, 0, 0.84, 0, 3)');
  await address.fill('invalid-address');
  await address.blur();
  await expect(label).toHaveCSS('transform', 'matrix(0.84, 0, 0, 0.84, 0, 3)');

  const shaking = () =>
    address.evaluate((element) => element.parentElement!.getAnimations().length);
  await apply.click();
  await expect.poll(shaking).toBe(1);
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect(address).toHaveCSS('border-color', 'rgb(169, 51, 53)');
  await expect(address).toHaveAccessibleDescription(/请输入本机 Ollama 根地址/);
  await expect.poll(shaking).toBe(0);
  await address.press('Enter');
  await expect.poll(shaking).toBe(1);

  await address.fill('http://127.0.0.1:11434');
  await expect(address).not.toHaveAttribute('aria-invalid');
  await expect(page.getByText('请输入本机 Ollama 根地址', { exact: false })).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await address.fill('invalid-address');
  await address.press('Enter');
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect.poll(shaking).toBe(0);
  await expect(address).toHaveAccessibleDescription(/请输入本机 Ollama 根地址/);
});

test('CSV download gathers cards, tracks real writes, then shows a check and resets', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    let writes = 0;
    let finishWrite: () => void;
    const writeGate = new Promise<void>((resolve) => (finishWrite = resolve));
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: async () => ({
        createWritable: async () => ({
          write: async () => {
            if (++writes === 3) await writeGate;
          },
          close: async () => {},
          abort: async () => {},
        }),
      }),
    });
    window.addEventListener('release-csv-write', () => finishWrite(), { once: true });
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: '数据导出', exact: true }).click();

  const panel = page.locator('.export-download[data-format="CSV"]');
  const trigger = panel.getByRole('button', { name: '下载 CSV 数据' });
  const progress = panel.getByRole('progressbar', { name: 'CSV 导出进度' });
  await trigger.focus();
  await trigger.press('Enter');
  await expect(panel).toHaveAttribute('data-phase', 'gathering');
  await expect(trigger).toBeDisabled();
  await expect(panel.locator('.sheet-front')).toHaveCSS('transition-delay', '0s, 0.085s');
  await expect(panel.locator('.sheet-left')).toHaveCSS('transition-delay', '0.16s, 0.245s');
  await expect(panel).toHaveAttribute('data-phase', 'progress');
  await expect(progress).toHaveAttribute('aria-valuenow', /^[1-9]\d?$/);
  await expect(panel.locator('.download-check')).toHaveCSS('opacity', '0');

  await page.evaluate(() => window.dispatchEvent(new Event('release-csv-write')));
  await expect(progress).toHaveAttribute('aria-valuenow', '100');
  await expect(panel).toHaveAttribute('data-phase', 'success');
  await expect(panel.locator('.download-check')).toHaveCSS('opacity', '1');
  await expect(panel.getByRole('status')).toContainText('已保存');
  await expect(panel).toHaveAttribute('data-phase', 'idle');
  await expect(panel.locator('.sheet-front')).toHaveCSS('opacity', '1');
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test('CSV dialog resets after cancelling the save picker and downloads with reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 780 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: () =>
        new Promise((_, reject) =>
          window.addEventListener(
            'dismiss-csv-picker',
            () => reject(new DOMException('', 'AbortError')),
            {
              once: true,
            },
          ),
        ),
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const panel = dialog.locator('.export-download[data-format="CSV"]');
  const trigger = panel.getByRole('button', { name: '逐帧数据表' });
  await trigger.click();
  await expect(panel).toHaveAttribute('data-phase', 'progress');
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(panel.locator('.download-track')).toHaveCSS('transition-duration', '0s');
  await page.evaluate(() => window.dispatchEvent(new Event('dismiss-csv-picker')));
  await expect(panel.getByRole('status')).toContainText('导出已取消');
  await expect(panel).toHaveAttribute('data-phase', 'idle');
  await expect(panel.locator('.download-check')).toHaveCSS('opacity', '0');

  await page.evaluate(() =>
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }),
  );
  const download = page.waitForEvent('download');
  await trigger.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  expect(await file.failure()).toBeNull();
  await expect(panel).toHaveAttribute('data-phase', 'success');
  await expect(panel.getByRole('status')).toContainText('已发起浏览器下载');
  await expect(panel).toHaveAttribute('data-phase', 'idle');
  await expect(trigger).toBeEnabled();
});

test('PNG export uses the shared download control on the page and in the dialog', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 780 });
  await page.addInitScript(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      window.addEventListener('encode-report', () => toBlob.call(this, callback, type, quality), {
        once: true,
      });
      document.documentElement.dataset.waitingToEncode = 'true';
    };
  });
  await page.goto('/');
  await page.locator('nav').getByRole('button', { name: '数据导出', exact: true }).click();
  const panel = page.locator('.export-download[data-format="PNG"]');
  const trigger = panel.getByRole('button', { name: '下载图片报告', exact: true });
  await trigger.press('Enter');
  await expect(trigger).toBeDisabled();
  await expect(panel.getByRole('progressbar', { name: 'PNG 导出进度' })).toBeVisible();
  await expect(panel.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await expect(page.locator('html')).toHaveAttribute('data-waiting-to-encode', 'true');

  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出本次分析' });
  const dialogPanel = dialog.locator('.export-download[data-format="PNG"]');
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialogPanel.getByRole('button', { name: '图片分析报告' })).toBeDisabled();
  await expect(dialogPanel.getByRole('status')).toHaveText('正在生成图片报告…');
  const download = page.waitForEvent('download');
  await page.evaluate(() => window.dispatchEvent(new Event('encode-report')));
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  expect(await file.failure()).toBeNull();
  await expect(dialogPanel).toHaveAttribute('data-phase', 'success');
  await expect(dialogPanel.getByRole('status')).toContainText('已发起下载');
  await expect(dialogPanel.getByRole('button', { name: '图片分析报告' })).toBeEnabled();
});
