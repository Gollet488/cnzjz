import type { Page } from '@playwright/test';
import { modelGoalTypes } from '../../src/agent/modelProtocol.ts';
import { taskFixture } from '../agentFixtures.ts';

export const goals = [
  '比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表',
  '只看右侧，第二段改成 12–17 秒',
  '准备当前右膝 filtered 0–5 秒与 12–17 秒比较报告，并准备 0–17 秒 CSV，保留图表',
];

// Test-only HTTP fixture. The real provider, runtime, tools and Vue UI still run.
// This script proves protocol/UI behavior, never natural-language model quality.
export async function scriptedOllama(page: Page, provider: 'ollama' | 'deepseek' = 'ollama') {
  const requests: any[] = [];
  const steps = new Map<string, number>();
  await page.route(
    provider === 'ollama' ? 'http://127.0.0.1:11434/api/**' : '**/__deepseek/**',
    async (route) => {
      let body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const reply = (data: unknown) => route.fulfill({ json: data });
      if (provider === 'deepseek' && path === '/__deepseek/probe')
        return reply({
          requests: 1,
          response: { model: 'deepseek-flash', systemFingerprint: null },
        });
      if (provider === 'deepseek')
        body = {
          ...body,
          tools: body.tools.map((t: any) => ({ function: t })),
          messages: body.messages.map((m: any) => ({
            ...m,
            tool_calls: m.calls?.map((c: any) => ({ function: c })),
          })),
        };
      if (path === '/api/show') return reply({ capabilities: ['tools'] });
      if (path !== '/api/chat' && path !== '/__deepseek/complete')
        throw new Error(`Unexpected mock path ${path}`);
      requests.push(body);
      const calls = (items: { name: string; arguments: any }[]) => {
        const mapped = items.map((c) => {
          if (c.name === 'set_task_spec')
            c = {
              ...c,
              arguments: {
                ...c.arguments,
                goalTypes: modelGoalTypes(c.arguments.goalTypes),
                sources: [
                  {
                    field: 'task',
                    origin: 'derived',
                    sourceId: input.userSources.find((s: any) => s.kind === 'current').sourceId,
                  },
                ],
              },
            };
          if (c.name === 'set_task_patch')
            c = {
              ...c,
              arguments: {
                changes: c.arguments.changes.map((s: any) => ({
                  field: s.field,
                  value: s.value,
                  origin: s.origin,
                  sourceId: input.userSources.find((s: any) => s.kind === 'current').sourceId,
                })),
              },
            };
          return c;
        });
        return reply(
          provider === 'deepseek'
            ? {
                calls: mapped,
                response: {
                  id: 'scripted-only',
                  model: 'deepseek-flash',
                  systemFingerprint: null,
                  finishReason: 'tool_calls',
                },
              }
            : {
                done: true,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: mapped.map((c) => ({ function: c })),
                },
              },
        );
      };
      if (body.tools.some((t: any) => t.function.name === 'connection_check'))
        return calls([{ name: 'connection_check', arguments: { echo: 'kinetic' } }]);
      const input = body.messages
        .filter((m: any) => m.role === 'user')
        .map((m: any) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return {};
          }
        })
        .findLast((m: any) => m.goal);
      if (!goals.includes(input.goal)) throw new Error(`Unexpected scripted goal ${input.goal}`);
      const turn = goals.indexOf(input.goal);
      const step = steps.get(input.goal) ?? 0;
      steps.set(input.goal, step + 1);
      const reference = {
        sessionId: input.currentSession.sessionId,
        revision: input.currentSession.revision,
      };
      const view = {
        joint: 'knee',
        channels: turn ? ['right'] : ['left', 'right'],
        basis: 'filtered',
        interval: [0, turn ? 17 : 20],
      };
      const selection = { ...reference, joint: 'knee', channels: view.channels, basis: 'filtered' };
      const second = turn ? [12, 17] : [15, 20];
      const call = (name: string, args: any) => ({ name, arguments: args });
      if (step === 0) {
        if (!turn)
          return calls([
            call('get_session_info', {}),
            call(
              'set_task_spec',
              taskFixture(input.goal, {
                goalTypes: ['comparison'],
                comparison: { second: [15, 20], direction: 'second_minus_first' },
                deliveries: {
                  view: { ...view, interval: 'comparison' } as any,
                  report: false,
                  export: null,
                },
              }),
            ),
          ]);
        const changes =
          turn === 1
            ? [
                ['channels', ['right']],
                ['comparison.second', second],
                ['deliveries.view.channels', ['right']],
                ['deliveries.view.interval', 'comparison'],
              ]
            : [
                ['deliveries.report', true],
                ['deliveries.export', { interval: [0, 17], format: 'csv' }],
              ];
        return calls([
          call('get_session_info', {}),
          call('set_task_patch', {
            changes: changes.map(([field, value]) => ({
              field,
              value,
              text: input.goal,
              origin: 'derived',
              fromRunId: null,
            })),
          }),
        ]);
      }
      if (step === 1)
        return calls([
          call('compare_intervals', { taskRef: input.bindings.taskRef }),
          // Attempt an obsolete explicit view: v3.2 must reject repeated business
          // parameters, then apply only the current task's bound view.
          ...(turn === 1
            ? [
                call('set_chart_view', {
                  ...selection,
                  channels: ['left'],
                  basis: 'raw',
                  interval: [1, 2],
                }),
              ]
            : []),
          call('set_chart_view', { taskRef: input.bindings.taskRef }),
          ...(turn === 2
            ? [
                call('prepare_report', { taskRef: input.bindings.taskRef }),
                call('prepare_export', { taskRef: input.bindings.taskRef }),
              ]
            : []),
        ]);
      if (step !== 2)
        throw new Error('Scripted flow needed unexpected recovery; inspect actual feedback');
      const feedback = body.messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => JSON.parse(m.content));
      if (
        turn === 1 &&
        !feedback.some(
          (f: any) =>
            f.tool === 'set_chart_view' &&
            !f.ok &&
            f.error?.issue?.path === '$.taskRef' &&
            f.error?.issue?.kind === 'missing_field',
        )
      )
        throw new Error('Obsolete explicit view must be rejected before bound view delivery');
      const entries = feedback.flatMap((f: any) => f.evidenceCatalog?.entries ?? []);
      const labels = ['differences.0.rom', 'view.basis', ...(turn === 2 ? ['handle'] : [])];
      const citations = entries
        .filter((e: any) => labels.includes(e.label))
        .map((e: any) => ({ evidenceId: e.evidenceId }));
      if (citations.length !== (turn === 2 ? 4 : 2))
        throw new Error(`Missing actual evidence ${JSON.stringify(feedback)}`);
      return calls([
        call('finish_analysis', { outcome: 'completed', messageCode: 'evidence_ready', citations }),
      ]);
    },
  );
  return requests;
}
