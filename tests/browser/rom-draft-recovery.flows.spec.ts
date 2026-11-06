import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { RunAudit } from '../../src/agent/audit.ts';
import type { RomDraftAudit } from '../../src/agent/romTaskCard.ts';
import { downloadFile } from './files.ts';
import { fixedRomSession, latestRom, romCard, romGoal, setAbsolute } from './rom-card-helpers.ts';

const archived = {
  joint: 'knee',
  side: 'both',
  basis: 'filtered',
  first: { mode: 'start', seconds: 5 },
  second: { mode: 'end', seconds: 5 },
  chart: { mode: 'cover' },
  report: false,
  csv: false,
};
type Outcome =
  | 'unavailable'
  | 'timeout'
  | 'cancel'
  | 'disconnect'
  | 'invalid'
  | 'manual'
  | 'version';
type Script = {
  pending: number;
  deadlines: number[];
  expire: () => void;
  reply: () => void;
  replied: number;
};
declare global {
  interface Window {
    romDraftScript: Script;
  }
}

async function scripted(page: Page, outcome: Outcome) {
  // Fetch replacement at the provider boundary, including a pending response
  // that can complete even after its signal aborts. Every model URL is blocked
  // at the network boundary as a second guard.
  await page.route(/(?:127\.0\.0\.1:11434|\/__deepseek)\//, (route) => route.abort());
  await page.addInitScript(
    ({ outcome, archived }) => {
      const nativeFetch = window.fetch.bind(window);
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      const deadline = new AbortController();
      const state: Script = {
        pending: 0,
        deadlines: [],
        expire: () => deadline.abort(),
        reply: () => {
          throw new Error('No draft request');
        },
        replied: 0,
      };
      window.romDraftScript = state;
      AbortSignal.timeout = (ms) => {
        if (ms !== 120_000) return nativeTimeout(ms);
        state.deadlines.push(ms);
        return outcome === 'timeout' ? deadline.signal : nativeTimeout(ms);
      };
      const tool = (name: string, args: unknown) =>
        Response.json({
          done: true,
          message: { role: 'assistant', tool_calls: [{ function: { name, arguments: args } }] },
        });
      window.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith('http://127.0.0.1:11434/')) return nativeFetch(input, init);
        if (url.endsWith('/show')) return Response.json({ capabilities: ['tools'] });
        if (!url.endsWith('/chat')) throw new Error(url);
        const name = JSON.parse(String(init?.body)).tools[0].function.name;
        if (name === 'connection_check') return tool(name, { echo: 'kinetic' });
        if (name !== 'draft_rom_comparison') throw new Error(name);
        state.pending++;
        if (outcome === 'unavailable') return new Response('scripted outage', { status: 503 });
        if (outcome === 'invalid') return tool(name, { ...archived, second: { mode: 'end' } });
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (outcome === 'cancel' || outcome === 'disconnect')
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          state.reply = () => {
            state.replied++;
            resolve(tool(name, archived));
          };
        });
      };
    },
    { outcome, archived },
  );
}

const runButton = (page: Page) => romCard(page).getByRole('button', { name: '确认并运行比较' });
const choose = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const nav = (page: Page, name: string) => page.locator('nav').getByRole('button', { name }).click();
const quiet = async (page: Page) => {
  await expect(page.locator('.run-panel')).toHaveCount(0);
  await expect(page.locator('#agent-chart-view')).toContainText('完整会话');
  await expect(choose(page, '保存报告 JSON')).toHaveCount(0);
  await expect(choose(page, '保存 CSV')).toHaveCount(0);
};
async function filled(page: Page, info: TestInfo, keepClock = false) {
  const { material } = await fixedRomSession(page, info, keepClock);
  expect(material).toBe('7d36f29193f07c8dcf0b8169254545eb2486814c5e691e3bb84a4093eaec0858');
  await choose(page, '手动填写').click();
  await setAbsolute(page, '统计前段', 0, 5);
  await setAbsolute(page, '统计后段', 12, 17);
}
async function relative(page: Page) {
  const card = romCard(page);
  await card.getByLabel('统计后段类型').selectOption('end');
  await card.getByLabel('统计后段时长').fill('5');
}
async function startDraft(page: Page) {
  await page.getByLabel('模型名', { exact: true }).fill('scripted-recovery');
  await choose(page, '验证并连接').click();
  await expect(page.locator('.connection-status')).toHaveText('模型已连接');
  await choose(page, '用当前模型草拟').click();
  await romCard(page).getByLabel('模型草拟指令').fill(romGoal);
  await choose(page, '生成待审阅草稿').click();
  await page.waitForFunction(() => window.romDraftScript.pending === 1);
}
async function readAudit<T>(page: Page, info: TestInfo, button: string, file: string): Promise<T> {
  return JSON.parse(
    (await downloadFile(page, info, choose(page, button).first(), file)).bytes.toString(),
  ) as T;
}
async function recover(page: Page, info: TestInfo, expected: string) {
  const card = romCard(page);
  await expect(card.getByRole('alert')).toContainText(expected, { timeout: 2500 });
  await expect(card.getByRole('alert')).toContainText('已填参数保留');
  await expect(card.getByLabel('统计前段开始秒')).toHaveValue('0');
  await expect(card.getByLabel('统计前段结束秒')).toHaveValue('5');
  await expect(card.getByLabel('统计后段开始秒')).toHaveValue('12');
  await expect(card.getByLabel('统计后段结束秒')).toHaveValue('17');
  await expect(card.getByLabel('侧别', { exact: true })).toHaveValue('both');
  await quiet(page);
  await card.getByText('模型草拟审计', { exact: true }).click();
  const attempt = await readAudit<RomDraftAudit>(
    page,
    info,
    '保存模型草拟审计',
    'draft-attempt.json',
  );
  expect(attempt.request.error).toContain(expected);
  return attempt;
}
async function verifyManual(page: Page, info: TestInfo, attempt: RomDraftAudit) {
  const card = romCard(page);
  await card.getByLabel('侧别', { exact: true }).selectOption('right');
  await setAbsolute(page, '统计后段', 15, 20);
  await runButton(page).click();
  await expect(latestRom(page).locator('.run-status')).toHaveText('已完成');
  const audit = await readAudit<RunAudit>(page, info, '保存完整本地审计', 'manual-run.json');
  expect(audit.run.romCard).toMatchObject({
    entry: 'manual',
    draftAttempt: attempt,
    input: { side: 'right', second: archivedAbsolute },
  });
  expect(audit.run.romCard?.draft).toBeUndefined();
  expect(audit.requests).toEqual([attempt.request]);
  expect(audit.run.calls.map(({ name }) => name)).toEqual([
    'get_session_info',
    'compare_intervals',
    'set_chart_view',
  ]);
}
const archivedAbsolute = { mode: 'absolute', start: 15, end: 20 };

for (const [outcome, expected] of [
  ['unavailable', 'OLLAMA_HTTP_503'],
  ['timeout', '模型草拟超时'],
  ['cancel', '模型草拟已取消'],
  ['disconnect', '模型连接已断开，草拟已取消'],
  ['invalid', 'second.seconds'],
] as const) {
  test(`ROM recovery: ${outcome} retains inputs and resumes manual confirmation`, async ({
    page,
  }, info) => {
    await scripted(page, outcome);
    await filled(page, info);
    await startDraft(page);
    if (outcome === 'timeout') {
      expect(await page.evaluate(() => window.romDraftScript.deadlines)).toEqual([120_000]);
      await page.evaluate(() => window.romDraftScript.expire());
    }
    if (outcome === 'cancel') await choose(page, '取消草拟').click();
    if (outcome === 'disconnect') await choose(page, '断开').click();
    const attempt = await recover(page, info, expected);
    if (outcome === 'timeout') await page.evaluate(() => window.romDraftScript.reply());
    await verifyManual(page, info, attempt);
  });
}

test('ROM recovery: switch to manual before a late model reply', async ({ page }, info) => {
  await scripted(page, 'manual');
  await filled(page, info);
  await startDraft(page);
  await choose(page, '手动填写').click();
  const attempt = await recover(page, info, '模型草拟已取消');
  const card = romCard(page);
  await card.getByLabel('侧别', { exact: true }).selectOption('left');
  await setAbsolute(page, '统计后段', 11, 16);
  await page.evaluate(() => window.romDraftScript.reply());
  await expect(card.getByLabel('统计后段开始秒')).toHaveValue('11');
  await expect(card.getByLabel('侧别', { exact: true })).toHaveValue('left');
  await quiet(page);
  await verifyManual(page, info, attempt);
});

test('ROM recovery: field diagnostics stay on their interval', async ({ page }, info) => {
  await filled(page, info);
  const card = romCard(page);
  await card.getByLabel('统计前段开始秒').fill('');
  await setAbsolute(page, '统计后段', 15, 25);
  await setAbsolute(page, '图表范围', 7.96, 7.99);
  for (const [field, message] of [
    ['统计前段', '请填写开始秒'],
    ['统计后段', '区间超出当前采样范围'],
    ['图表范围', '区间内没有采样帧'],
  ])
    await expect(card.getByRole('group', { name: field, exact: true })).toContainText(message);
  await expect(runButton(page)).toBeDisabled();
  await quiet(page);
  await card.screenshot({ path: info.outputPath('field-diagnostics.png') });
});

async function prepareRelative(page: Page, info: TestInfo, keepClock = false) {
  await filled(page, info, keepClock);
  await relative(page);
  await romCard(page).getByLabel('准备比较报告').check();
  await romCard(page).getByLabel('准备 CSV').check();
  await expect(romCard(page).locator('[data-rom-range=second]')).toHaveText('实际区间 16.5–21.5 s');
}
async function mutate(page: Page, change: 'recalculate' | 'source' | 'append') {
  await nav(page, '采集与分析');
  if (change === 'recalculate') {
    await choose(page, '重算指标').click();
  } else {
    if (change === 'source') {
      await choose(page, '上传视频').click();
      await choose(page, '演示模式').click();
    } else await choose(page, '开始分析').click();
    // Extend the same clock by one sample, or by 48 ticks after a source reset.
    await page.evaluate(
      (ticks) => {
        window.romQaClock.limit += ticks;
      },
      change === 'append' ? 1 : 48,
    );
    await page.waitForFunction(() => window.romQaClock.steps === window.romQaClock.limit);
    await choose(page, '暂停分析').click();
    await page.evaluate(() => {
      window.romQaClock.enabled = false;
    });
  }
  await nav(page, 'AI Agent 分析');
}
async function rereview(page: Page, info: TestInfo, change: string, count = 1) {
  const card = romCard(page);
  await expect(card.getByRole('status').filter({ hasText: '采样会话已更新' })).toBeVisible({
    timeout: 2500,
  });
  await expect(runButton(page)).toBeDisabled();
  await expect(page.locator('#agent-chart-view')).toContainText('完整会话');
  const preview = await card.locator('[data-rom-range=second]').innerText();
  await choose(page, '按当前会话重新审阅').click();
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(latestRom(page).locator('.run-status')).toHaveText('已完成');
  await expect(page.locator('.run-panel')).toHaveCount(count);
  const audit = await readAudit<RunAudit>(page, info, '保存完整本地审计', 'current-run.json');
  const { reference, calls, romCard: execution } = audit.run;
  expect(execution?.reviewed).toEqual({
    sessionId: reference.sessionId,
    revision: reference.revision,
  });
  const end = reference.range![1];
  expect(execution?.resolved?.second).toEqual([end - 5, end]);
  expect(preview).toBe(
    `实际区间 ${Number((end - 5).toPrecision(14))}–${Number(end.toPrecision(14))} s`,
  );
  if (change === 'recalculate') expect(end).toBe(21.5);
  if (change === 'append') {
    expect(end).toBe(21.5625);
    expect(reference.sampleCount).toBe(378);
  }
  if (change === 'source') {
    expect(end).toBeGreaterThan(10);
    expect(end).toBeLessThan(21.5);
  }
  expect(calls.map(({ name }) => name)).toEqual([
    'get_session_info',
    'compare_intervals',
    'set_chart_view',
    'prepare_report',
    'prepare_export',
  ]);
  for (const call of calls.slice(1))
    expect(call.arguments).toMatchObject({
      sessionId: reference.sessionId,
      revision: reference.revision,
    });
  return audit;
}

for (const change of ['recalculate', 'source', 'append'] as const) {
  for (const phase of ['drafting', 'review'] as const) {
    test(`ROM recovery: ${change} during ${phase} requires current review`, async ({
      page,
    }, info) => {
      await scripted(page, 'version');
      await prepareRelative(page, info, change !== 'recalculate');
      if (phase === 'drafting') await startDraft(page);
      await mutate(page, change);
      if (phase === 'drafting') {
        await page.evaluate(() => window.romDraftScript.reply());
        await expect(romCard(page).getByRole('alert')).toContainText('草拟期间采样会话已更新');
        await expect(romCard(page).getByLabel('统计前段类型')).toHaveValue('absolute');
        await expect(romCard(page).getByLabel('准备比较报告')).toBeChecked();
      }
      await quiet(page);
      const audit = await rereview(page, info, change);
      if (phase === 'drafting') {
        const attempt = audit.run.romCard?.draftAttempt;
        expect(attempt?.reference?.revision).toBe(377);
        expect(attempt?.request.error).toContain('草拟期间采样会话已更新');
        expect(attempt?.request.reply).toBeUndefined();
        expect(audit.requests).toEqual([attempt?.request]);
        expect(attempt?.reference?.sessionId === audit.run.reference.sessionId).toBe(
          change !== 'source',
        );
      }
    });
  }
}

test('ROM recovery: a version change in the confirmation event only reads the session', async ({
  page,
}, info) => {
  await prepareRelative(page, info);
  // Use the real controls in one synchronous stack, before Vue publishes
  // recalculation to the confirming form's props.
  await romCard(page)
    .locator('.card-form')
    .evaluate((form) => {
      const recalc = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '重算指标',
      );
      if (!recalc) throw new Error('Missing recalculate control');
      recalc.click();
      (form as HTMLFormElement).requestSubmit();
    });
  await expect(latestRom(page).locator('.run-status')).toHaveText('已过期');
  await expect(page.locator('#agent-chart-view')).toContainText('完整会话');
  await expect(choose(page, '保存报告 JSON')).toHaveCount(0);
  await expect(choose(page, '保存 CSV')).toHaveCount(0);
  const stale = await readAudit<RunAudit>(
    page,
    info,
    '保存完整本地审计',
    'rejected-confirmation.json',
  );
  expect(stale.run.romCard?.reviewed.revision).toBe(377);
  expect(stale.run.reference.revision).toBe(378);
  expect(stale.run.romCard?.resolved).toBeUndefined();
  expect(stale.run.citations).toEqual([]);
  expect(stale.run.calls.map(({ name }) => name)).toEqual(['get_session_info']);
  await rereview(page, info, 'recalculate', 2);
});
