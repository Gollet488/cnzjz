import { reviewExpectedFreeGoal } from './rom-card-helpers.ts';
import { test, expect } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { evaluationFingerprints } from '../../scripts/evaluate-agent.mjs';
import { resolveCitation } from '../../src/agent/runtime.ts';
import {
  fullCSV,
  downloadFile,
  verifyAudit,
  parseCSV,
  rom,
  numericEqual,
  realAgentBudget,
} from './files.ts';

test('REAL MODEL demonstration: compare → right/second interval → evidence/view → report/CSV', async ({
  page,
  request,
}, info) => {
  const address = process.env.OLLAMA_ADDRESS ?? 'http://127.0.0.1:11434';
  const inventory = await (await request.get(`${address}/api/tags`)).json();
  const version = await (await request.get(`${address}/api/version`)).json();
  const model = process.env.OLLAMA_MODEL ?? inventory.models[0]?.name;
  expect(
    model,
    'An already installed tools model is required; this command never downloads one',
  ).toBeTruthy();
  const summary: any = {
    id: randomUUID(),
    efficiencyScopes: ['page'],
    kind: 'real-model-page-demonstration',
    synthetic: true,
    model,
    version,
    inventory,
    userAgent: '',
    turns: [],
    checks: [],
    startedAt: new Date().toISOString(),
  };
  const persist = () =>
    writeFile(info.outputPath('real-summary.json'), JSON.stringify(summary, null, 2));
  await persist();
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }),
  );
  await page.goto('/');
  summary.userAgent = await page.evaluate(() => navigator.userAgent);
  await expect(page.locator('.transport-time')).toContainText('00:21', { timeout: 25_000 });
  await page.getByRole('button', { name: '暂停分析', exact: true }).click();
  const rows = await fullCSV(page, info, 'real-session.csv');
  summary.reference = {
    sessionId: rows[0].session_id,
    revision: Number(rows[0].session_revision),
    rows: rows.length,
  };
  await persist();
  await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  const choice = JSON.stringify(['ollama', model, 'http://127.0.0.1:11434']);
  await expect(
    page.getByLabel('模型', { exact: true }).locator('option').filter({ hasText: model }),
  ).toBeAttached();
  await page.getByLabel('模型', { exact: true }).selectOption(choice);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const settings = page.getByRole('region', { name: '模型设置' });
  await settings.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(settings.getByText('结构化工具调用通过')).toBeVisible({ timeout: 65_000 });
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  summary.connection = 'structured_probe_passed';
  await persist();
  const goals = [
    '比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表',
    '只看右侧，第二段改成 12–17 秒',
    process.env.REAL_AGENT_FLOW === 'concise_delivery'
      ? '沿用上一轮比较和图表。准备报告，并准备 0–17 秒 CSV。'
      : '准备当前比较的右膝 filtered 报告，包含前段和已修改的第二段，并准备 0–17 秒 CSV，展示覆盖两段 0–17 秒的右膝 filtered 图表',
  ];
  summary.config = {
    goals,
    model,
    version,
    measurementConditions: {
      thermalState: 'unknown',
      powerMode: null,
      modelResidency: null,
      backgroundLoad: null,
      ...(process.env.EFFICIENCY_CONDITIONS
        ? JSON.parse(await readFile(process.env.EFFICIENCY_CONDITIONS, 'utf8'))
        : {}),
      platform: process.platform,
      osRelease: release(),
      node: process.version,
      pnpm: process.env.npm_config_user_agent?.match(/pnpm\/([^ ]+)/)?.[1] ?? null,
      cpu: cpus()[0]?.model ?? null,
      totalMemoryBytes: totalmem(),
      browser: summary.userAgent,
      serviceVersion: version.version,
      modelFingerprint: inventory.models.find((m: any) => m.name === model)?.digest ?? null,
    },
  };
  summary.fingerprints = await evaluationFingerprints(summary.config);
  summary.fingerprints.material = createHash('sha256')
    .update(await readFile(info.outputPath('real-session.csv')))
    .digest('hex');
  const budget = realAgentBudget(() => {
    void page
      .getByRole('button', { name: '取消分析', exact: true })
      .click({ timeout: 2000 })
      .catch(() => {});
  });
  await page.route(`${address}/api/chat`, (route) =>
    budget.beforeRequest() ? route.continue() : route.abort(),
  );
  try {
    for (const [index, goal] of goals.entries()) {
      await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goal);
      const submitted = performance.now();
      budget.startTarget();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const panel = page.locator('.run-panel').first();
      await expect(panel.locator('h3').first()).toHaveText(goal);
      await reviewExpectedFreeGoal(page, index);
      await expect(panel.locator('.run-status')).not.toHaveText('执行中', { timeout: 250_000 });
      const turn: any = {
        goal,
        status: await panel.locator('.run-status').innerText(),
        nodeChecked: [],
      };
      await expect(
        panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
      ).toBeVisible();
      turn.observedWaitMs = performance.now() - submitted;
      const audit = JSON.parse(
        (
          await downloadFile(
            page,
            info,
            panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
            `real-turn-${index + 1}-audit.json`,
          )
        ).bytes.toString(),
      );
      try {
        turn.nodeChecked = verifyAudit(rows, audit);
        turn.nodeConsistent = turn.nodeChecked.length ? true : null;
        turn.nodeNote = turn.nodeChecked.length
          ? 'successful tools independently replayed'
          : 'no successful local tool result; numerical agreement unverified';
      } catch (error) {
        turn.nodeConsistent = false;
        turn.nodeError = String(error);
      }
      turn.run = audit.run;
      turn.citationsCorrect =
        audit.run.citations.length > 0 &&
        audit.run.citations.every((citation: any) => {
          const call = audit.run.calls.find((c: any) => c.id === citation.callId);
          if (!call?.output.ok) return false;
          try {
            numericEqual(resolveCitation(call.output.result, citation.path), citation.value);
            return true;
          } catch {
            return false;
          }
        });
      turn.finalView = await page.locator('#agent-chart-view').innerText();
      const comparison = audit.run.calls.findLast(
        (c: any) => c.name === 'compare_intervals' && c.output.ok,
      );
      turn.businessCorrect =
        comparison?.arguments.joint === 'knee' &&
        comparison.arguments.basis === 'filtered' &&
        comparison.arguments.first.join() === '0,5' &&
        comparison.arguments.second.join() === (index ? '12,17' : '15,20') &&
        comparison.arguments.channels.join() === (index ? 'right' : 'left,right') &&
        turn.finalView.includes(index ? '0–17 s' : '0–20 s') &&
        (!index || !turn.finalView.includes('左侧'));
      summary.turns.push(turn);
      // Exercise evidence location on a real returned comparison, even if the
      // model fails its completion gate. This does not change the recorded status.
      const evidence = panel
        .locator(':scope > .evidence-card')
        .filter({ hasText: '区间比较' })
        .first();
      if (await evidence.count()) {
        await evidence.getByRole('button', { name: '定位后段', exact: true }).click();
        turn.evidenceView = await page.locator('#agent-chart-view').innerText();
      }
      await page.screenshot({
        path: info.outputPath(`real-turn-${index + 1}.png`),
        fullPage: true,
      });
      summary.budget = budget.snapshot();
      await persist();
      budget.finishTarget();
      expect(turn.status, 'Stop on the first failed model target').toBe('已完成');
      expect(turn.nodeConsistent).toBe(true);
      expect(turn.businessCorrect).toBe(true);
      expect(turn.citationsCorrect).toBe(true);
      expect(audit.run.completion.missing).toEqual([]);
      expect(audit.run.reference.sessionId).toBe(summary.reference.sessionId);
      expect(audit.run.reference.revision).toBe(summary.reference.revision);
    }
  } finally {
    summary.budget = budget.snapshot();
    await persist();
    budget.close();
  }
  const panel = page.locator('.run-panel').first();
  const reportButton = panel.getByRole('button', { name: '保存报告 JSON', exact: true }).last();
  const csvButton = panel.getByRole('button', { name: '保存 CSV', exact: true }).last();
  summary.reportPrepared = (await reportButton.count()) > 0;
  summary.csvPrepared = (await csvButton.count()) > 0;
  if (summary.reportPrepared) {
    const report = JSON.parse(
      (await downloadFile(page, info, reportButton, 'real-report.json')).bytes.toString(),
    );
    let numbersCorrect = true;
    try {
      numericEqual(report.result.facts.channels[0].rom, rom(rows, [0, 5], 'right').value);
      numericEqual(
        report.result.comparison?.differences[0].rom,
        rom(rows, [12, 17], 'right').value - rom(rows, [0, 5], 'right').value,
      );
    } catch {
      numbersCorrect = false;
    }
    summary.reportCorrect =
      report.result.facts.evidence.interval.join() === '0,5' &&
      report.result.facts.channels.length === 1 &&
      report.result.facts.channels[0].channel === 'right' &&
      report.result.comparison?.second.evidence.interval.join() === '12,17' &&
      numbersCorrect;
  }
  if (summary.csvPrepared) {
    const exported = parseCSV(
      (await downloadFile(page, info, csvButton, 'real-prepared.csv')).bytes,
    );
    summary.csvCorrect =
      JSON.stringify(exported) === JSON.stringify(rows.filter((r) => Number(r.time_s) <= 17));
  }
  summary.finalView = await page.locator('#agent-chart-view').innerText();
  await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
  await page.getByRole('button', { name: '重算指标', exact: true }).click();
  await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
  await expect(panel.locator('.run-status')).toContainText('已过期');
  await expect(reportButton).toBeDisabled();
  await expect(csvButton).toBeDisabled();
  summary.staleDeliveryDisabled = true;
  summary.completed =
    summary.turns.every(
      (t: any) => t.status === '已完成' && t.nodeConsistent && t.businessCorrect,
    ) &&
    summary.reportCorrect === true &&
    summary.csvCorrect === true;
  summary.pageOracle = {
    passed: summary.completed,
    independentReplay: summary.turns.every((t: any) => t.nodeConsistent === true),
    allNecessaryTurns:
      summary.turns.length === 3 &&
      summary.turns.every((t: any) => t.status === '已完成' && t.businessCorrect === true),
    finalView: summary.turns.every((t: any) => t.businessCorrect === true),
    report: summary.reportCorrect === true,
    csv: summary.csvCorrect === true,
    evidence: [
      'real-session.csv',
      'real-turn-1-audit.json',
      'real-turn-2-audit.json',
      'real-turn-3-audit.json',
      'real-report.json',
      'real-prepared.csv',
    ],
  };
  summary.endedAt = new Date().toISOString();
  await persist();
  await info.attach('real-summary', { path: info.outputPath('real-summary.json') });
  expect(
    summary.completed,
    'Real model failed its continuous flow; raw failed runs are retained, scripted results cannot replace it',
  ).toBe(true);
});
