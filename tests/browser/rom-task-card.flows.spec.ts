import { expect, test } from '@playwright/test';
import { downloadFile } from './files.ts';
import {
  confirmRom,
  finishRomDelivery,
  fixedRomSession,
  romCard,
  romGoal,
  setAbsolute,
} from './rom-card-helpers.ts';

test('ROM task card: manual while disconnected, modify and save, recalculate invalidates', async ({
  page,
}, info) => {
  const requestPaths: string[] = [];
  await page.route(
    /(?:127\.0\.0\.1:11434\/api\/(?:chat|show)$|\/__(?:models|deepseek)\/(?:complete|probe)$)/,
    (route) => {
      requestPaths.push(route.request().url());
      return route.abort();
    },
  );
  const { rows } = await fixedRomSession(page, info);
  const card = romCard(page);
  await card.getByRole('button', { name: '用当前模型草拟' }).click();
  await expect(card.getByText('模型未连接，可继续手动填写。')).toBeVisible();
  await card.getByRole('button', { name: '手动填写' }).click();
  await expect(card.getByText('请填写开始秒。').first()).toBeVisible();
  await setAbsolute(page, '统计前段', 0, 5);
  await setAbsolute(page, '统计后段', 15, 25);
  await expect(card.getByText('区间超出当前采样范围', { exact: false })).toBeVisible();
  await expect(card.getByRole('button', { name: '确认并运行比较' })).toBeDisabled();
  await setAbsolute(page, '统计后段', 15, 20);
  const first = await confirmRom(page, info, rows, 1);
  expect(first.run.romCard?.entry).toBe('manual');
  expect(first.requests).toEqual([]);
  await finishRomDelivery(page, info, rows, first);
  expect(requestPaths).toEqual([]);
});

test('ROM task card: archive-shaped scripted draft stays editable until confirmation', async ({
  page,
}, info) => {
  const requests: any[] = [];
  const raw = {
    joint: 'knee',
    side: 'both',
    basis: 'filtered',
    first: { mode: 'start', seconds: 5 },
    second: { mode: 'end', seconds: 5 },
    chart: { mode: 'cover' },
    report: false,
    csv: false,
  };
  await page.route('http://127.0.0.1:11434/api/**', async (route) => {
    const headers = { 'access-control-allow-origin': '*' };
    if (route.request().url().endsWith('/tags'))
      return route.fulfill({ headers, json: { models: [{ name: 'scripted-rom' }] } });
    if (route.request().url().endsWith('/show'))
      return route.fulfill({ headers, json: { capabilities: ['tools'] } });
    const payload = route.request().postDataJSON();
    requests.push(payload);
    const name = payload.tools[0].function.name;
    const args = requests.length === 1 ? { ...raw, second: { mode: 'end' } } : raw;
    await route.fulfill({
      headers,
      json: {
        done: true,
        message: { role: 'assistant', tool_calls: [{ function: { name, arguments: args } }] },
      },
    });
  });
  const { rows } = await fixedRomSession(page, info);
  const card = romCard(page);
  await card.getByRole('button', { name: '手动填写' }).click();
  await setAbsolute(page, '统计前段', 0, 5);
  await setAbsolute(page, '统计后段', 12, 17);
  await page
    .getByLabel('模型', { exact: true })
    .selectOption(JSON.stringify(['ollama', 'scripted-rom', 'http://127.0.0.1:11434']));
  await card.getByRole('button', { name: '用当前模型草拟' }).click();
  await card.getByLabel('模型草拟指令').fill(romGoal);
  const draftButton = card.getByRole('button', { name: '生成待审阅草稿' });
  await draftButton.click();
  await expect(card.getByRole('alert')).toContainText('已填参数保留');
  await expect(card.getByLabel('统计后段开始秒')).toHaveValue('12');
  await expect(card.getByLabel('统计后段结束秒')).toHaveValue('17');
  await card.getByText('模型草拟审计', { exact: true }).click();
  await downloadFile(
    page,
    info,
    card.getByRole('button', { name: '保存模型草拟审计' }),
    'rom-invalid-draft.json',
  );
  await draftButton.click();
  await expect(card.getByText('模型草稿 · 请核对或编辑后确认')).toBeVisible();
  await expect(card.getByLabel('统计后段类型')).toHaveValue('end');
  await expect(card.locator('[data-rom-range=second]')).toHaveText('实际区间 16.5–21.5 s');
  await expect(page.locator('#agent-chart-view')).toContainText('完整会话');
  await expect(page.locator('.run-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存 CSV', exact: true })).toHaveCount(0);
  await card.screenshot({ path: info.outputPath('rom-archive-counterexample.png') });
  await downloadFile(
    page,
    info,
    card.getByRole('button', { name: '保存模型草拟审计' }),
    'rom-raw-draft.json',
  );
  await setAbsolute(page, '统计前段', 0, 5);
  await setAbsolute(page, '统计后段', 15, 20);
  await page.getByLabel('模型', { exact: true }).selectOption('');
  const first = await confirmRom(page, info, rows, 1);
  expect(first.run.romCard?.entry).toBe('model-draft');
  expect(first.run.romCard?.draft?.request.reply?.calls[0].arguments).toEqual(raw);
  expect(first.run.romCard?.input.second).toEqual({ mode: 'absolute', start: 15, end: 20 });
  expect(first.requests).toHaveLength(1);
  await finishRomDelivery(page, info, rows, first, '上传视频');
  expect(requests.map((r) => r.tools.map((tool: any) => tool.function.name))).toEqual([
    ['draft_rom_comparison'],
    ['draft_rom_comparison'],
  ]);
});
