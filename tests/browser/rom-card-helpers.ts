import { expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { resolveCitation } from '../../src/agent/evidenceCatalog.ts';
import type { RunAudit } from '../../src/agent/audit.ts';
import { downloadFile, fullCSV, parseCSV, rom, verifyAudit } from './files.ts';

export const romGoal = '比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表';
export const romCard = (page: Page) => page.getByRole('region', { name: '两段 ROM 比较任务卡' });
export const latestRom = (page: Page) => page.locator('.run-panel').first();
const nav = (page: Page, name: string) => page.locator('nav').getByRole('button', { name }).click();

declare global {
  interface Window {
    romQaClock: { steps: number; limit: number; enabled: boolean };
  }
}

export async function fixedRomSession(page: Page, info: TestInfo, keepClock = false) {
  // Drive the normal demo acquisition with a fixed RAF timeline. 62.5 ms has
  // an exact binary representation, and all 217 ticks pass its 50 ms gate.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const request = window.requestAnimationFrame.bind(window);
    const state = { steps: 0, limit: 217, enabled: true };
    window.romQaClock = state;
    let last = -1;
    window.requestAnimationFrame = (callback) =>
      request((nativeTime) => {
        if (!state.enabled) {
          callback(nativeTime);
          return;
        }
        if (nativeTime !== last) {
          state.steps = Math.min(state.limit, state.steps + 1);
          last = nativeTime;
        }
        callback(100 + (state.steps - 1) * 62.5);
      });
  });
  await page.goto('/');
  await page.waitForFunction(() => window.romQaClock.steps === 217);
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  if (!keepClock)
    await page.evaluate(() => {
      window.romQaClock.enabled = false;
    });
  const rows = await fullCSV(page, info, 'fixed-rom-session.csv');
  expect(rows.map((row) => Number(row.time_s))).toEqual([
    ...Array.from({ length: 160 }, (_, i) => i * 0.05),
    ...Array.from({ length: 217 }, (_, i) => 8 + i / 16),
  ]);
  const material = createHash('sha256')
    .update(JSON.stringify(rows.map(({ session_id: _id, ...row }) => row)))
    .digest('hex');
  await info.attach('fixed-sample-fingerprint', { body: material, contentType: 'text/plain' });
  await nav(page, 'AI Agent 分析');
  return { rows, material };
}

export async function setAbsolute(page: Page, field: string, start: number, end: number) {
  const card = romCard(page);
  await card.getByLabel(field + '类型', { exact: true }).selectOption('absolute');
  await card.getByLabel(field + '开始秒', { exact: true }).fill(String(start));
  await card.getByLabel(field + '结束秒', { exact: true }).fill(String(end));
}
export async function confirmRom(
  page: Page,
  info: TestInfo,
  rows: Awaited<ReturnType<typeof fullCSV>>,
  turn: number,
) {
  const card = romCard(page);
  const run = latestRom(page);
  const second = turn === 1 ? [15, 20] : [12, 17];
  const sides = turn === 1 ? ['left', 'right'] : ['right'];
  const chart = [0, second[1]];
  await card.getByRole('button', { name: '确认并运行比较' }).click();
  await expect(run.locator('.run-status')).toHaveText('已完成');
  const visibleChart = page.locator('#agent-chart-view');
  await expect(visibleChart).toContainText(`图表区间 ${chart.join('–')} s`);
  await expect(visibleChart.getByRole('heading')).toContainText(
    `膝关节 · filtered · ${turn === 1 ? '左侧 / 右侧' : '右侧'}`,
  );
  await expect(visibleChart.locator('.echart canvas').first()).toBeVisible();
  const audit: RunAudit = JSON.parse(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存完整本地审计' }),
        `rom-turn-${turn}-audit.json`,
      )
    ).bytes.toString(),
  );
  const names = ['get_session_info', 'compare_intervals', 'set_chart_view'];
  if (turn === 3) names.push('prepare_report', 'prepare_export');
  expect(verifyAudit(rows, audit)).toEqual(names);
  expect(audit.run.calls.map((call) => call.name)).toEqual(names);
  expect(audit.run.rounds).toBe(0);
  expect(audit.run.romCard?.resolved).toEqual({ first: [0, 5], second, chart });
  expect(audit.run.romCard?.evidenceSource).toBe('browser-local-workflow');
  expect(audit.run.romCard?.reviewed).toEqual({
    sessionId: rows[0].session_id,
    revision: Number(rows[0].session_revision),
  });
  const compared = audit.run.calls[1];
  expect(compared.arguments).toMatchObject({
    joint: 'knee',
    channels: sides,
    basis: 'filtered',
    first: [0, 5],
    second,
  });
  for (const citation of audit.run.citations) {
    const call = audit.run.calls.find((c) => c.id === citation.callId);
    if (!call?.output.ok) throw new Error('Missing successful citation call');
    expect(citation.source).toBe('browser-local-workflow');
    expect(resolveCitation(call.output.result, citation.path)).toEqual(citation.value);
  }
  for (const [i, side] of sides.entries()) {
    const first = rom(rows, [0, 5], side);
    const last = rom(rows, second, side);
    expect(compared.output.ok).toBe(true);
    if (!compared.output.ok) throw new Error('Missing comparison');
    const result = compared.output.result as any;
    expect(result.first.channels[i].rom).toBeCloseTo(first.value, 8);
    expect(result.second.channels[i].rom).toBeCloseTo(last.value, 8);
    expect(result.differences[i].rom).toBeCloseTo(last.value - first.value, 8);
    expect(result.first.channels[i].angle.sampleCount).toBe(first.samples);
    expect(result.second.channels[i].angle.sampleCount).toBe(last.samples);
  }
  await visibleChart.screenshot({ path: info.outputPath(`rom-turn-${turn}-chart.png`) });
  return audit;
}

export async function finishRomDelivery(
  page: Page,
  info: TestInfo,
  rows: Awaited<ReturnType<typeof fullCSV>>,
  first: RunAudit,
  invalidate: '重算指标' | '上传视频' = '重算指标',
) {
  const card = romCard(page);
  const run = latestRom(page);
  await card.getByRole('button', { name: '修改已确认参数' }).click();
  await card.getByLabel('侧别', { exact: true }).selectOption('right');
  await setAbsolute(page, '统计后段', 12, 17);
  const changes = card.locator('.card-changes');
  await expect(changes).toContainText('侧别：左右侧 → 右侧');
  await expect(changes).toContainText('统计后段：绝对秒区间 15–20 s → 绝对秒区间 12–17 s');
  await expect(changes).toContainText('图表范围实际区间：0–20 s → 0–17 s');
  await expect(changes.locator('li')).toHaveCount(3);
  const second = await confirmRom(page, info, rows, 2);
  expect(second.run.romCard?.entry).toBe('manual');
  expect(second.run.romCard?.previousRunId).toBe(first.run.id);
  expect(second.requests).toEqual([]);
  for (const field of ['joint', 'basis', 'first', 'chart', 'report', 'csv'] as const)
    expect(second.run.romCard?.input[field]).toEqual(first.run.romCard?.input[field]);

  await card.getByRole('button', { name: '修改已确认参数' }).click();
  await card.getByLabel('准备比较报告').check();
  await card.getByLabel('准备 CSV').check();
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const third = await confirmRom(page, info, rows, 3);
  expect(third.run.romCard?.previousRunId).toBe(second.run.id);
  expect(third.requests).toEqual([]);
  expect(downloads).toEqual([`agent-audit-${third.run.id}.json`]);
  const report = JSON.parse(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存报告 JSON', exact: true }),
        'rom-report.json',
      )
    ).bytes.toString(),
  );
  expect(report.reference).toEqual(third.run.reference);
  expect(report.result.facts.evidence.interval).toEqual([0, 5]);
  expect(report.result.comparison.second.evidence.interval).toEqual([12, 17]);
  expect(report.result.facts.channels.map((c: any) => c.channel)).toEqual(['right']);
  expect(report.result.facts.channels[0].rom).toBeCloseTo(rom(rows, [0, 5], 'right').value, 8);
  expect(report.result.comparison.second.channels[0].rom).toBeCloseTo(
    rom(rows, [12, 17], 'right').value,
    8,
  );
  const csv = parseCSV(
    (
      await downloadFile(
        page,
        info,
        run.getByRole('button', { name: '保存 CSV', exact: true }),
        'rom-export-0-17.csv',
      )
    ).bytes,
  );
  expect(csv).toEqual(rows.filter((row) => Number(row.time_s) <= 17));
  await nav(page, '采集与分析');
  await page.getByRole('button', { name: invalidate, exact: true }).click();
  await nav(page, 'AI Agent 分析');
  await expect(page.locator('.run-panel .run-status').filter({ hasText: '已过期' })).toHaveCount(3);
  for (const label of ['保存报告 JSON', '保存 CSV', '定位图表 / 区间起点', '定位后段'])
    await expect(run.getByRole('button', { name: label, exact: true }).first()).toBeDisabled();
  await run.screenshot({ path: info.outputPath('rom-stale.png') });
  return { second, third, exportedRows: csv.length, columns: Object.keys(csv[0]).length };
}

// Real acceptance must verify the model's proposal before allowing the tools.
// Capture a rejected proposal via the normal cancelled-run audit.
export async function reviewExpectedFreeGoal(page: Page, turn: number) {
  const card = romCard(page);
  const pending = card.getByText(/自由目标 · 请核对或编辑(?:模型声明|本地绑定参数)后确认/);
  const status = latestRom(page).locator('.run-status');
  await expect
    .poll(
      async () =>
        (await pending.isVisible()) ||
        ((await status.count()) > 0 && (await status.innerText()) !== '执行中'),
      { timeout: 125_000 },
    )
    .toBe(true);
  if (!(await pending.isVisible())) return;
  const second = turn ? '12–17' : '15–20';
  const chart = turn ? '0–17' : '0–20';
  const correct =
    (await card.getByLabel('关节', { exact: true }).inputValue()) === 'knee' &&
    (await card.getByLabel('侧别', { exact: true }).inputValue()) === (turn ? 'right' : 'both') &&
    (await card.getByLabel('口径', { exact: true }).inputValue()) === 'filtered' &&
    (await card.getByLabel('统计前段类型', { exact: true }).inputValue()) === 'absolute' &&
    (await card.getByLabel('统计后段类型', { exact: true }).inputValue()) === 'absolute' &&
    (await card.locator('[data-rom-range="first"]').textContent()) === '实际区间 0–5 s' &&
    (await card.locator('[data-rom-range="second"]').textContent()) === `实际区间 ${second} s` &&
    (await card.getByLabel('应用图表', { exact: true }).isChecked()) &&
    (await card.getByLabel('图表沿用比较的关节、侧别和口径', { exact: true }).isChecked()) &&
    (await card.locator('[data-rom-range="chart"]').textContent()) === `实际区间 ${chart} s` &&
    !(await card.getByLabel('单独统计前段', { exact: true }).isChecked()) &&
    !(await card.getByLabel('检查前段样本质量', { exact: true }).isChecked()) &&
    (await card.getByLabel('准备比较报告', { exact: true }).isChecked()) === (turn === 2) &&
    (await card.getByLabel('准备 CSV').isChecked()) === (turn === 2) &&
    (turn !== 2 ||
      (await card.locator('[data-rom-range="exportRange"]').textContent()) === '实际区间 0–17 s');
  const confirm = card.getByRole('button', { name: '确认并运行比较', exact: true });
  if (correct && (await confirm.isEnabled())) await confirm.click();
  else await card.getByRole('button', { name: '取消本次审阅', exact: true }).click();
}
