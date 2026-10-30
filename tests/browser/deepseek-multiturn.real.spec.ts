// Real production UI + official API; no request mocking or session injection.
import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { evaluationFingerprints } from '../../scripts/evaluate-agent.mjs';
import {
  FIXED_EVALUATIONS,
  DELIVERY_GOALS,
  assessDeliveryScope,
} from '../../src/agent/evaluation.ts';
import { resolveCitation } from '../../src/agent/runtime.ts';
import {
  fullCSV,
  downloadFile,
  verifyAudit,
  replayCSV,
  numericEqual,
  parseCSV,
  rom,
} from './files.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
test('REAL DeepSeek three turns and saved report/CSV, fixed configuration three sessions', async ({
  browser,
}, info) => {
  expect(process.env.REAL_AGENT_PROVIDER).toBe('deepseek');
  expect(info.project.use.channel).toBe('chrome');
  expect(info.project.name).toBe('production');
  const plannedSessions = Number(process.env.REAL_AGENT_SESSIONS ?? 3);
  expect(Number.isInteger(plannedSessions) && plannedSessions >= 1 && plannedSessions <= 3).toBe(
    true,
  );
  const scenario = FIXED_EVALUATIONS.find((c) => c.id === 'multi_turn_delivery')!;
  const summary: any = {
    kind: 'real-API-Chrome-three-turn-delivery',
    synthetic: true,
    startedAt: new Date().toISOString(),
    goals: DELIVERY_GOALS,
    limits: { targetRequests: 12, targetMs: 120000, sessionRequests: 36, sessionMs: 360000 },
    nativeSave: 'not_tested; Blob downloads only, native picker disabled by QA',
    plannedSessions,
    fingerprints: await evaluationFingerprints({ scenario }),
    sessions: [],
  };
  const persist = () =>
    writeFile(info.outputPath('verification.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(info.outputPath('verification.json'), JSON.stringify(summary, null, 2), {
    flag: 'wx',
  });
  for (let repetition = 1; repetition <= plannedSessions; repetition++) {
    const record: any = {
      repetition,
      passed: false,
      businessRequests: 0,
      probes: 0,
      turns: [],
      http: [],
    };
    summary.sessions.push(record);
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    let downloads = 0;
    page.on('download', () => downloads++);
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/__deepseek/complete') record.businessRequests++;
      if (new URL(req.url()).pathname === '/__deepseek/probe') record.probes++;
    });
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/__deepseek/'))
        record.http.push({ path: new URL(res.url()).pathname, status: res.status() });
    });
    try {
      await page.addInitScript(() =>
        Object.defineProperty(window, 'showSaveFilePicker', {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto('/');
      record.browser = await page.evaluate(() => navigator.userAgent);
      await expect(page.locator('.transport-time')).toContainText('00:21', { timeout: 25000 });
      await page.getByRole('button', { name: '暂停分析', exact: true }).click();
      const rows = await fullCSV(page, info, `session-${repetition}-material.csv`);
      const session = replayCSV(rows);
      const label = `session-${repetition}`;
      const material = gzipSync(
        Buffer.from(
          JSON.stringify({
            reference: {
              sessionId: rows[0].session_id,
              revision: Number(rows[0].session_revision),
            },
            parameters: session.info().parameters,
            source: 'demo',
            synthetic: true,
            frames: session.frames.map((f) => [
              f.time,
              f.rawPoints.map((p) => [p.x, p.y, p.z, p.visibility]),
            ]),
          }),
        ),
      );
      record.material = {
        file: `${label}-material.json.gz`,
        sha256: sha(material),
        rows: rows.length,
        range: session.info().range,
        parameters: session.info().parameters,
      };
      await writeFile(info.outputPath(record.material.file), material, { flag: 'wx' });
      await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
      await page.getByLabel('模型服务').selectOption('deepseek');
      const probe = page.waitForResponse(
        (res) => new URL(res.url()).pathname === '/__deepseek/probe',
      );
      await page.getByRole('button', { name: '验证并连接', exact: true }).click();
      const response = await probe;
      record.probe = { status: response.status(), ...(await response.json()) };
      await expect(page.locator('.connection-status')).toHaveText('模型已连接', { timeout: 65000 });
      for (const [index, goal] of DELIVERY_GOALS.entries()) {
        const requestsBefore = record.businessRequests;
        const downloadsBefore = downloads;
        const turn: any = { index, goal, passed: false };
        turn.requestsBefore = requestsBefore;
        record.turns.push(turn);
        await persist();
        await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goal);
        await page.getByRole('button', { name: '执行目标', exact: true }).click();
        const panel = page.locator('.run-panel').first();
        await expect(panel.locator('h3').first()).toHaveText(goal);
        await expect(panel.locator('.run-status')).not.toHaveText('执行中', { timeout: 125000 });
        await expect(
          panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
        ).toBeVisible();
        expect(downloads).toBe(downloadsBefore);
        const auditFile = await downloadFile(
          page,
          info,
          panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
          `${label}-turn-${index + 1}.audit.json`,
        );
        const audit = JSON.parse(auditFile.bytes.toString());
        const run = audit.run;
        turn.audit = {
          file: `${label}-turn-${index + 1}.audit.json`,
          sha256: sha(auditFile.bytes),
        };
        turn.status = run.status;
        turn.requests = record.businessRequests - requestsBefore;
        turn.elapsedMs = run.elapsedMs;
        turn.usage = run.usage;
        turn.responses = audit.requests.map((r: any) => r.reply?.response ?? null);
        turn.rejections = run.calls
          .filter((c: any) => !c.output.ok)
          .map((c: any) => ({
            id: c.id,
            name: c.name,
            modelArguments: c.modelArguments,
            error: c.output.error,
            scopeReview: c.scopeReview,
          }));
        turn.replayed = verifyAudit(rows, audit);
        record.conversationId ??= run.conversationId;
        expect(run.conversationId).toBe(record.conversationId);
        expect(run.conversationCosts.turns).toBe(index + 1);
        expect(run.reference.sessionId).toBe(rows[0].session_id);
        expect(run.reference.revision).toBe(Number(rows[0].session_revision));
        expect(turn.requests).toBe(run.requests.length);
        expect(turn.requests).toBeLessThanOrEqual(12);
        expect(run.elapsedMs).toBeLessThanOrEqual(120000);
        expect(run.status).toBe('completed');
        expect(run.modelProtocolVersion).toBe('3.10.0');
        expect(run.timing.application).toBe('ready');
        expect(run.timing.audit).toBe('saved');
        expect(run.completion.missing).toEqual([]);
        for (const citation of run.citations) {
          const call = run.calls.find((c: any) => c.id === citation.callId);
          expect(call.output.ok).toBe(true);
          numericEqual(resolveCitation(call.output.result, citation.path), citation.value);
        }
        const chart = run.task.spec.deliveries.view;
        turn.scopeFailures = assessDeliveryScope(run, index, chart);
        expect(turn.scopeFailures).toEqual([]);
        await expect(page.locator('#agent-chart-view')).toContainText(
          index === 0 ? '0–20 s' : '0–17 s',
        );
        await expect(page.locator('#agent-chart-view h2')).toContainText('右侧');
        if (index > 0) await expect(page.locator('#agent-chart-view h2')).not.toContainText('左侧');
        const plot = page.locator('#agent-chart-view .echart');
        await plot.hover({ position: { x: 350, y: 120 } });
        await expect(plot).toContainText('右侧');
        if (index > 0) await expect(plot).not.toContainText('左侧');
        turn.rendered = await page.locator('#agent-chart-view').innerText();
        await page
          .locator('#agent-chart-view')
          .screenshot({ path: info.outputPath(`${label}-turn-${index + 1}-chart.png`) });
        expect(await panel.locator('.artifact-card').count()).toBe(index === 2 ? 2 : 0);
        turn.passed = true;
        await persist();
      }
      const panel = page.locator('.run-panel').first();
      const reportFile = await downloadFile(
        page,
        info,
        panel.getByRole('button', { name: '保存报告 JSON', exact: true }),
        `${label}-report.json`,
      );
      const report = JSON.parse(reportFile.bytes.toString());
      const first = rom(rows, [0, 5], 'right'),
        second = rom(rows, [12, 17], 'right');
      expect(report.reference.sessionId).toBe(rows[0].session_id);
      expect(report.reference.revision).toBe(Number(rows[0].session_revision));
      expect(report.result.facts.channels.map((c: any) => c.channel)).toEqual(['right']);
      expect(report.result.facts.joint).toBe('knee');
      expect(report.result.facts.evidence.basis).toBe('filtered');
      expect(report.result.facts.evidence.interval).toEqual([0, 5]);
      expect(report.result.comparison.second.evidence.interval).toEqual([12, 17]);
      expect(report.result.facts.units.angle).toBe('deg');
      numericEqual(report.result.facts.channels[0].rom, first.value);
      expect(report.result.facts.channels[0].angle.sampleCount).toBe(first.samples);
      numericEqual(report.result.comparison.second.channels[0].rom, second.value);
      expect(report.result.comparison.second.channels[0].angle.sampleCount).toBe(second.samples);
      numericEqual(report.result.comparison.differences[0].rom, second.value - first.value);
      expect(report.result.limitations.length).toBeGreaterThan(0);
      const csvFile = await downloadFile(
        page,
        info,
        panel.getByRole('button', { name: '保存 CSV', exact: true }),
        `${label}-prepared.csv`,
      );
      const exported = parseCSV(csvFile.bytes);
      expect(exported).toEqual(rows.filter((r) => Number(r.time_s) >= 0 && Number(r.time_s) <= 17));
      replayCSV(exported);
      record.files = {
        report: { file: `${label}-report.json`, sha256: sha(reportFile.bytes), first, second },
        csv: {
          file: `${label}-prepared.csv`,
          sha256: sha(csvFile.bytes),
          rows: exported.length,
          range: [Number(exported[0].time_s), Number(exported.at(-1)!.time_s)],
          columns: Object.keys(exported[0]).length,
          angleUnit: 'deg',
          version: rows[0].session_revision,
        },
      };
      await expect(page.locator('#agent-chart-view')).toContainText('0–17 s');
      expect(record.businessRequests).toBeLessThanOrEqual(36);
      expect(record.turns.reduce((n: number, t: any) => n + t.elapsedMs, 0)).toBeLessThanOrEqual(
        360000,
      );
      const count = record.businessRequests;
      await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
      await page.getByRole('button', { name: '重算指标', exact: true }).click();
      await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
      await expect(panel.locator('.run-status')).toContainText('已过期');
      for (const name of ['保存报告 JSON', '保存 CSV'])
        await expect(panel.getByRole('button', { name, exact: true })).toBeDisabled();
      for (const button of await panel.locator('.evidence-card button').all())
        await expect(button).toBeDisabled();
      expect(record.businessRequests).toBe(count);
      record.recalculationInvalidated = true;
      record.passed = true;
    } catch (error) {
      record.error = String(error);
      const turn = record.turns.at(-1);
      if (turn && turn.elapsedMs === undefined) {
        turn.requests = record.businessRequests - turn.requestsBefore;
        turn.elapsedMs = null;
        turn.usage = { inputTokens: null, outputTokens: null };
        turn.costStatus = 'audit unavailable; request attempts counted, elapsed/token cost unknown';
      }
      await page
        .screenshot({ path: info.outputPath(`session-${repetition}-failure.png`) })
        .catch(() => {});
    } finally {
      await context.close();
      await persist();
    }
    if (!record.passed) break;
  }
  summary.completed =
    summary.sessions.length === plannedSessions && summary.sessions.every((s: any) => s.passed);
  summary.costs = {
    businessRequests: summary.sessions.reduce((n: number, s: any) => n + s.businessRequests, 0),
    businessMs: summary.sessions
      .flatMap((s: any) => s.turns)
      .reduce((n: number, t: any) => n + (t.elapsedMs ?? 0), 0),
    probes: summary.sessions.reduce((n: number, s: any) => n + s.probes, 0),
    unknownCostTurns: summary.sessions
      .flatMap((s: any) => s.turns)
      .filter((t: any) => t.elapsedMs == null).length,
  };
  await persist();
  expect(summary.completed, 'Stop on the first failed chain; no automatic reruns').toBe(true);
});
