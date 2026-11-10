import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { RomDraftAudit } from '../../src/agent/romTaskCard.ts';
import { downloadFile, realAgentBudget } from './files.ts';
import {
  confirmRom,
  finishRomDelivery,
  fixedRomSession,
  romCard,
  romGoal,
  setAbsolute,
} from './rom-card-helpers.ts';

const fixedTag = 'qwen2.5:7b-instruct';
const manifest = '063edb72580111bfb8d60517fce4744732d2c2d06106da86b60535993fc0833c';
const weight = '6dba997502a27b5f0c840346f45d9d62c0a04e6eb3cf72adc6c7ceb18804f380';

test('REAL ROM task card: one fixed Qwen draft, review and local delivery', async ({
  page,
  request,
}, info) => {
  const path = process.env.ROM_REAL_PREFLIGHT;
  if (!path) throw new Error('ROM_REAL_PREFLIGHT must point to the verified fixed-model record');
  const preflight = JSON.parse(await readFile(path, 'utf8'));
  expect(preflight.weightSha256).toBe(weight);
  expect(preflight.manifestSha256).toBe(manifest);
  const address = 'http://127.0.0.1:11434';
  const inventory = await (await request.get(address + '/api/tags')).json();
  const model = inventory.models.find((m: any) => m.name === fixedTag);
  expect(model?.digest).toBe(manifest);
  expect(model?.details?.quantization_level).toBe('Q4_K_M');
  const version = await (await request.get(address + '/api/version')).json();
  const wire: { kind: string; payload: any; status?: number; reply?: any; ms?: number }[] = [];
  const summary: any = {
    browser: page.context().browser()!.version(),
    origin: 'http://127.0.0.1:5187',
    version,
    model,
    wire,
    budgets: { targetRequests: 12, targetMs: 120_000, sessionRequests: 36, sessionMs: 360_000 },
    turnBusinessRequests: [0, 0, 0],
    modelUnderstanding: 'unmeasured',
    taskCardDelivery: 'unmeasured',
    firstFailure: null,
  };
  const persist = () =>
    writeFile(info.outputPath('real-rom-verification.json'), JSON.stringify(summary, null, 2));
  const card = romCard(page);
  const budget = realAgentBudget(() => {
    void card
      .getByRole('button', { name: '取消草拟' })
      .click({ timeout: 1000 })
      .catch(() => {});
  });
  let probes = 0;
  let businessOpen = false;
  await page.route(address + '/api/chat', (route) => {
    const payload = route.request().postDataJSON();
    const kind = payload.tools?.[0]?.function?.name;
    if (kind === 'connection_check' && probes++ === 0) {
      wire.push({ kind: 'probe', payload });
      return route.continue();
    }
    if (kind !== 'draft_rom_comparison' || !businessOpen || !budget.beforeRequest())
      return route.abort();
    businessOpen = false;
    summary.turnBusinessRequests[0]++;
    wire.push({ kind: 'business', payload });
    return route.continue();
  });
  const pending: Promise<void>[] = [];
  page.on('response', (response) => {
    if (response.url() !== address + '/api/chat' || response.request().method() !== 'POST') return;
    const entry = wire.find((item) => item.status === undefined);
    if (!entry) return;
    entry.status = response.status();
    pending.push(
      (async () => {
        entry.reply = await response.json();
        entry.ms = response.request().timing().responseEnd;
      })(),
    );
  });
  try {
    const { rows, material } = await fixedRomSession(page, info);
    await page.locator('.csv-status').getByRole('button', { name: '关闭', exact: true }).click();
    summary.fixedSampleFingerprint = material;
    expect(material).toBe(preflight.fixedSampleFingerprint);
    await page.getByLabel('模型名', { exact: true }).fill(fixedTag);
    await page.getByRole('button', { name: '验证并连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toHaveText('模型已连接', { timeout: 65_000 });
    await card.getByRole('button', { name: '用当前模型草拟' }).click();
    await card.getByLabel('模型草拟指令').fill(romGoal);
    budget.startTarget();
    const started = performance.now();
    businessOpen = true;
    await card.getByRole('button', { name: '生成待审阅草稿' }).click();
    await expect(card.getByText('模型草拟审计', { exact: true })).toBeVisible({ timeout: 120_000 });
    summary.businessWallMs = performance.now() - started;
    budget.finishTarget();
    await Promise.all(pending);
    expect(wire.map((r) => r.kind)).toEqual(['probe', 'business']);
    expect(wire.every((r) => r.status === 200)).toBe(true);
    expect(wire[0].reply.message.tool_calls[0].function.arguments).toEqual({ echo: 'kinetic' });
    expect(summary.businessWallMs).toBeLessThan(120_000);
    await card.getByText('模型草拟审计', { exact: true }).click();
    const audit: RomDraftAudit = JSON.parse(
      (
        await downloadFile(
          page,
          info,
          card.getByRole('button', { name: '保存模型草拟审计' }),
          'real-raw-draft-audit.json',
        )
      ).bytes.toString(),
    );
    summary.rawDraft = audit;
    expect(audit.request.reply?.calls).toEqual(
      wire[1].reply.message.tool_calls.map(({ function: call }: any) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    );
    await expect(page.locator('.run-panel')).toHaveCount(0);
    await card.screenshot({ path: info.outputPath('real-draft-review.png') });
    if (audit.request.error) {
      summary.modelUnderstanding = 'failed';
      summary.firstFailure = audit.request.error;
      throw new Error('Draft could not be loaded for review');
    }

    const raw = audit.request.reply!.calls[0].arguments;
    const expected = {
      joint: 'knee',
      side: 'both',
      basis: 'filtered',
      first: { mode: 'absolute', start: 0, end: 5 },
      second: { mode: 'absolute', start: 15, end: 20 },
      chart: { mode: 'cover' },
      report: false,
      csv: false,
    };
    const actual = raw as typeof expected;
    const changed = (Object.keys(expected) as (keyof typeof expected)[]).filter(
      (field) => !isDeepStrictEqual(actual[field], expected[field]),
    );
    summary.modelUnderstanding = changed.length ? 'failed' : 'passed';
    summary.firstFailure = changed.length
      ? { stage: 'model_draft_semantics', fields: changed }
      : null;
    summary.correctedFields = changed;
    await persist();
    if (changed.includes('joint'))
      await card.getByLabel('关节', { exact: true }).selectOption('knee');
    if (changed.includes('side') || changed.includes('joint'))
      await card.getByLabel('侧别', { exact: true }).selectOption('both');
    if (changed.includes('basis'))
      await card.getByLabel('口径', { exact: true }).selectOption('filtered');
    if (changed.includes('first')) await setAbsolute(page, '统计前段', 0, 5);
    if (changed.includes('second')) await setAbsolute(page, '统计后段', 15, 20);
    if (changed.includes('chart')) await card.getByLabel('图表范围类型').selectOption('cover');
    if (changed.includes('report')) await card.getByLabel('准备比较报告').uncheck();
    if (changed.includes('csv')) await card.getByLabel('准备 CSV').uncheck();
    await card.screenshot({ path: info.outputPath('real-confirmed-review.png') });
    await page.getByRole('button', { name: '断开', exact: true }).click();

    const first = await confirmRom(page, info, rows, 1);
    expect(first.run.romCard?.entry).toBe('model-draft');
    expect(first.run.romCard?.input).toEqual(expected);
    expect(first.run.romCard?.draft).toEqual(audit);
    const { second, third, exportedRows, columns } = await finishRomDelivery(
      page,
      info,
      rows,
      first,
    );
    summary.turns = [first, second, third].map(({ run, requests }) => ({
      confirmed: run.romCard?.input,
      expanded: run.romCard?.resolved,
      reference: run.reference,
      tools: run.calls.map(({ name, arguments: args }) => ({ name, args })),
      citations: run.citations,
      status: run.status,
      attachedDraftRequests: requests.length,
    }));
    summary.csv = { interval: [0, 17], exportedRows, columns };
    summary.taskCardDelivery = 'passed';
  } catch (error) {
    summary.firstFailure ??= error instanceof Error ? error.message : String(error);
    summary.taskCardDelivery = 'failed';
    throw error;
  } finally {
    businessOpen = false;
    budget.close();
    summary.requestBudget = budget.snapshot();
    summary.probeRequests = probes;
    await Promise.allSettled(pending);
    await persist();
  }
});
