import type { createToolRegistry, ChartView } from '../analysis/tools.ts';
import type { AgentRun, CallRecord, Citation } from './runtime.ts';
import type { Metric, TaskSpec } from './taskSpec.ts';
import { missingTaskFields, same, sameChannels } from './taskSpec.ts';
import { array, enumeration, object, string } from '../analysis/schema.ts';

export interface CompletionCheck {
  state: 'ready' | 'partial' | 'not_comparable' | 'needs_input';
  satisfied: string[];
  missing: string[];
  limitations: string[];
}
export const completionSchema = object({
  state: enumeration('ready', 'partial', 'not_comparable', 'needs_input'),
  satisfied: array(string),
  missing: array(string),
  limitations: array(string),
});
const metricPaths: Record<Metric, string> = {
  rom: 'rom',
  meanAngle: 'angle/mean',
  peakAbsoluteVelocity: 'peakAbsoluteVelocity',
  coverage: 'coverage',
  minAngle: 'angle/min',
  maxAngle: 'angle/max',
  angleVariance: 'angle/populationVariance',
  meanVelocity: 'velocity/mean',
  velocityVariance: 'velocity/populationVariance',
  coordinateVariance: 'coordinateVariance/windows/mean',
};
function at(value: any, path: string): unknown {
  return path.split('/').reduce((v, key) => v?.[key], value);
}
function sameView(a: ChartView | null | undefined, b: ChartView) {
  return (
    !!a &&
    a.joint === b.joint &&
    a.basis === b.basis &&
    sameChannels(a.channels, b.channels) &&
    same(a.interval, b.interval)
  );
}
export function checkCompletion(
  run: AgentRun,
  citations: Citation[],
  registry: ReturnType<typeof createToolRegistry>,
): CompletionCheck {
  const check: CompletionCheck = { state: 'partial', satisfied: [], missing: [], limitations: [] };
  if (!run.task) return { ...check, state: 'needs_input', missing: ['TASK_SPEC_REQUIRED'] };
  const spec: TaskSpec = run.task.spec;
  const missing = missingTaskFields(spec);
  if (missing.length) return { ...check, state: 'needs_input', missing };
  const calls = run.calls.filter(
    (c): c is CallRecord & { output: { ok: true; tool: string; result: any } } => c.output.ok,
  );
  const cited = (c: CallRecord, path: (p: string) => boolean) =>
    citations.some((x) => x.callId === c.id && path(x.path));
  const selection = (v: any) =>
    v?.joint === spec.joint &&
    v?.evidence?.basis === spec.basis &&
    sameChannels(
      v.channels.map((c: any) => c.channel),
      spec.channels!,
    );
  const fact = (v: any, interval: unknown) => selection(v) && same(v.evidence.interval, interval);
  const numericMetrics = (v: any) =>
    spec.metrics.every((m) =>
      m === 'coordinateVariance'
        ? typeof at(v, metricPaths[m]) === 'number'
        : v.channels.every((c: any) => typeof at(c, metricPaths[m]) === 'number'),
    );
  const metricCitation = (c: CallRecord) =>
    cited(c, (p) =>
      spec.metrics.some((m) =>
        m === 'coordinateVariance'
          ? p === '/coordinateVariance/windows/mean'
          : new RegExp(`^/channels/\\d+/${metricPaths[m]}$`).test(p),
      ),
    );
  const matchComparison = (v: any) =>
    v &&
    fact(v.first, spec.interval) &&
    fact(v.second, spec.comparison?.second) &&
    v.differenceDirection === spec.comparison?.direction;
  const comparisonNumeric = (v: any) =>
    spec.metrics.every((m) => v.differences.every((d: any) => typeof d[m] === 'number'));
  const reports = calls.filter(
    (c) =>
      c.name === 'prepare_report' &&
      fact(c.output.result.facts, spec.interval) &&
      (spec.comparison
        ? matchComparison(c.output.result.comparison)
        : c.output.result.comparison === null),
  );
  const available = (c: (typeof calls)[number], kind: string) => {
    try {
      const artifact = registry.getArtifact(c.output.result.handle);
      return (
        artifact.kind === kind &&
        same(artifact.result, c.output.result) &&
        same(artifact.interval, c.output.result.evidence.interval)
      );
    } catch {
      return false;
    }
  };
  const usableReports = reports.filter(
    (c) => available(c, 'report') && cited(c, (p) => p === '/handle'),
  );
  const require = (name: string, ok: boolean) => (ok ? check.satisfied : check.missing).push(name);
  if (spec.goalTypes.includes('metrics'))
    require('metrics', calls.some(
      (c) =>
        c.name === 'query_metrics' &&
        fact(c.output.result, spec.interval) &&
        numericMetrics(c.output.result) &&
        metricCitation(c),
    ) || usableReports.some((c) => numericMetrics(c.output.result.facts)));
  if (spec.goalTypes.includes('quality'))
    require('quality', calls.some(
      (c) =>
        c.name === 'get_quality_summary' &&
        same(c.output.result.evidence.interval, spec.interval) &&
        cited(c, (p) =>
          /^\/(effectiveRate|meanConfidence|missingSamples|detectedSamples|fullyReliableSamples|maxSampleGapSeconds)$/.test(
            p,
          ),
        ),
    ) || usableReports.length > 0);
  if (spec.goalTypes.includes('comparison') || spec.comparison) {
    const comparisons = calls.filter(
      (c) => c.name === 'compare_intervals' && matchComparison(c.output.result),
    );
    const candidates = [
      ...comparisons
        .filter((c) =>
          cited(c, (p) => spec.metrics.some((m) => new RegExp(`^/differences/\\d+/${m}$`).test(p))),
        )
        .map((c) => c.output.result),
      ...usableReports.map((c) => c.output.result.comparison).filter(Boolean),
    ];
    const successful = candidates.some((v) => v.comparable && comparisonNumeric(v));
    require('comparison', successful);
    if (!successful && candidates.some((v) => !v.comparable)) {
      check.state = 'not_comparable';
      check.limitations.push(...candidates.flatMap((v) => v.reasons));
    }
  }
  let workspace: { chart: ChartView | null; time: number | null } | undefined;
  if (spec.deliveries.view || spec.time !== null || spec.goalTypes.includes('seek')) {
    try {
      workspace = registry.readWorkspace();
    } catch {
      check.limitations.push('WORKSPACE_OBSERVATION_UNAVAILABLE');
    }
  }
  if (spec.deliveries.view) {
    const last = [...calls].reverse().find((c) => c.name === 'set_chart_view');
    require('view', !!last &&
      sameView(last.output.result.view, spec.deliveries.view) &&
      sameView(workspace?.chart, spec.deliveries.view) &&
      cited(last, (p) => p === '/view/basis'));
  }
  if (spec.time !== null || spec.goalTypes.includes('seek')) {
    const last = [...calls].reverse().find((c) => c.name === 'seek_to_time');
    require('seek', !!last &&
      last.output.result.requestedTime === spec.time &&
      workspace?.time === last.output.result.appliedTime &&
      cited(last, (p) => p === '/appliedTime'));
  }
  if (spec.deliveries.report)
    require('report', usableReports.some(
      (c) =>
        numericMetrics(c.output.result.facts) &&
        (!spec.comparison || c.output.result.comparison.comparable),
    ));
  const exported = spec.deliveries.export;
  if (exported)
    require('export', calls.some(
      (c) =>
        c.name === 'prepare_export' &&
        same(c.output.result.evidence.interval, exported.interval) &&
        c.output.result.format === exported.format &&
        c.output.result.state === 'ready' &&
        available(c, 'csv') &&
        cited(c, (p) => p === '/handle'),
    ));
  if (!check.missing.length) check.state = 'ready';
  return check;
}
