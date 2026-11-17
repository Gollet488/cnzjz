import { expect, test } from '@playwright/test';

const modules = [
  { name: '采集与分析', content: '.dashboard' },
  { name: '时序可视化', content: '.point-panel' },
  { name: '姿态对比', content: '.comparison-panel' },
  { name: 'AI Agent 分析', content: '.agent-panel' },
];

test(
  'topbar buttons reveal their labels while leaving room for adjacent controls',
  { tag: '@pages' },
  async ({ page }) => {
    for (const width of [489, 320]) {
      await page.setViewportSize({ width, height: 707 });
      await page.goto('./');
      const header = page.getByRole('banner');
      const guide = header.getByRole('button', { name: '使用指南' });
      const settings = header.getByRole('button', { name: '分析设置' });
      const toggle = header.getByRole('button', { name: '深色模式' });
      const label = (button: typeof guide) => button.locator('.icon-button-label');

      await settings.hover();
      await expect(label(settings)).toHaveCSS('opacity', '1');
      await guide.hover();
      await expect(label(guide)).toHaveCSS('opacity', '1');
      await expect(label(settings)).toHaveCSS('opacity', '0');
      await expect(guide).toBeInViewport({ ratio: 1 });
      const brand = (await header.getByRole('link', { name: 'Colourful Move' }).boundingBox())!;
      expect((await toggle.boundingBox())!.x).toBeGreaterThanOrEqual(brand.x + brand.width);

      await page.mouse.move(0, 0);
      await toggle.focus();
      await page.keyboard.press('Tab');
      await expect(guide).toBeFocused();
      await expect(label(guide)).toHaveCSS('opacity', '1');
      await page.keyboard.press('Tab');
      await expect(settings).toBeFocused();
      await expect(label(settings)).toHaveCSS('opacity', '1');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: '分析与显示设置' })).toBeVisible();
    }
  },
);

for (const width of [1440, 320]) {
  test(
    `return to top fades in after scrolling past the header at ${width}px`,
    { tag: '@pages' },
    async ({ page }) => {
      const height = 480;
      await page.setViewportSize({ width, height });
      await page.emulateMedia({
        colorScheme: width === 320 ? 'dark' : 'light',
        reducedMotion: width === 320 ? 'no-preference' : 'reduce',
      });
      await page.goto('./');
      const header = page.getByRole('banner');
      const main = page.getByRole('main');
      const nav = page.getByRole('navigation', { name: '主导航' });
      const backToTop = page.getByRole('button', { name: '返回顶部', exact: true });
      const scrollTo = (top: number) =>
        page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), top);

      for (const { name, content } of modules) {
        const tab = nav.getByRole('button', { name, exact: true });
        await tab.click();
        await expect(page.locator(content)).toBeVisible();
        await expect(backToTop).toHaveCount(0);
        const headerBounds = (await header.boundingBox())!;
        const mainBounds = (await main.boundingBox())!;
        expect(mainBounds.width).toBe(headerBounds.width);

        await scrollTo(headerBounds.height + 64);
        await expect(backToTop).toHaveCount(0);
        await scrollTo(headerBounds.height + 140);
        await expect(backToTop).toBeInViewport({ ratio: 1 });
        await scrollTo(headerBounds.height + 64);
        await expect(backToTop).toBeInViewport({ ratio: 1 });
        await scrollTo(headerBounds.height + 16);
        await expect(backToTop).toHaveCount(0);
        await expect(page.locator('.back-to-top')).toBeHidden();
        await scrollTo(headerBounds.height + 140);
        await expect(backToTop).toBeInViewport({ ratio: 1 });
        await expect(backToTop).not.toHaveAttribute('data-idle');
        await expect(backToTop).toHaveCSS('border-radius', '50%');
        await expect(backToTop).toHaveCSS('translate', 'none');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        const buttonBounds = (await backToTop.boundingBox())!;
        expect(buttonBounds.width).toBe(48);
        expect(buttonBounds.height).toBe(48);
        expect(buttonBounds.y + buttonBounds.height).toBeCloseTo(height - 16);
        expect((await main.boundingBox())!.width).toBe(mainBounds.width);
        await expect(backToTop).toHaveAttribute('data-idle', 'true');
        await expect(backToTop).toHaveCSS('--return-face-opacity', '0');
        await expect(backToTop.locator('svg')).toHaveCSS('opacity', '0.5');
        expect(await backToTop.boundingBox()).toEqual(buttonBounds);

        if (width === 320) {
          await page.keyboard.press('End');
        } else {
          await page.evaluate(() => window.scrollBy({ top: -8, behavior: 'instant' }));
        }
        await expect(backToTop).not.toHaveAttribute('data-idle');
        await expect(backToTop).toBeInViewport({ ratio: 1 });
        if (width === 320) {
          await backToTop.focus();
          await expect(backToTop.locator('svg')).toHaveCSS('opacity', '1');
          await page.keyboard.press('Enter');
        } else {
          await backToTop.click();
        }

        await expect(backToTop).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await expect(header).toBeFocused();
        await expect(page.locator('.back-to-top')).toBeHidden();
        await expect(tab).toHaveAttribute('aria-current', 'page');
        await page.keyboard.press('Tab');
        await expect(header.getByRole('link', { name: 'Colourful Move' })).toBeFocused();
      }

      await nav.getByRole('button', { name: '数据导出' }).click();
      await expect(backToTop).toHaveCount(0);
    },
  );
}
