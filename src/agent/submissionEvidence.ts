import type { createToolRegistry } from '../analysis/tools.ts';
import { metricPaths, sameView } from './completion.ts';
import { resolveCitation } from './evidenceCatalog.ts';
import { taskToolArguments } from './modelProtocol.ts';
import type { AgentRun, CallRecord, Citation, SubmissionEvidenceGap } from './runtime.ts';
import { same, sameChannels } from './taskSpec.ts';

export interface EvidenceRequirement {
  tool: string;
  facts: { path: string; value?: Citation['value'] }[];
}

export function romEvidenceRequirements(run: AgentRun): EvidenceRequirement[] {
  const spec = run.task!.spec;
  const required: EvidenceRequirement[] = [];
  const require = (tool: string, ...paths: string[]) =>
    required.push({ tool, facts: paths.map((path) => ({ path })) });
  const comparison = [...run.calls]
    .reverse()
    .find((c) => c.name === 'compare_intervals' && c.output.ok);
  const limited =
    comparison?.output.ok &&
    (comparison.output.result as { comparable: boolean }).comparable === false;
  for (const [i] of spec.channels!.entries()) {
    if (spec.goalTypes.includes('metrics'))
      for (const metric of spec.metrics)
        require('query_metrics', `/channels/${i}/${metricPaths[metric]}`);
    if (spec.goalTypes.includes('quality'))
      require('get_quality_summary', `/selection/channels/${i}/validSamples`);
    if (!limited && spec.goalTypes.includes('comparison')) {
      for (const metric of spec.metrics)
        require('compare_intervals', `/differences/${i}/${metric}`);
      if (spec.metrics.length === 1)
        for (const segment of ['first', 'second'])
          require('compare_intervals', `/${segment}/channels/${i}/rom`);
    }
  }
  if (limited) require('compare_intervals', '/reasons/0', '/comparable');
  if (spec.deliveries.view) require('set_chart_view', '/view/basis');
  if (spec.time !== null) require('seek_to_time', '/appliedTime');
  if (spec.deliveries.report) require('prepare_report', '/handle');
  if (spec.deliveries.export) require('prepare_export', '/handle');
  return required;
}

function matchesResultScope(
  tool: string,
  result: any,
  spec: NonNullable<AgentRun['task']>['spec'],
) {
  const selection = (value: any, interval: unknown) =>
    value?.joint === spec.joint &&
    value?.evidence?.basis === spec.basis &&
    same(value?.evidence?.interval, interval) &&
    Array.isArray(value?.channels) &&
    sameChannels(
      value.channels.map((channel: any) => channel.channel),
      spec.channels!,
    );
  const comparison = (value: any) =>
    selection(value?.first, spec.interval) &&
    selection(value?.second, spec.comparison?.second) &&
    value.differenceDirection === spec.comparison?.direction;
  switch (tool) {
    case 'compare_intervals':
      return comparison(result);
    case 'query_metrics':
      return selection(result, spec.interval);
    case 'get_quality_summary':
      return (
        selection({ ...result.selection, evidence: result.evidence }, spec.interval) &&
        result.selection?.basis === spec.basis
      );
    case 'prepare_report':
      return (
        same(result.evidence?.interval, spec.interval) &&
        selection(result.facts, spec.interval) &&
        comparison(result.comparison)
      );
    case 'prepare_export':
      return (
        same(result.evidence?.interval, spec.deliveries.export?.interval) &&
        result.format === spec.deliveries.export?.format
      );
    default:
      return true;
  }
}

export function assembleEvidence(
  run: AgentRun,
  registry: ReturnType<typeof createToolRegistry>,
  requirements: EvidenceRequirement[],
  validateOutput: (output: CallRecord['output']) => void,
) {
  const citations: Citation[] = [];
  const gaps: SubmissionEvidenceGap[] = [];
  const expected = taskToolArguments(run.task!.spec);
  for (const tool of new Set(requirements.map(({ tool }) => tool))) {
    const rules = requirements.filter((requirement) => requirement.tool === tool);
    const call = [...run.calls]
      .reverse()
      .find((c) => c.name === tool && c.output.ok && !c.reusedCallId);
    const gap = (
      rule: EvidenceRequirement,
      reason: SubmissionEvidenceGap['reason'],
      detail?: string,
    ) =>
      gaps.push({
        tool,
        labels: rule.facts.map(({ path }) => path.slice(1).replaceAll('/', '.')),
        reason,
        detail,
      });
    let invalid: { reason: SubmissionEvidenceGap['reason']; detail?: string } | undefined;
    const { sessionId, revision } = run.reference;
    if (!call?.output.ok) {
      const rejected = [...run.calls].reverse().find((c) => c.name === tool && !c.output.ok);
      const detail = rejected && !rejected.output.ok ? rejected.output.error.message : undefined;
      invalid = {
        reason: detail?.includes('STALE')
          ? 'stale_evidence'
          : detail?.includes('VIEW_NOT_APPLIED')
            ? 'view_not_applied'
            : 'missing_tool_or_scope',
        detail,
      };
    } else if (
      (call.arguments as { sessionId?: string })?.sessionId !== sessionId ||
      (call.arguments as { revision?: number })?.revision !== revision
    ) {
      invalid = { reason: 'stale_evidence' };
    } else if (!same(call.arguments, { sessionId, revision, ...(expected[tool] as object) })) {
      const requested = expected[tool] as Record<string, unknown>;
      const actual = call.arguments as Record<string, unknown>;
      invalid = {
        reason: 'parameter_mismatch',
        detail: Object.keys({ ...actual, ...requested })
          .filter(
            (key) =>
              key !== 'sessionId' && key !== 'revision' && !same(actual[key], requested?.[key]),
          )
          .join(', '),
      };
    } else {
      try {
        validateOutput(call.output);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        invalid = { reason: /STALE/.test(detail) ? 'stale_evidence' : 'fact_mismatch', detail };
      }
      const result = call.output.result as any;
      if (!invalid && !matchesResultScope(tool, result, run.task!.spec))
        invalid = { reason: 'parameter_mismatch', detail: 'TOOL_RESULT_SCOPE' };
      if (!invalid && (tool === 'set_chart_view' || tool === 'seek_to_time')) {
        if (result.sessionId !== sessionId || result.revision !== revision)
          invalid = { reason: 'stale_evidence' };
        else {
          try {
            const workspace = registry.readWorkspace();
            if (
              tool === 'set_chart_view'
                ? !sameView(workspace.chart, run.task!.spec.deliveries.view!) ||
                  !sameView(result.view, run.task!.spec.deliveries.view!)
                : workspace.time !== result.appliedTime ||
                  result.requestedTime !== run.task!.spec.time
            )
              invalid = { reason: 'view_not_applied' };
          } catch (error) {
            invalid = { reason: 'view_not_applied', detail: String(error) };
          }
        }
      }
      if (!invalid && (tool === 'prepare_report' || tool === 'prepare_export')) {
        try {
          const artifact = registry.getArtifact(result.handle);
          if (
            artifact.kind !== (tool === 'prepare_report' ? 'report' : 'csv') ||
            result.state !== 'ready' ||
            !same(artifact.result, result) ||
            !same(artifact.interval, result.evidence.interval)
          )
            invalid = { reason: 'artifact_not_ready' };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          invalid = {
            reason: /STALE/.test(detail) ? 'stale_evidence' : 'artifact_not_ready',
            detail,
          };
        }
      }
    }
    for (const rule of rules) {
      if (invalid) {
        gap(rule, invalid.reason, invalid.detail);
        continue;
      }
      if (!call?.output.ok) continue;
      const result = call.output.result;
      let hasValue = false;
      const binding = rule.facts.flatMap((fact) => {
        try {
          const value = resolveCitation(result, fact.path);
          if (value === null) return [];
          hasValue = true;
          if (Object.hasOwn(fact, 'value') && !same(fact.value, value)) return [];
          const entry = call.evidenceCatalog?.entries.find((item) => item.path === fact.path);
          return [{ callId: call.id, path: fact.path, value, evidenceId: entry?.evidenceId }];
        } catch {
          return [];
        }
      })[0];
      if (binding) citations.push({ ...binding, source: 'local-executor' });
      else gap(rule, hasValue ? 'fact_mismatch' : 'fact_missing');
    }
  }
  return { citations, gaps };
}
