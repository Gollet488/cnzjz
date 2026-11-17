import { expect, test } from '@playwright/test';

test(
  'angle chart opens from a stable trigger in a narrow viewport',
  { tag: '@pages' },
  async ({ page }) => {
    await page.setViewportSize({ width: 489, height: 707 });
    await page.goto('./');
    const trigger = page.getByRole('button', { name: '放大角度图表' });
    const dialog = page.getByRole('dialog', { name: '关节角度时序 · 区间探索' });
    const panel = dialog.locator('.el-dialog');
    const chart = dialog.getByRole('img', { name: '关节角度时序图' });

    await trigger.scrollIntoViewIfNeeded();
    const bounds = (await trigger.boundingBox())!;
    const icon = trigger.locator('.icon-button-icon');
    const iconBounds = (await icon.boundingBox())!;
    const x = iconBounds.x + iconBounds.width / 2;
    const y = iconBounds.y + iconBounds.height / 2;
    await page.mouse.move(x, y);
    const keepsPointer = await trigger.evaluate(
      async (button, { x, y }) => {
        const end = performance.now() + 350;
        do {
          await new Promise(requestAnimationFrame);
          if (!button.contains(document.elementFromPoint(x, y))) return false;
        } while (performance.now() < end);
        return true;
      },
      { x, y },
    );
    expect(keepsPointer).toBe(true);
    await expect(trigger.locator('.icon-button-label')).toHaveCSS('opacity', '1');
    expect((await trigger.boundingBox())!.width).toBeGreaterThan(bounds.width);
    expect(await icon.boundingBox()).toEqual(iconBounds);
    await page.mouse.click(x, y);
    await expect(panel).toBeInViewport({ ratio: 1 });
    await expect(chart.locator('canvas').first()).toBeVisible();

    await page.setViewportSize({ width: 320, height: 380 });
    await expect(panel).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        chart
          .locator('canvas')
          .first()
          .evaluate((canvas) => {
            const engine = canvas.closest('.chart-engine');
            return (
              canvas.clientWidth === engine?.clientWidth &&
              canvas.clientHeight === engine.clientHeight
            );
          }),
      )
      .toBe(true);

    const dialogBasis = dialog.getByRole('combobox', { name: '角度口径' });
    await expect(dialogBasis).toHaveValue('filtered');
    await dialogBasis.selectOption('raw');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('combobox', { name: '角度口径' })).toHaveValue('raw');
    await page.keyboard.press('Enter');
    await expect(chart.locator('canvas').first()).toBeVisible();
    await expect(dialogBasis).toHaveValue('raw');
  },
);
