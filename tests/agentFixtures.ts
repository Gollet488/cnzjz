// Scripted model declarations for protocol tests only. Never imported by the
// product or real provider. These do not test natural-language interpretation.
import type { TaskSpec } from '../src/agent/taskSpec.ts';
import type { ModelProvider } from '../src/agent/provider.ts';
import assert from 'node:assert/strict';

// Test scripts choose an advertised entry, just as the model does. Pointers here
// are test selectors only and are never sent as tool arguments.
export function evidenceRef(feedback: any, path: string): { evidenceId: string } {
  const entry = feedback.evidenceCatalog?.entries.find(
    (e: any) => e.label === path.slice(1).replaceAll('/', '.'),
  );
  assert.ok(entry, `missing advertised catalog entry: ${path}`);
  return { evidenceId: entry.evidenceId };
}
export function taskFixture(goal: string, fields: Partial<TaskSpec> = {}): TaskSpec {
  const spec: TaskSpec = {
    goalTypes: ['metrics'],
    joint: 'knee',
    channels: ['left', 'right'],
    basis: 'filtered',
    interval: [0, 5],
    comparison: null,
    metrics: ['rom'],
    time: null,
    deliveries: { view: null, report: false, export: null },
    sources: [],
    unresolved: [],
    ...fields,
  };
  spec.sources = Object.keys(spec)
    .filter((field) => !['sources', 'unresolved'].includes(field))
    .map((field) => ({ field, origin: 'derived', text: goal, fromRunId: null }));
  return spec;
}
export function taskForActions(
  goal: string,
  actions: readonly { name: string; args: any }[],
): TaskSpec {
  const spec = taskFixture(goal, {
    goalTypes: [],
    joint: null,
    channels: null,
    basis: null,
    interval: null,
    metrics: [],
  });
  for (const { name, args } of actions) {
    if (['query_metrics', 'compare_intervals', 'prepare_report'].includes(name)) {
      Object.assign(spec, {
        joint: args.joint,
        channels: args.channels,
        basis: args.basis,
        interval: args.interval ?? args.first,
        metrics: ['rom'],
      });
      if (args.second ?? args.comparison)
        spec.comparison = {
          second: args.second ?? args.comparison,
          direction: 'second_minus_first',
        };
    }
    const type = {
      query_metrics: 'metrics',
      compare_intervals: 'comparison',
      get_quality_summary: 'quality',
      seek_to_time: 'seek',
      set_chart_view: 'view',
      prepare_report: 'report',
      prepare_export: 'export',
    }[name];
    if (type) spec.goalTypes.push(type as TaskSpec['goalTypes'][number]);
    if (name === 'get_quality_summary') spec.interval = args.interval;
    if (name === 'seek_to_time') spec.time = args.time;
    if (name === 'set_chart_view') spec.deliveries.view = args;
    if (name === 'prepare_report') spec.deliveries.report = true;
    if (name === 'prepare_export') spec.deliveries.export = args;
  }
  spec.goalTypes = [...new Set(spec.goalTypes)];
  return spec;
}
export function withTaskSpecs<T extends ModelProvider>(
  model: T,
  spec: (goal: string) => TaskSpec = (goal) => taskFixture(goal),
): T {
  const declared = new WeakSet<AbortSignal>();
  return {
    ...model,
    async complete(request) {
      const reply = await model.complete(request);
      if (
        !declared.has(request.signal) &&
        reply.calls.some((c) => c.name === 'get_session_info') &&
        !reply.calls.some((c) => c.name === 'finish_analysis')
      ) {
        const user = request.messages
          .filter((m) => m.role === 'user')
          .map((m) => {
            try {
              return JSON.parse(m.content);
            } catch {
              return {};
            }
          })
          .findLast((m) => m.goal);
        declared.add(request.signal);
        reply.calls.push({ name: 'set_task_spec', arguments: spec(user.goal) });
      }
      return reply;
    },
  };
}
