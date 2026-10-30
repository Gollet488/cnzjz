// Opt-in real API acceptance. No HTTP mock, data injection or parallel executor.
// First independent compare/quality must both pass before repetitions 2 and 3.
import { test, expect } from '@playwright/test';
import type { Browser, TestInfo } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { evaluationFingerprints } from '../../scripts/evaluate-agent.mjs';
import { resolveCitation } from '../../src/agent/runtime.ts';
import { MODEL_INSTRUCTION_VERSION, MODEL_SYSTEM_PROMPT } from '../../src/agent/modelProtocol.ts';
import { fullCSV, downloadFile, verifyAudit, replayCSV, numericEqual } from './files.ts';

const goals = {
  compare: '比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表',
  quality: '哪些区间不适合比较？查询全部 0–20 秒的质量和缺失情况',
};
const inference = {
  model: 'deepseek-flash',
  thinking: { type: 'disabled' },
  temperature: 0,
  max_tokens: 2048,
  stream: false,
  tool_choice: 'auto',
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('REAL DeepSeek page: independent compare/quality then fixed configuration 3/3', async ({
  browser,
}, info) => {
  expect(process.env.REAL_AGENT_PROVIDER).toBe('deepseek');
  expect(info.project.use.channel, 'Use the installed Chrome explicitly').toBe('chrome');
  const summary: any = {
    kind: 'real-API-Chrome-page-single-turn-acceptance',
    synthetic: true,
    startedAt: new Date().toISOString(),
    endpoint: 'https://api.deepseek.com',
    inference,
    goals,
    limits: { requests: 12, ms: 120000 },
    modelInstructionVersion: MODEL_INSTRUCTION_VERSION,
    probes: [],
    sessions: [],
    material:
      'Product built-in demoPose, real RAF sampling and source aspect; not Node evaluationSession and not real human input',
    fingerprints: await evaluationFingerprints({ inference, goals }),
    additionalSources: await Promise.all(
      [
        'vite.config.ts',
        'playwright.real.config.ts',
        'tests/browser/deepseek-page.real.spec.ts',
      ].map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
    ),
  };
  const persist = () =>
    writeFile(info.outputPath('verification.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(info.outputPath('verification.json'), JSON.stringify(summary, null, 2) + '\n', {
    flag: 'wx',
  });

  async function independent(
    browser: Browser,
    kind: keyof typeof goals,
    repetition: number,
    info: TestInfo,
  ) {
    const label = `${kind}-${repetition}`;
    const record: any = {
      kind,
      repetition,
      goal: goals[kind],
      passed: false,
      probes: 0,
      businessRequests: 0,
      http: [],
      startedAt: new Date().toISOString(),
    };
    summary.sessions.push(record);
    await persist();
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    let businessStarted: number | null = null;
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname;
      if (path === '/__deepseek/probe') record.probes++;
      if (path === '/__deepseek/complete') record.businessRequests++;
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
      const rows = await fullCSV(page, info, `${label}-material.csv`);
      const session = replayCSV(rows);
      record.material = {
        reference: { sessionId: rows[0].session_id, revision: Number(rows[0].session_revision) },
        parameters: session.info().parameters,
        rows: rows.length,
        range: session.info().range,
      };
      const material = gzipSync(
        Buffer.from(
          JSON.stringify({
            ...record.material,
            source: 'demo',
            synthetic: true,
            // Enough original samples to replay every tool; avoid retaining giant CSVs.
            frames: session.frames.map((f) => [
              f.time,
              f.rawPoints.map((p) => [p.x, p.y, p.z, p.visibility]),
            ]),
          }),
        ),
      );
      record.material.file = `${label}-material.json.gz`;
      record.material.sha256 = sha(material);
      await writeFile(info.outputPath(record.material.file), material, { flag: 'wx' });
      await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
      await page.getByLabel('模型服务').selectOption('deepseek');
      const probeWaiting = page.waitForResponse(
        (res) => new URL(res.url()).pathname === '/__deepseek/probe',
      );
      await page.getByRole('button', { name: '验证并连接', exact: true }).click();
      const probeResponse = await probeWaiting;
      record.probe = { status: probeResponse.status(), ...(await probeResponse.json()) };
      summary.probes.push({ label, ...record.probe });
      await expect(page.locator('.connection-status')).toHaveText('模型已连接', { timeout: 65000 });
      await expect(page.locator('.connection-note')).toContainText('DeepSeek 官方 API');
      await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goals[kind]);
      businessStarted = performance.now();
      await page.getByRole('button', { name: '执行目标', exact: true }).click();
      const panel = page.locator('.run-panel').first();
      await expect(panel.locator('.run-status')).not.toHaveText('执行中', { timeout: 125000 });
      record.observedBusinessMs = performance.now() - businessStarted;
      record.status = await panel.locator('.run-status').innerText();
      await expect(
        panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
      ).toBeVisible({ timeout: 10000 });
      const auditFile = await downloadFile(
        page,
        info,
        panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
        `${label}.audit.json`,
      );
      const audit = JSON.parse(auditFile.bytes.toString());
      record.audit = { file: `${label}.audit.json`, sha256: sha(auditFile.bytes) };
      const run = audit.run;
      record.run = run;
      record.responses = audit.requests.map((r: any) => r.reply?.response ?? null);
      record.rejections = run.calls
        .filter((c: any) => !c.output.ok)
        .map((c: any) => ({
          id: c.id,
          name: c.name,
          modelArguments: c.modelArguments,
          error: c.output.error,
          scopeReview: c.scopeReview,
        }));
      record.independentReplay = verifyAudit(rows, audit);
      await persist();
      expect(record.businessRequests).toBeLessThanOrEqual(12);
      expect(run.elapsedMs).toBeLessThanOrEqual(120000);
      expect(run.requests.length).toBe(record.businessRequests);
      expect(run.status).toBe('completed');
      expect(run.protocolVersion).toBe('2.0.0');
      expect(run.modelProtocolVersion).toBe('3.10.0');
      expect(MODEL_INSTRUCTION_VERSION).toBe('core-protocol-missing-boundary');
      expect(audit.requests[0].messages[0]).toEqual({
        role: 'system',
        content: MODEL_SYSTEM_PROMPT,
      });
      expect(run.timing.application).toBe('ready');
      expect(run.timing.audit).toBe('saved');
      const spec = run.task.spec;
      expect(spec.goalTypes).toEqual([kind === 'compare' ? 'comparison' : 'quality']);
      expect(spec.unresolved).toEqual([]);
      expect(spec.time).toBeNull();
      expect(spec.deliveries.report).toBe(false);
      expect(spec.deliveries.export).toBeNull();
      expect(
        run.calls.some((c: any) =>
          ['prepare_report', 'prepare_export', 'seek_to_time'].includes(c.name),
        ),
      ).toBe(false);
      expect(run.completion.missing).toEqual([]);
      for (const citation of run.citations) {
        const call = run.calls.find((c: any) => c.id === citation.callId);
        expect(call.output.ok).toBe(true);
        numericEqual(resolveCitation(call.output.result, citation.path), citation.value);
        expect(citation.evidenceId).toMatch(/^evidence:/);
      }
      const success = (name: string) =>
        run.calls.findLast((c: any) => c.name === name && c.output.ok);
      const requiredPaths =
        kind === 'compare'
          ? [
              '/first/channels/0/rom',
              '/first/channels/1/rom',
              '/second/channels/0/rom',
              '/second/channels/1/rom',
              '/differences/0/rom',
              '/differences/1/rom',
            ]
          : [
              '/detectedSamples',
              '/missingSamples',
              '/fullyReliableSamples',
              '/effectiveRate',
              '/meanConfidence',
              '/maxSampleGapSeconds',
            ];
      const fact = success(kind === 'compare' ? 'compare_intervals' : 'get_quality_summary');
      expect(fact).toBeTruthy();
      for (const path of requiredPaths)
        expect(run.citations.some((c: any) => c.callId === fact.id && c.path === path)).toBe(true);
      record.measured = fact.output.result;
      if (kind === 'compare') {
        expect(spec.joint).toBe('knee');
        expect(spec.basis).toBe('filtered');
        expect(spec.channels).toEqual(['left', 'right']);
        expect(spec.metrics).toEqual(['rom']);
        expect(spec.interval).toEqual([0, 5]);
        expect(spec.comparison).toEqual({ second: [15, 20], direction: 'second_minus_first' });
        expect(spec.deliveries.view).toEqual({
          joint: 'knee',
          channels: ['left', 'right'],
          basis: 'filtered',
          interval: [0, 20],
        });
        expect(fact.arguments.first).toEqual([0, 5]);
        expect(fact.arguments.second).toEqual([15, 20]);
        const view = success('set_chart_view');
        expect(
          run.citations.some((c: any) => c.callId === view.id && c.path.startsWith('/view/')),
        ).toBe(true);
        await expect(page.locator('#agent-chart-view')).toContainText('0–20 s');
        await expect(page.locator('#agent-chart-view h2')).toContainText('左侧');
        await expect(page.locator('#agent-chart-view h2')).toContainText('右侧');
        const plot = page.locator('#agent-chart-view .echart');
        await plot.hover({ position: { x: 350, y: 120 } });
        await expect(plot).toContainText('左侧');
        await expect(plot).toContainText('右侧');
        record.renderedTooltip = await plot.innerText();
        await page
          .locator('#agent-chart-view')
          .screenshot({ path: info.outputPath(`${label}-chart.png`) });
      } else {
        for (const key of ['joint', 'channels', 'basis', 'comparison'])
          expect(spec[key]).toBeNull();
        expect(spec.metrics).toEqual([]);
        expect(spec.interval).toEqual([0, 20]);
        expect(spec.deliveries.view).toBeNull();
        expect(fact.arguments.interval).toEqual([0, 20]);
        expect(fact.output.result.evidence.limitations.length).toBeGreaterThan(0);
        expect(
          run.calls.some((c: any) =>
            ['query_metrics', 'compare_intervals', 'set_chart_view'].includes(c.name),
          ),
        ).toBe(false);
      }
      record.finalChart = await page.locator('#agent-chart-view').innerText();
      expect(await panel.locator('.citation-list').last().innerText()).toBeTruthy();
      expect(await panel.locator('.artifact-card').count()).toBe(0);
      await panel.screenshot({ path: info.outputPath(`${label}-result.png`) });
      // Version changes invalidate old evidence without any new API request.
      const count = record.businessRequests;
      await page.locator('nav').getByRole('button', { name: '采集与分析' }).click();
      await page.getByRole('button', { name: '重算指标', exact: true }).click();
      await page.locator('nav').getByRole('button', { name: 'AI Agent 分析' }).click();
      await expect(panel.locator('.run-status')).toContainText('已过期');
      for (const button of await panel.locator('.evidence-card button').all())
        await expect(button).toBeDisabled();
      expect(record.businessRequests).toBe(count);
      record.recalculationInvalidated = true;
      record.passed = true;
    } catch (error) {
      record.error = String(error);
      if (businessStarted !== null && !record.observedBusinessMs)
        record.observedBusinessMs = performance.now() - businessStarted;
      await page.screenshot({ path: info.outputPath(`${label}-failure.png`) }).catch(() => {});
    } finally {
      record.endedAt = new Date().toISOString();
      await context.close();
      await persist();
    }
    return record.passed;
  }
  const firstCompare = await independent(browser, 'compare', 1, info);
  const firstQuality = await independent(browser, 'quality', 1, info);
  summary.firstGate = firstCompare && firstQuality;
  await persist();
  if (summary.firstGate)
    for (const repetition of [2, 3]) {
      const compare = await independent(browser, 'compare', repetition, info);
      const quality = await independent(browser, 'quality', repetition, info);
      if (!compare || !quality) break;
    }
  summary.completed = summary.sessions.length === 6 && summary.sessions.every((r: any) => r.passed);
  summary.costs = {
    businessRequests: summary.sessions.reduce((n: number, r: any) => n + r.businessRequests, 0),
    businessMs: summary.sessions.reduce(
      (n: number, r: any) => n + (r.run?.elapsedMs ?? r.observedBusinessMs ?? 0),
      0,
    ),
    probeRequests: summary.sessions.reduce((n: number, r: any) => n + r.probes, 0),
    inputTokens: summary.sessions.reduce(
      (n: number, r: any) => n + (r.run?.usage.inputTokens ?? 0),
      0,
    ),
    outputTokens: summary.sessions.reduce(
      (n: number, r: any) => n + (r.run?.usage.outputTokens ?? 0),
      0,
    ),
  };
  summary.endedAt = new Date().toISOString();
  await persist();
  expect(
    summary.completed,
    'Real page single-turn gate failed; all attempts and costs retained, no automatic model rerun',
  ).toBe(true);
});
