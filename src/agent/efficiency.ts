import { AnalysisSession } from '../analysis/session.ts';
import type { SessionInfo } from '../analysis/session.ts';
import {
  FIXED_EVALUATIONS,
  EVALUATION_VERSION,
  EVAL_PARAMETERS,
  evaluationSession,
  assessRun,
} from './evaluation.ts';
import type { EvaluationCase } from './evaluation.ts';

export const EFFICIENCY_VERSION = 'H1.1';
export type Verdict = 'passed' | 'failed' | 'unmeasured';
export interface Check {
  id: string;
  status: Verdict;
  reason: string;
  actual?: unknown;
  limit?: number;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const check = (
  id: string,
  status: Verdict,
  reason: string,
  actual?: unknown,
  limit?: number,
): Check => ({ id, status, reason, actual, limit });
export const verdict = (checks: readonly { status: Verdict }[]): Verdict =>
  checks.some((c) => c.status === 'failed')
    ? 'failed'
    : !checks.length || checks.some((c) => c.status === 'unmeasured')
      ? 'unmeasured'
      : 'passed';
function ceiling(id: string, value: unknown, limit: number): Check {
  return !finite(value)
    ? check(id, 'unmeasured', 'missing_or_invalid', value, limit)
    : check(id, value <= limit ? 'passed' : 'failed', 'inclusive_maximum', value, limit);
}
export const AGENT_LIMITS = {
  single: {
    wallMs: 15000,
    requests: 4,
    wireBytes: 32 * 1024,
    inputTokens: 12000,
    outputTokens: 1200,
  },
  comparison: {
    wallMs: 30000,
    requests: 6,
    wireBytes: 48 * 1024,
    inputTokens: 24000,
    outputTokens: 2400,
  },
  multi: {
    wallMs: 50000,
    requests: 10,
    wireBytes: 48 * 1024,
    inputTokens: 40000,
    outputTokens: 4000,
  },
  page: {
    wallMs: 90000,
    requests: 16,
    wireBytes: 48 * 1024,
    inputTokens: 64000,
    outputTokens: 6000,
  },
} as const;

// Reconstruct ONLY the frozen synthetic evaluation input. Bind its identity to
// the captured reference, without rebinding any call, citation or observation.
// Other inputs need their original frames and an independent oracle; a stored
// `passed: true` by itself is never accepted as proof.
function replaySession(scenario: EvaluationCase, reference: SessionInfo) {
  const original = evaluationSession(scenario.id === 'empty');
  const expected = original.info();
  if (
    !same(reference.parameters, EVAL_PARAMETERS) ||
    !same(reference.range, expected.range) ||
    reference.sampleCount !== expected.sampleCount ||
    reference.source !== 'demo' ||
    reference.synthetic !== true ||
    typeof reference.sessionId !== 'string' ||
    !Number.isInteger(reference.revision)
  )
    throw new Error('unsupported_or_changed_fixture');
  class Replay extends AnalysisSession {
    override info() {
      return { ...super.info(), sessionId: reference.sessionId, revision: reference.revision };
    }
    override assertCurrent(ref: { sessionId: string; revision: number }) {
      if (ref.sessionId !== reference.sessionId || ref.revision !== reference.revision)
        throw new Error('STALE_SESSION');
    }
  }
  const session = new Replay('demo', EVAL_PARAMETERS);
  for (const frame of original.frames) session.append(frame.rawPoints, frame.time);
  return session;
}

function costChecks(turns: any[], limits: (typeof AGENT_LIMITS)[keyof typeof AGENT_LIMITS]) {
  const runs = turns.map((t) => t.run ?? {});
  const complete = runs.length > 0 && runs.every((r) => Array.isArray(r.requests));
  const requests = runs.flatMap((r) => (Array.isArray(r.requests) ? r.requests : []));
  const total = (key: string) =>
    complete && requests.length > 0 && requests.every((r) => finite(r[key]))
      ? requests.reduce((sum, r) => sum + r[key], 0)
      : null;
  const known = (key: string) =>
    requests.reduce((sum, r) => sum + (finite(r[key]) ? r[key] : 0), 0);
  const timings = runs.map((r) => r.timing);
  const timingComplete =
    timings.length > 0 &&
    timings.every(
      (t) =>
        t?.version === '1.0.0' &&
        finite(t.submittedAt) &&
        finite(t.completedAt) &&
        t.completedAt >= t.submittedAt &&
        finite(t.wallMs) &&
        finite(t.computeMs) &&
        finite(t.manualWaitMs) &&
        Math.abs(t.wallMs - t.computeMs - t.manualWaitMs) < 0.01 &&
        finite(t.requestMs) &&
        finite(t.toolMs) &&
        finite(t.applicationMs) &&
        finite(t.auditMs) &&
        t.wallMs + 1 >= t.requestMs + t.toolMs + t.applicationMs + t.auditMs &&
        t.application === 'ready' &&
        t.audit === 'saved',
    );
  const wallMs = timingComplete ? timings.reduce((sum, t) => sum + t.wallMs, 0) : null;
  const computeMs = timingComplete ? timings.reduce((sum, t) => sum + t.computeMs, 0) : null;
  const maxWireBytes =
    complete && requests.length > 0 && requests.every((r) => finite(r.wireBytes))
      ? Math.max(...requests.map((r) => r.wireBytes))
      : null;
  const costs = {
    turns: runs.length,
    requests: complete ? requests.length : null,
    wallMs,
    computeMs,
    maxWireBytes,
    normalizedInputBytes: total('inputBytes'),
    inputTokens: total('inputTokens'),
    outputTokens: total('outputTokens'),
    knownInputTokens: known('inputTokens'),
    knownOutputTokens: known('outputTokens'),
    reportedInputRequests: requests.filter((r) => finite(r.inputTokens)).length,
    reportedOutputRequests: requests.filter((r) => finite(r.outputTokens)).length,
    failedRequests: requests.filter((r) => r.status === 'failed').length,
    requestMs: total('elapsedMs'),
  };
  const checks = [
    ceiling('wallMs', wallMs, limits.wallMs),
    ceiling('requests', costs.requests, limits.requests),
    ceiling('wireBytes', maxWireBytes, limits.wireBytes),
    ceiling('inputTokens', costs.inputTokens, limits.inputTokens),
    ceiling('outputTokens', costs.outputTokens, limits.outputTokens),
  ];
  // An over-limit known subtotal already proves failure, even with missing data.
  for (const [key, value, limit] of [
    [
      'wireBytes',
      Math.max(0, ...requests.filter((r) => finite(r.wireBytes)).map((r) => r.wireBytes)),
      limits.wireBytes,
    ],
    ['inputTokens', costs.knownInputTokens, limits.inputTokens],
    ['outputTokens', costs.knownOutputTokens, limits.outputTokens],
    ['requests', requests.length, limits.requests],
    [
      'wallMs',
      timings.reduce((sum, t) => sum + (finite(t?.wallMs) ? t.wallMs : 0), 0),
      limits.wallMs,
    ],
  ] as const)
    if (value > limit)
      checks.push(check(`${key}:known`, 'failed', 'known_subtotal_exceeds_limit', value, limit));
  if (runs.some((r) => r.auditStatus === 'failed' || r.timing?.application === 'failed'))
    checks.push(check('readiness', 'failed', 'application_or_audit_failed'));
  // Compare cumulative receipts when present, but never sum them (prefix totals).
  for (const [index, run] of runs.entries()) {
    const c = run.conversationCosts;
    if (!c) continue;
    const prefix = runs.slice(0, index + 1);
    if (
      c.turns !== prefix.length ||
      (complete && c.requests !== prefix.reduce((n, r) => n + r.requests.length, 0))
    )
      checks.push(check('conversationCosts', 'failed', 'missing_turn_or_inconsistent_prefix', c));
  }
  for (const run of runs) {
    if (!Array.isArray(run.requests)) continue;
    if (
      run.requests.some((r: any, i: number) => r.index !== i + 1) ||
      (Number.isInteger(run.rounds) &&
        run.rounds !== run.requests.filter((r: any) => r.status === 'returned').length)
    )
      checks.push(
        check('request_accounting', 'failed', 'request_indices_or_response_count_inconsistent'),
      );
    if (
      finite(run.timing?.requestMs) &&
      run.requests.every((r: any) => finite(r.elapsedMs)) &&
      Math.abs(
        run.timing.requestMs - run.requests.reduce((n: number, r: any) => n + r.elapsedMs, 0),
      ) > 1
    )
      checks.push(check('request_timing', 'failed', 'request_duration_receipt_mismatch'));
  }
  if (requests.some((r) => !['returned', 'failed'].includes(r.status)))
    checks.push(check('request_status', 'unmeasured', 'pending_or_invalid_request'));
  return { costs, checks };
}

export function assessEfficiencySample(entry: any) {
  const scenario = FIXED_EVALUATIONS.find((s) => s.id === entry?.caseId);
  const turns: any[] = Array.isArray(entry?.turns) ? entry.turns : [];
  const checks: Check[] = [];
  if (!scenario) checks.push(check('case', 'unmeasured', 'unknown_case'));
  if (entry?.assessment?.passed === false)
    checks.push(
      check('correctness:recorded', 'failed', 'recorded_failure', entry.assessment.failures),
    );
  if (scenario && turns.length !== scenario.turns.length)
    checks.push(
      check(
        'turn_count',
        turns.length > scenario.turns.length ? 'failed' : 'unmeasured',
        'all_necessary_turns_required',
        turns.length,
      ),
    );
  for (const [index, turn] of turns.entries()) {
    if (turn.assessment?.passed === false)
      checks.push(
        check(`turn:${index + 1}:recorded`, 'failed', 'recorded_failure', turn.assessment.failures),
      );
    if (!scenario || !turn.run) continue;
    const expectation = scenario.turns[index];
    if (expectation && turn.run.goal !== expectation.goal)
      checks.push(check(`turn:${index + 1}:goal`, 'failed', 'frozen_goal_changed_or_missing_turn'));
    if (expectation && !expectation.status.includes(turn.run.status))
      checks.push(
        check(`turn:${index + 1}:status`, 'failed', 'unexpected_status', turn.run.status),
      );
    if (
      !turn.observation ||
      !('chart' in turn.observation) ||
      !('time' in turn.observation) ||
      !turn.observation.artifacts
    ) {
      checks.push(
        check(
          `turn:${index + 1}:observation`,
          'unmeasured',
          'missing_final_view_or_artifact_observation',
        ),
      );
      continue;
    }
    try {
      const session = replaySession(scenario, turn.run.reference);
      const result = assessRun(turn.run, scenario, session, turn.observation, index);
      checks.push(
        check(
          `turn:${index + 1}:oracle`,
          result.passed ? 'passed' : 'failed',
          'independent_frozen_fixture_replay',
          result.failures,
        ),
      );
    } catch (error) {
      checks.push(check(`turn:${index + 1}:oracle`, 'unmeasured', String(error)));
    }
  }
  const limits =
    scenario?.id === 'multi_turn' || scenario?.id === 'failure_recovery'
      ? AGENT_LIMITS.multi
      : scenario?.id === 'compare' || scenario?.id === 'report'
        ? AGENT_LIMITS.comparison
        : AGENT_LIMITS.single;
  const measured = costChecks(turns, limits);
  checks.push(...measured.checks);
  return {
    caseId: entry?.caseId,
    repeat: entry?.repeat,
    status: verdict(checks),
    costs: measured.costs,
    checks,
  };
}

// Each local sample is a complete independent run, with raw values and an
// oracle result. Aggregate-only historical medians cannot satisfy this schema.
export const LOCAL_LIMITS = {
  queryColdMs: [50, 5, 'max'],
  qualityColdMs: [50, 5, 'max'],
  queryCachedMs: [5, 100, 'p95'],
  summaryMs: [16, 100, 'p95'],
  csvNodeMs: [8000, 5, 'max'],
  csvBrowserStreamMs: [5000, 5, 'max'],
  csvBlobMs: [8000, 5, 'max'],
  sessionHeapBytes: [256 * 1024 ** 2, 5, 'max'],
  exportHeapBytes: [200 * 1024 ** 2, 5, 'max'],
  browserStreamHeapBytes: [200 * 1024 ** 2, 5, 'max'],
  browserBlobHeapBytes: [200 * 1024 ** 2, 5, 'max'],
  uiResponseMs: [100, 100, 'p95'],
  longTasks: [0, 100, 'max'],
  stopWritingMs: [300, 20, 'max'],
  lateWrites: [0, 20, 'max'],
  cameraFPS: [20, 60, 'median-min'],
  offlineMs: [120000, 1, 'max'],
  coldFeedbackMs: [60000, 1, 'max'],
} as const;

export function assessLocalMeasurements(measurements: any) {
  return Object.entries(LOCAL_LIMITS).map(([id, [limit, required, aggregation]]) => {
    const row = measurements?.[id];
    const samples: any[] = Array.isArray(row?.samples) ? row.samples : [];
    const checks: Check[] = [];
    if (samples.length < required)
      checks.push(
        check(
          'samples',
          'unmeasured',
          'insufficient_independent_samples',
          samples.length,
          required,
        ),
      );
    if (
      new Set(samples.map((s) => s.id)).size !== samples.length ||
      samples.some((s) => typeof s.id !== 'string' || !s.id)
    )
      checks.push(check('sample_ids', 'failed', 'duplicate_or_missing_sample_identity'));
    const context = row?.context;
    const common =
      context?.environmentFingerprint && context?.configFingerprint && context?.materialFingerprint;
    const fixed =
      id === 'coldFeedbackMs'
        ? context?.thermalState === 'cold'
        : id === 'cameraFPS'
          ? context?.width === 1280 &&
            context?.height === 720 &&
            context?.durationSeconds >= 60 &&
            context?.model === 'Lite' &&
            context?.actualInferenceFrames === true &&
            context?.realInput === true &&
            context?.sourceFramesRecorded === true &&
            context?.uiFPSSeparate === true
          : id === 'offlineMs'
            ? context?.width === 1280 &&
              context?.height === 720 &&
              context?.fps === 30 &&
              context?.durationSeconds === 60 &&
              context?.realInput === true &&
              context?.allPTSChecked === true &&
              context?.processedFrames === 1800 &&
              context?.expectedFrames === 1800
            : context?.frames === 18000 && context?.synthetic === true;
    if (!common || !fixed)
      checks.push(check('context', 'unmeasured', 'missing_fixed_input_or_environment_evidence'));
    if (
      id.startsWith('csv') &&
      (context?.columns !== 354 || samples.some((s) => s.fullFileVerified !== true || !s.sha256))
    )
      checks.push(
        check('full_file', 'unmeasured', 'requires_354_columns_and_full_file_validation_per_run'),
      );
    if (id === 'queryColdMs' || id === 'qualityColdMs') {
      if (context?.fullRange !== true || samples.some((s) => s.coldRegistry !== true))
        checks.push(check('cold', 'unmeasured', 'independent_cold_registry_required'));
    }
    const destinations: Record<string, string> = {
      csvNodeMs: 'node-file',
      csvBrowserStreamMs: 'browser-file-stream',
      csvBlobMs: 'blob',
    };
    const destination = destinations[id];
    if (
      destination &&
      (context?.destination !== destination ||
        (id === 'csvNodeMs' && context?.hashIncluded !== true))
    )
      checks.push(
        check('destination', 'unmeasured', 'complete_export_destination_and_hash_timing_required'),
      );
    if (id === 'queryCachedMs' && context?.invalidationVerified !== true)
      checks.push(
        check('invalidation', 'unmeasured', 'parameter_and_version_invalidation_required'),
      );
    if (id.includes('HeapBytes')) {
      if (
        context?.sampledPeak !== true ||
        context?.rssRecorded !== true ||
        (id.startsWith('browser')
          ? context?.freshPagePerRun !== true || context?.nonJSHeapRecorded !== true
          : context?.forcedGC !== true)
      )
        checks.push(check('memory', 'unmeasured', 'missing_gc_peak_or_separate_memory_domains'));
    }
    if (
      ['uiResponseMs', 'longTasks', 'stopWritingMs', 'lateWrites'].includes(id) &&
      (context?.foreground !== true ||
        context?.productionPage !== true ||
        context?.nativeDialogWaitSeparate !== true)
    )
      checks.push(check('page', 'unmeasured', 'foreground_production_events_required'));
    if (id === 'longTasks' && context?.performanceObserver !== true)
      checks.push(check('observer', 'unmeasured', 'PerformanceObserver_required'));
    if (samples.some((s) => s.correct === false))
      checks.push(check('correctness', 'failed', 'oracle_failed'));
    if (
      !samples.length ||
      samples.some((s) => s.correct !== true || !s.evidence || !finite(s.value))
    )
      checks.push(check('evidence', 'unmeasured', 'raw_value_or_oracle_or_evidence_missing'));
    const values = samples
      .map((s) => s.value)
      .filter(finite)
      .sort((a, b) => a - b);
    const value = !values.length
      ? null
      : aggregation === 'p95'
        ? values[Math.ceil(values.length * 0.95) - 1]
        : aggregation === 'median-min'
          ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) /
            2
          : values.at(-1)!;
    checks.push(
      aggregation === 'median-min' && finite(value)
        ? check(
            'value',
            value >= limit ? 'passed' : 'failed',
            'inclusive_minimum_median',
            value,
            limit,
          )
        : ceiling('value', value, limit),
    );
    return {
      id,
      status: verdict(checks),
      aggregation,
      value,
      samples: samples.length,
      required,
      checks,
    };
  });
}

export function verifyEfficiency(record: any) {
  const checks: Check[] = [];
  // Default is the complete H efficiency gate. A deliberately scoped file
  // can report one gate, but must not be mistaken for overall acceptance.
  const scopes: string[] = record?.efficiencyScopes ?? ['agent', 'page', 'local'];
  if (
    !Array.isArray(scopes) ||
    !scopes.length ||
    scopes.some((s) => !['agent', 'local', 'page'].includes(s))
  )
    return {
      version: EFFICIENCY_VERSION,
      status: 'failed' as Verdict,
      checks: [check('scope', 'failed', 'invalid_scope')],
    };
  const samples =
    scopes.includes('agent') && Array.isArray(record?.runs)
      ? record.runs.map(assessEfficiencySample)
      : [];
  if (scopes.includes('agent')) {
    checks.push(
      check(
        'version',
        record?.evaluationVersion === EVALUATION_VERSION ? 'passed' : 'unmeasured',
        'supported_frozen_oracle_version',
        record?.evaluationVersion,
      ),
    );
    checks.push(
      check(
        'model',
        record?.evidenceKind === 'real-model' ? 'passed' : 'unmeasured',
        'scripted_is_protocol_only',
        record?.evidenceKind,
      ),
    );
    for (const scenario of FIXED_EVALUATIONS) {
      const rows = samples.filter((s: any) => s.caseId === scenario.id);
      const ids = rows.map((s: any) => s.repeat);
      checks.push(
        check(
          `samples:${scenario.id}`,
          rows.length < 3
            ? 'unmeasured'
            : new Set(ids).size !== rows.length || ids.some((n: unknown) => !Number.isInteger(n))
              ? 'failed'
              : verdict(rows),
          'three_complete_correct_and_efficient_repetitions_required',
          rows.length,
          3,
        ),
      );
    }
    const runIds =
      record.runs?.flatMap((r: any) => (r.turns ?? []).map((t: any) => t.run?.id)) ?? [];
    if (
      runIds.some((id: unknown) => typeof id !== 'string' || !id) ||
      new Set(runIds).size !== runIds.length
    )
      checks.push(check('run_identity', 'failed', 'duplicate_or_missing_independent_run_identity'));
    if (record?.status !== 'executed_real_model')
      checks.push(
        check(
          'execution',
          record?.status === 'failed' || record?.status === 'cancelled' ? 'failed' : 'unmeasured',
          'full_execution_required',
          record?.status,
        ),
      );
  }
  const conditions = record?.config?.measurementConditions ?? record?.measurementConditions;
  if (scopes.some((s) => s === 'agent' || s === 'page')) {
    checks.push(
      check(
        'conditions',
        conditions?.thermalState === 'warm' &&
          conditions?.cpu &&
          conditions?.node === 'v24.22.1' &&
          conditions?.platform === 'win32' &&
          conditions?.pnpm === '11.25.0' &&
          conditions?.powerMode &&
          conditions?.modelResidency &&
          conditions?.backgroundLoad &&
          conditions?.serviceVersion &&
          conditions?.modelFingerprint &&
          record?.fingerprints?.code &&
          record?.fingerprints?.config &&
          record?.fingerprints?.material
          ? 'passed'
          : 'unmeasured',
        'locked_hardware_code_config_and_warm_conditions_required',
      ),
    );
  }
  // A page flow uses a different oracle/input than the frozen headless cases.
  // Accept an independently verified receipt, never the old vacuous summary.
  const pageSamples: any[] = [];
  if (scopes.includes('page')) {
    const sessions = record?.sessions ?? [record];
    checks.push(
      check(
        'page_model',
        sessions.every((s: any) => s.kind === 'real-model-page-demonstration')
          ? 'passed'
          : 'unmeasured',
        'scripted_pages_are_protocol_only',
      ),
    );
    const sceneIds = sessions.map((s: any) => s.turns?.[0]?.run?.conversationId);
    const pageRunIds = sessions.flatMap((s: any) => (s.turns ?? []).map((t: any) => t.run?.id));
    const validSceneIds = sceneIds.filter((id: unknown) => typeof id === 'string' && id);
    if (
      validSceneIds.length !== sceneIds.length ||
      pageRunIds.some((id: unknown) => typeof id !== 'string' || !id)
    )
      checks.push(check('page_identity', 'unmeasured', 'conversation_identity_missing'));
    if (
      new Set(validSceneIds).size !== validSceneIds.length ||
      new Set(pageRunIds).size !== pageRunIds.length ||
      sessions.some((s: any) =>
        s.turns?.some(
          (t: any) =>
            t.run?.conversationId &&
            s.turns[0]?.run?.conversationId &&
            t.run.conversationId !== s.turns[0].run.conversationId,
        ),
      )
    )
      checks.push(check('page_identity', 'failed', 'independent_complete_conversations_required'));
    for (const session of sessions) {
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const costs = costChecks(turns, AGENT_LIMITS.page);
      const proof = session.pageOracle;
      const requiredDeliveries = [
        [
          [
            'compare_intervals',
            {
              joint: 'knee',
              basis: 'filtered',
              channels: ['left', 'right'],
              first: [0, 5],
              second: [15, 20],
            },
          ],
          [
            'set_chart_view',
            { joint: 'knee', basis: 'filtered', channels: ['left', 'right'], interval: [0, 20] },
          ],
        ],
        [
          [
            'compare_intervals',
            {
              joint: 'knee',
              basis: 'filtered',
              channels: ['right'],
              first: [0, 5],
              second: [12, 17],
            },
          ],
          [
            'set_chart_view',
            { joint: 'knee', basis: 'filtered', channels: ['right'], interval: [0, 17] },
          ],
        ],
        [
          [
            'prepare_report',
            {
              joint: 'knee',
              basis: 'filtered',
              channels: ['right'],
              interval: [0, 5],
              comparison: [12, 17],
            },
          ],
          ['prepare_export', { interval: [0, 17], format: 'csv' }],
          [
            'set_chart_view',
            { joint: 'knee', basis: 'filtered', channels: ['right'], interval: [0, 17] },
          ],
        ],
      ] as const;
      for (const [index, turn] of turns.entries()) {
        for (const [name, args] of requiredDeliveries[index] ?? []) {
          const call = turn.run?.calls?.findLast((c: any) => c.name === name && c.output.ok);
          if (
            !call ||
            !Object.entries(args).every(([key, value]) => same(call.arguments?.[key], value))
          )
            costs.checks.push(
              check(
                `turn:${index + 1}:${name}`,
                turn.run?.status === 'completed' ? 'failed' : 'unmeasured',
                'missing_or_wrong_final_delivery',
              ),
            );
        }
      }
      const viewCorrect = (t: any, i: number) =>
        typeof t.finalView === 'string' &&
        t.finalView.includes('膝') &&
        t.finalView.includes('filtered') &&
        t.finalView.includes(i ? '0–17 s' : '0–20 s') &&
        t.finalView.includes('右侧') &&
        (i ? !t.finalView.includes('左侧') : t.finalView.includes('左侧'));
      const knownFailure =
        session.completed === false ||
        session.reportCorrect === false ||
        session.csvCorrect === false ||
        turns.some(
          (t: any, i: number) =>
            t.businessCorrect === false ||
            t.nodeConsistent === false ||
            (t.run && t.run.status !== 'completed') ||
            (typeof t.finalView === 'string' && !viewCorrect(t, i)),
        );
      costs.checks.push(
        check(
          'page_correctness',
          knownFailure
            ? 'failed'
            : proof?.passed === true &&
                proof?.independentReplay === true &&
                proof?.allNecessaryTurns === true &&
                proof?.finalView === true &&
                proof?.report === true &&
                proof?.csv === true &&
                Array.isArray(proof?.evidence) &&
                proof.evidence.length === 6 &&
                session.reportCorrect === true &&
                session.csvCorrect === true &&
                turns.length === 3 &&
                turns.every(
                  (t: any, i: number) =>
                    t.businessCorrect === true && t.nodeConsistent === true && viewCorrect(t, i),
                )
              ? 'passed'
              : 'unmeasured',
          'independent_final_view_report_csv_and_every_turn_required',
        ),
      );
      pageSamples.push({ id: session.id, status: verdict(costs.checks), ...costs });
    }
    checks.push(
      check(
        'page_samples',
        pageSamples.length < 3
          ? 'unmeasured'
          : new Set(pageSamples.map((s) => s.id)).size !== pageSamples.length
            ? 'failed'
            : verdict(pageSamples),
        'three_independent_continuous_sessions_required',
        pageSamples.length,
        3,
      ),
    );
  }
  const local = scopes.includes('local')
    ? assessLocalMeasurements(record.efficiencyMeasurements)
    : [];
  const groups = FIXED_EVALUATIONS.map((scenario) => {
    const rows = samples.filter((s: any) => s.caseId === scenario.id);
    const values = rows
      .map((s: any) => s.costs.wallMs)
      .filter(finite)
      .sort((a: number, b: number) => a - b);
    return {
      caseId: scenario.id,
      samples: rows.length,
      values,
      medianMs: values.length
        ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
        : null,
      maxMs: values.at(-1) ?? null,
      p95Ms:
        values.length >= 20 && values.length === rows.length
          ? values[Math.ceil(values.length * 0.95) - 1]
          : null,
    };
  });
  return {
    version: EFFICIENCY_VERSION,
    status: verdict([...checks, ...samples, ...pageSamples, ...local]),
    scopes,
    checks,
    samples,
    groups,
    pageSamples,
    local,
  };
}
