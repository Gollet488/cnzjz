import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveCitation } from '../../src/agent/evidenceCatalog.ts';
import type { RunAudit } from '../../src/agent/audit.ts';
import { isAbsolute, relative, resolve } from 'node:path';
import { readMP4 } from '../../src/video/mp4.ts';
import {
  downloadFile,
  fullCSV,
  numericEqual,
  parseCSV,
  realAgentBudget,
  verifyAudit,
  replayFullCSV,
} from './files.ts';
import { latestRom, romCard } from './rom-card-helpers.ts';

type Span = readonly [number, number];
type Basis = 'raw' | 'filtered';
type Side = 'left' | 'right';
type Turn = {
  goal: string;
  basis: Basis;
  sides: readonly Side[];
  first: Span;
  second: Span;
  export?: Span;
  limited?: boolean;
};
type Row = Record<string, string>;
const spanText = (span: Span) => span.join('–') + ' s';
const subset = (rows: Row[], [start, end]: Span) =>
  rows.filter((row) => Number(row.time_s) >= start && Number(row.time_s) <= end);

function kneeOracle(rows: Row[], basis: Basis, side: Side) {
  const angles = [];
  for (const row of rows) {
    const points = ['hip', 'knee', 'ankle'].map((joint) => {
      const key = `${basis}_${side}_${joint}`;
      return [row[key + '_x'], row[key + '_y'], row[key + '_visibility']];
    });
    let angle: number | null = null;
    if (
      (basis === 'raw' || row[`raw_knee_${side}_deg`] !== '') &&
      points.every(
        ([x, y, visibility]) =>
          x !== '' &&
          y !== '' &&
          Number(visibility) > 0 &&
          Number(visibility) >= Number(row.confidence_threshold),
      )
    ) {
      const [a, b, c] = points.map(([x, y]) => [Number(x) * Number(row.source_aspect), Number(y)]);
      const u = [a[0] - b[0], a[1] - b[1]];
      const v = [c[0] - b[0], c[1] - b[1]];
      if (Math.min(Math.hypot(...u), Math.hypot(...v)) >= 0.005)
        angle =
          (Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]) * 180) /
          Math.PI;
    }
    const exported = row[`${basis}_knee_${side}_deg`];
    if (angle === null) expect(exported).toBe('');
    else {
      numericEqual(Number(exported), angle);
      angles.push(angle);
    }
  }
  return {
    valid: angles.length,
    coverage: angles.length / rows.length,
    rom: angles.length >= 2 ? Math.max(...angles) - Math.min(...angles) : null,
  };
}

const initial = {
  basis: 'filtered',
  sides: ['left', 'right'],
  first: [5, 10],
  second: [15, 20],
} as const;
const revised = { basis: 'filtered', sides: ['right'], first: [5, 10], second: [12, 17] } as const;
const limited = {
  basis: 'raw',
  sides: ['right'],
  first: [5.01, 10.01],
  second: [35.01, 40.01],
  limited: true,
} as const;
const flows = {
  standard: [
    { ...initial, goal: '比较 filtered 左右膝 5–10 秒与 15–20 秒的 ROM，并展示覆盖两段的图表' },
    { ...revised, goal: '只看右侧，第二段改成 12–17 秒' },
    { ...revised, goal: '保持比较参数，准备报告和 5–17 秒 CSV', export: [5, 17] },
  ],
  paraphrase: [
    {
      ...initial,
      goal: '用 filtered 口径看双膝 ROM：对照 5 到 10 秒和 15 到 20 秒，图表涵盖这两段。',
    },
    { ...revised, goal: '改为右膝，后段换成第 12 到第 17 秒，前段照旧。' },
    {
      ...revised,
      goal: '沿用刚才的对照和图表，准备一份报告和 5 到 17 秒的 CSV。',
      export: [5, 17],
    },
  ],
  limited: [
    {
      ...limited,
      goal: '比较 raw 右膝 5.01–10.01 秒与 35.01–40.01 秒的 ROM，并展示覆盖两段的图表',
    },
    { ...limited, goal: '保持比较参数，准备报告和 5.01–40.01 秒 CSV', export: [5.01, 40.01] },
  ],
} satisfies Record<string, Turn[]>;

type HumanRun = {
  page: Page;
  info: TestInfo;
  rows: Row[];
  panel: Locator;
  chart: Locator;
  summary: any;
  persist: () => Promise<void>;
  submit: (
    goal: string,
    review?: (result: any, status: Locator) => Promise<void>,
  ) => Promise<{ audit: RunAudit; result: any }>;
};

function humanTest(
  flow: string,
  staleActions: string[],
  exercise: (run: HumanRun) => Promise<void>,
) {
  test(`authorized human video and real Ollama: ${flow}`, async ({ page, request }, info) => {
    const reportLocation = relative(resolve('.qa/human-agent/runs'), info.outputDir);
    expect(
      reportLocation && !reportLocation.startsWith('..') && !isAbsolute(reportLocation),
      'Human browser artifacts must stay in the ignored .qa/human-agent/runs directory',
    ).toBe(true);
    const path = process.env.HUMAN_VIDEO_PATH!;
    const media = await readFile(path);
    const hash = createHash('sha256').update(media).digest('hex');
    expect(hash).toBe('4619fc6b5571dfeac86420cea76e3ee27506c4b8c571ad0058d72c3138c38303');
    const source = await readMP4(new Blob([media]));
    const address = 'http://127.0.0.1:11434';
    const model = 'qwen2.5:7b-instruct';

    const summary: any = {
      flow,
      hash,
      model,
      browser: page.context().browser()!.version(),
      startedAt: new Date().toISOString(),
      turns: [],
      downloads: [],
      transport: [],
      pageErrors: [],
      passed: false,
    };
    const persist = () =>
      writeFile(info.outputPath('summary.json'), JSON.stringify(summary, null, 2));
    const nav = (name: string) =>
      page.locator('nav').getByRole('button', { name, exact: true }).click();
    const budget = realAgentBudget(() => {
      void page
        .getByRole('button', { name: '取消分析', exact: true })
        .click({ timeout: 2000 })
        .catch(() => {});
    });
    await persist();
    page.on('pageerror', (error) => summary.pageErrors.push(error.message));
    page.on('download', (download) => summary.downloads.push(download.suggestedFilename()));
    const responses: Promise<void>[] = [];
    page.on('response', (response) => {
      if (response.url() !== `${address}/api/chat` || response.request().method() !== 'POST')
        return;
      responses.push(
        response.json().then(
          (body) => {
            summary.transport.push({
              status: response.status(),
              requestedModel: response.request().postDataJSON()?.model,
              returnedModel: body.model,
            });
          },
          () => {
            summary.transport.push({ status: response.status(), unreadableBody: true });
          },
        ),
      );
    });
    try {
      const version = await request.get(`${address}/api/version`);
      const inventory = await request.get(`${address}/api/tags`, {
        headers: { Origin: new URL(info.project.use.baseURL!).origin },
      });
      expect(version.ok(), 'Ollama version endpoint').toBe(true);
      expect(inventory.ok(), 'Ollama inventory and allowed preview origin').toBe(true);
      summary.version = (await version.json()).version;
      summary.modelDigest = (await inventory.json()).models.find(
        (m: any) => m.name === model,
      )?.digest;
      expect(
        summary.modelDigest,
        'Install the previously accepted Ollama model locally',
      ).toBeTruthy();
      await persist();
      await page.addInitScript(() => {
        Object.defineProperty(window, 'showSaveFilePicker', {
          value: undefined,
          configurable: true,
        });
      });
      await page.goto('/');
      summary.entry = await page.locator('script[type=module]').first().getAttribute('src');
      expect(summary.entry).toMatch(/^\/assets\/index-.*\.js$/);
      await page.getByRole('button', { name: '上传视频', exact: true }).click();
      await page.locator('.pose-stage input[type=file]').setInputFiles(path);
      await page.getByRole('button', { name: '开始分析', exact: true }).click();
      await expect(page.locator('.offline-progress')).toContainText('全部完成', {
        timeout: 160_000,
      });
      const rows = await fullCSV(page, info, 'human-session.csv');
      expect(rows).toHaveLength(2011);
      expect(rows.map((row) => Number(row.time_s))).toEqual(
        source.presentation.map((frame) => frame.timestamp / 1e6),
      );
      expect(
        new Set(
          rows.map(
            (row) =>
              `${row.source}/${row.synthetic}/${row.acquisition_mode}/${row.acquisition_status}`,
          ),
        ),
      ).toEqual(new Set(['file/false/webcodecs/completed']));
      summary.fullCSVReplay = replayFullCSV(rows);
      summary.session = {
        id: rows[0].session_id,
        revision: Number(rows[0].session_revision),
        rows: rows.length,
        range: [Number(rows[0].time_s), Number(rows.at(-1)!.time_s)],
      };
      await nav('AI Agent 分析');
      const choice = page.getByLabel('模型', { exact: true });
      await expect(choice.locator('option').filter({ hasText: model })).toBeAttached();
      await choice.selectOption(JSON.stringify(['ollama', model, address]));
      await page.getByRole('button', { name: '模型设置', exact: true }).click();
      const settings = page.getByRole('region', { name: '模型设置' });
      await settings.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(settings.getByText('结构化工具调用通过')).toBeVisible({ timeout: 65_000 });
      await page.getByRole('button', { name: '模型设置', exact: true }).click();
      summary.structuredProbe = 'passed';
      await page.route(`${address}/api/chat`, (route) =>
        route.request().method() !== 'POST' || budget.beforeRequest()
          ? route.continue()
          : route.abort(),
      );
      const panel = latestRom(page);
      const chart = page.locator('#agent-chart-view');
      const submit: HumanRun['submit'] = async (goal, review) => {
        const result: any = { goal };
        summary.turns.push(result);
        await page.getByRole('textbox', { name: '分析目标或后续修改' }).fill(goal);
        budget.startTarget();
        const before = summary.downloads.length;
        const responseStart = responses.length;
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect(panel.locator('h3').first()).toHaveText(goal);
        const status = panel.locator('.run-status');
        await review?.(result, status);
        await expect(status).not.toHaveText('执行中', { timeout: 135_000 });
        result.status = await status.innerText();
        expect(summary.downloads.slice(before)).toEqual([]);
        const auditName = `turn-${summary.turns.length}-audit.json`;
        const audit: RunAudit = JSON.parse(
          (
            await downloadFile(
              page,
              info,
              panel.getByRole('button', { name: '保存完整本地审计', exact: true }),
              auditName,
            )
          ).bytes.toString(),
        );
        const { run } = audit;
        result.audit = auditName;
        result.conversationId = audit.conversationId;
        result.id = run.id;
        result.parameterSource = run.romReview?.parameterSource ?? 'model';
        result.requests = audit.requests.length;
        result.networkRequests = budget.snapshot().targetRequests;
        result.calls = run.calls.map((call) => ({
          name: call.name,
          error: call.output.ok ? undefined : call.output.error.code,
        }));
        result.completion = run.completion;
        result.message = run.message;
        await Promise.all(responses.slice(responseStart));
        result.transport = summary.transport.slice(responseStart);
        await persist();
        budget.finishTarget();
        expect(result.requests).toBeGreaterThan(0);
        expect(result.requests).toBe(result.networkRequests);
        expect(run.model).toBe(model);
        expect(run.provider).toBe('ollama-local');
        expect(result.transport).toEqual(
          Array.from({ length: result.requests }, () => ({
            status: 200,
            requestedModel: model,
            returnedModel: model,
          })),
        );
        result.replayed = verifyAudit(rows, audit);
        for (const citation of run.citations) {
          const call = run.calls.find((item) => item.id === citation.callId);
          if (!call?.output.ok)
            throw new Error(`Missing successful evidence call ${citation.callId}`);
          numericEqual(resolveCitation(call.output.result, citation.path), citation.value);
        }
        result.citationCount = run.citations.length;
        await persist();
        return { audit, result };
      };
      await exercise({ page, info, rows, panel, chart, summary, submit, persist });
      const requestsBeforeRecalculation = budget.snapshot().requests;
      await nav('采集与分析');
      await page.getByRole('button', { name: '重算指标', exact: true }).click();
      const recalculated = await fullCSV(page, info, 'human-recalculated.csv');
      expect(recalculated[0].session_id).toBe(summary.session.id);
      expect(Number(recalculated[0].session_revision)).toBeGreaterThan(summary.session.revision);
      expect(recalculated.map((row) => row.time_s)).toEqual(rows.map((row) => row.time_s));
      await nav('AI Agent 分析');
      await expect(
        page.locator('.run-panel .run-status').filter({ hasText: '已过期' }),
      ).toHaveCount(summary.turns.length);
      for (const label of staleActions) {
        const buttons = page
          .locator('.run-panel')
          .getByRole('button', { name: label, exact: true });
        expect(await buttons.count()).toBeGreaterThan(0);
        for (const button of await buttons.all()) await expect(button).toBeDisabled();
      }
      for (const button of await page.locator('.run-panel .evidence-card button').all())
        await expect(button).toBeDisabled();
      expect(budget.snapshot().requests).toBe(requestsBeforeRecalculation);
      await panel.screenshot({ path: info.outputPath('stale.png') });
      summary.stale = {
        revision: Number(recalculated[0].session_revision),
        runs: summary.turns.length,
        saveAndLocateDisabled: true,
      };
      expect(summary.pageErrors).toEqual([]);
      summary.passed = true;
    } finally {
      summary.budget = budget.snapshot();
      budget.close();
      summary.endedAt = new Date().toISOString();
      await persist();
    }
  });
}

for (const [flow, turns] of Object.entries<Turn[]>(flows)) {
  humanTest(
    flow,
    ['保存报告 JSON', '保存 CSV', '定位图表 / 区间起点', '定位后段'],
    async ({ page, info, rows, panel, chart, summary, submit, persist }) => {
      for (const [index, turn] of turns.entries()) {
        const chartSpan: Span = [turn.first[0], turn.second[1]];
        const { audit, result } = await submit(turn.goal, async (result, status) => {
          result.expected = turn;
          const card = romCard(page);
          const pending = card.getByText(/自由目标 · 请核对或编辑(?:模型声明|本地绑定参数)后确认/);
          await expect
            .poll(
              async () => (await pending.isVisible()) || (await status.innerText()) !== '执行中',
              { timeout: 135_000 },
            )
            .toBe(true);
          if (await pending.isVisible()) {
            result.proposal = {
              joint: await card.getByLabel('关节', { exact: true }).inputValue(),
              side: await card.getByLabel('侧别', { exact: true }).inputValue(),
              basis: await card.getByLabel('口径', { exact: true }).inputValue(),
              first: await card.locator('[data-rom-range="first"]').textContent(),
              second: await card.locator('[data-rom-range="second"]').textContent(),
              chart: await card.locator('[data-rom-range="chart"]').textContent(),
              showChart: await card.getByLabel('应用图表', { exact: true }).isChecked(),
              linkChart: await card
                .getByLabel('图表沿用比较的关节、侧别和口径', { exact: true })
                .isChecked(),
              report: await card.getByLabel('准备比较报告').isChecked(),
              csv: await card.getByLabel('准备 CSV').isChecked(),
              exportRange: turn.export
                ? await card.locator('[data-rom-range="exportRange"]').textContent()
                : null,
              separateMetrics: await card.getByLabel('单独统计前段', { exact: true }).isChecked(),
              quality: await card.getByLabel('检查前段样本质量', { exact: true }).isChecked(),
            };
            const expectedProposal = {
              joint: 'knee',
              side: turn.sides.length === 2 ? 'both' : turn.sides[0],
              basis: turn.basis,
              first: '实际区间 ' + spanText(turn.first),
              second: '实际区间 ' + spanText(turn.second),
              chart: '实际区间 ' + spanText(chartSpan),
              showChart: true,
              linkChart: true,
              report: !!turn.export,
              csv: !!turn.export,
              exportRange: turn.export ? '实际区间 ' + spanText(turn.export) : null,
              separateMetrics: false,
              quality: false,
            };
            const confirm = card.getByRole('button', { name: '确认并运行比较', exact: true });
            result.confirmed =
              JSON.stringify(result.proposal) === JSON.stringify(expectedProposal) &&
              (await confirm.isEnabled());
            if (result.confirmed) await confirm.click();
            else {
              await card.screenshot({
                path: info.outputPath(`turn-${index + 1}-rejected-proposal.png`),
              });
              await card.getByRole('button', { name: '取消本次审阅', exact: true }).click();
            }
          }
        });
        const run = audit.run as any;
        expect(result.status).toBe(turn.limited ? '不可比' : '已完成');
        expect(result.confirmed).toBe(true);
        expect(run.romReview?.confirmation?.reviewed).toEqual({
          sessionId: summary.session.id,
          revision: summary.session.revision,
        });
        expect(run.completion?.missing).toEqual(turn.limited ? ['comparison'] : []);
        const compared = run.calls.findLast(
          (call: any) => call.name === 'compare_intervals' && call.output.ok,
        );
        expect(compared.arguments).toMatchObject({
          joint: 'knee',
          basis: turn.basis,
          channels: turn.sides,
          first: turn.first,
          second: turn.second,
        });
        const comparison = compared.output.result;
        expect(comparison.comparable).toBe(!turn.limited);
        result.segments = [comparison.first, comparison.second].map((segment, i) => {
          const interval = [turn.first, turn.second][i];
          const sampled = subset(rows, interval);
          const sampledRange = [Number(sampled[0].time_s), Number(sampled.at(-1)!.time_s)];
          expect(segment.evidence).toMatchObject({
            interval,
            sampledRange,
            sampleCount: sampled.length,
            basis: turn.basis,
            synthetic: false,
          });
          const channels = turn.sides.map((side, c) => {
            const raw = kneeOracle(sampled, 'raw', side);
            const filtered = kneeOracle(sampled, 'filtered', side);
            const calculated = turn.basis === 'raw' ? raw : filtered;
            expect(segment.channels[c].channel).toBe(side);
            expect(segment.channels[c].angle.sampleCount).toBe(calculated.valid);
            numericEqual(segment.channels[c].coverage, calculated.coverage);
            numericEqual(segment.channels[c].rom, calculated.rom);
            return { side, raw, filtered };
          });
          return { interval, sampledRange, samples: sampled.length, channels };
        });
        for (const [c, difference] of comparison.differences.entries()) {
          if (turn.limited)
            expect(difference).toMatchObject({
              rom: null,
              meanAngle: null,
              peakAbsoluteVelocity: null,
            });
          else
            numericEqual(
              difference.rom,
              comparison.second.channels[c].rom - comparison.first.channels[c].rom,
            );
        }
        result.differences = comparison.differences;
        result.reasons = comparison.reasons;
        if (turn.limited) {
          expect(comparison.reasons).toEqual(['至少一侧有效样本不足 2 或已采样帧覆盖率低于 80%']);
          expect(
            run.citations.some(
              (c: any) =>
                c.callId === compared.id &&
                c.path === '/reasons/0' &&
                c.value === comparison.reasons[0],
            ),
          ).toBe(true);
        }
        await expect(chart).toContainText('图表区间 ' + spanText(chartSpan));
        await expect(chart.getByRole('heading')).toContainText(
          `膝关节 · ${turn.basis} · ${turn.sides.length === 2 ? '左侧 / 右侧' : '右侧'}`,
        );
        await expect(chart.locator('.echart canvas').first()).toBeVisible();
        await chart.screenshot({ path: info.outputPath(`turn-${index + 1}-chart.png`) });
        const href = `#agent-evidence-${compared.id}`;
        await panel.locator(`a[href="${href}"]`).first().click();
        const evidence = panel.locator(href);
        await expect(evidence).toBeVisible();
        await expect(evidence).toContainText('本地视频');
        for (const [i, segment] of result.segments.entries()) {
          await expect(evidence.locator('.scope-samples').nth(i)).toContainText(
            `请求区间 ${spanText(segment.interval)} · 实际采样 ${spanText(segment.sampledRange)}（${segment.samples} 帧） · ${turn.basis}`,
          );
        }
        if (turn.limited) await expect(evidence).toContainText(comparison.reasons[0]);
        await evidence.screenshot({ path: info.outputPath(`turn-${index + 1}-evidence.png`) });
        await evidence.getByRole('button', { name: '定位后段', exact: true }).click();
        await expect(chart).toContainText('图表区间 ' + spanText(turn.second));
        result.evidenceSeek = await chart.innerText();
        if (turn.export) {
          const reportName = 'report.json';
          const csvName = 'prepared.csv';
          const report = JSON.parse(
            (
              await downloadFile(
                page,
                info,
                panel.getByRole('button', { name: '保存报告 JSON', exact: true }),
                reportName,
              )
            ).bytes.toString(),
          );
          const reportCall = run.calls.findLast(
            (call: any) => call.name === 'prepare_report' && call.output.ok,
          );
          expect(report.analysis).toMatchObject({
            runId: run.id,
            provider: 'ollama-local',
            requestedModel: run.model,
          });
          expect(report.reference).toMatchObject({
            sessionId: summary.session.id,
            revision: summary.session.revision,
          });
          expect(report.result).toEqual(reportCall.output.result);
          expect(report.result.comparison).toEqual(comparison);
          if (turn.limited) {
            expect(report.result.limitations).toContain(comparison.reasons[0]);
            expect(report.result.trends).toEqual(['所选区间不可比较；各段统计仅供独立核对。']);
          }
          const exported = parseCSV(
            (
              await downloadFile(
                page,
                info,
                panel.getByRole('button', { name: '保存 CSV', exact: true }),
                csvName,
              )
            ).bytes,
          );
          const expected = subset(rows, turn.export);
          expect(exported).toEqual(expected);
          result.artifacts = {
            report: reportName,
            csv: csvName,
            csvRows: exported.length,
            csvColumns: Object.keys(exported[0]).length,
            exportRequested: turn.export,
            exportSampled: [Number(exported[0].time_s), Number(exported.at(-1)!.time_s)],
          };
        }
        await persist();
      }
      expect(new Set(summary.turns.map((t: any) => t.conversationId)).size).toBe(1);
    },
  );
}

humanTest(
  'quality',
  ['定位图表 / 区间起点'],
  async ({ info, rows, panel, chart, submit, persist }) => {
    const interval = limited.second;
    const sampled = subset(rows, interval);
    const sampledRange: Span = [Number(sampled[0].time_s), Number(sampled.at(-1)!.time_s)];
    const raw = kneeOracle(sampled, 'raw', 'right');
    const invalid = sampled.length - raw.valid;
    const notDetected = sampled.filter((row) => row.raw_nose_x === '').length;
    expect({ sampledRange, count: sampled.length, valid: raw.valid, invalid, notDetected }).toEqual(
      {
        sampledRange: [35.033333, 40],
        count: 150,
        valid: 82,
        invalid: 68,
        notDetected: 0,
      },
    );
    const { audit, result } = await submit(
      '请查询绝对区间 [35.01, 40.01] 秒内 raw 右膝角度的样本质量。',
    );
    const { run } = audit;
    expect(result.status).toBe('已完成');
    expect(run.task?.spec).toMatchObject({
      goalTypes: ['quality'],
      joint: 'knee',
      channels: ['right'],
      basis: 'raw',
      interval,
      metrics: [],
      comparison: null,
      time: null,
      unresolved: [],
      deliveries: { view: null, report: false, export: null },
    });
    expect(run.completion?.missing).toEqual([]);
    expect(result.replayed).toContain('get_quality_summary');
    expect(
      run.calls.filter((call) =>
        [
          'query_metrics',
          'compare_intervals',
          'set_chart_view',
          'seek_to_time',
          'prepare_report',
          'prepare_export',
        ].includes(call.name),
      ),
    ).toEqual([]);
    const call = run.calls.findLast(
      (call) => call.name === 'get_quality_summary' && call.output.ok,
    );
    if (!call?.output.ok) throw new Error('Missing local quality calculation');
    const quality = call.output.result as any;
    expect(call.arguments).toMatchObject({
      interval,
      selection: { joint: 'knee', channels: ['right'], basis: 'raw' },
    });
    expect(quality.evidence).toMatchObject({
      interval,
      sampledRange,
      sampleCount: sampled.length,
      basis: 'raw',
      synthetic: false,
    });
    expect(quality.selection).toMatchObject({
      joint: 'knee',
      basis: 'raw',
      channels: [
        {
          channel: 'right',
          validSamples: raw.valid,
          invalidSamples: invalid,
          notDetectedSamples: notDetected,
          unusableSamples: invalid - notDetected,
        },
      ],
    });
    numericEqual(quality.selection.channels[0].coverage, raw.coverage);
    result.quality = quality;
    await persist();
    const paths = run.citations
      .filter((citation) => citation.callId === call.id)
      .map((citation) => citation.path);
    for (const field of ['validSamples', 'invalidSamples', 'coverage'])
      expect(paths).toContain(`/selection/channels/0/${field}`);

    const href = `#agent-evidence-${call.id}`;
    await panel.locator(`a[href="${href}"]`).first().click();
    const evidence = panel.locator(href);
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText('采样质量 · 膝');
    await expect(evidence.locator('.scope-samples')).toContainText(
      `请求区间 ${spanText(interval)} · 实际采样 ${spanText(sampledRange)}（150 帧） · raw`,
    );
    const table = evidence.getByRole('table').first();
    await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([
      '右侧',
      '82 / 150',
      '54.7%',
      '0',
      '68',
    ]);
    await expect(evidence).toContainText('分母为区间全部已采样帧');
    await expect(evidence).toContainText('帧覆盖率不代表持续时间覆盖、人体精度或同一人物身份追踪');
    await expect(evidence).toContainText('不能仅凭该计数判断遮挡原因');
    expect(quality.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining('覆盖率分母为查询区间已采样帧')]),
    );
    await expect(panel.locator('.artifact-card')).toHaveCount(0);
    await evidence.screenshot({ path: info.outputPath('turn-1-evidence.png') });
    await evidence.getByRole('button', { name: '定位图表 / 区间起点', exact: true }).click();
    await expect(chart).toContainText(`图表区间 ${spanText(interval)}`);
    await expect(chart.getByRole('heading')).toContainText('膝关节 · raw · 右侧');
  },
);
