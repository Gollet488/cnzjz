import type { Page } from '@playwright/test';
import { modelGoalTypes } from '../../src/agent/modelProtocol.ts';
import { taskFixture } from '../agentFixtures.ts';

export const goals = [
  // Exercise the general declaration path, including explicit source rejection.
  '请比较 filtered 左右膝 0–5 秒与 15–20 秒的 ROM，并展示覆盖两段的图表',
  '只看右侧，第二段改成 12–17 秒',
  '准备当前右膝 filtered 0–5 秒与 12–17 秒比较报告，并准备 0–17 秒 CSV，保留图表',
];

// Test-only HTTP fixture. The real provider, runtime, tools and Vue UI still run.
// This script proves protocol/UI behavior, never natural-language model quality.
export async function scriptedOllama(
  page: Page,
  provider: 'ollama' | 'deepseek' = 'ollama',
  archivedDeclaration?: object,
) {
  const requests: any[] = [];
  const steps = new Map<string, number>();
  await page.route(
    provider === 'ollama' ? 'http://127.0.0.1:11434/api/**' : '**/__models/**',
    async (route) => {
      let body = route.request().postDataJSON();
      const path = new URL(route.request().url()).pathname;
      const reply = (data: unknown) => route.fulfill({ json: data });
      if (path === '/api/tags') return reply({ models: [{ name: 'scripted-protocol-only' }] });
      if (path === '/__models/catalog')
        return reply({
          providers: [
            {
              provider: 'deepseek',
              models: ['deepseek-flash', 'deepseek-v4-pro'],
              missing: [],
              endpoint: 'https://api.deepseek.com/chat/completions',
            },
          ],
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
      if (path !== '/api/chat' && path !== '/__models/complete')
        throw new Error(`Unexpected mock path ${path}`);
      requests.push(body);
      const calls = (items: { name: string; arguments: any }[]) => {
        const mapped = items.map((c) => {
          if (c.name === 'set_task_spec')
            c =
              provider === 'ollama'
                ? {
                    ...c,
                    arguments: {
                      actions: [...c.arguments.goalTypes, 'view'],
                      joint: c.arguments.joint,
                      channels: c.arguments.channels,
                      basis: c.arguments.basis,
                      interval: c.arguments.interval,
                      second: c.arguments.comparison.second,
                      metrics: c.arguments.metrics,
                      view: c.arguments.deliveries.view.interval,
                    },
                  }
                : {
                    ...c,
                    arguments: {
                      ...c.arguments,
                      goalTypes: modelGoalTypes(c.arguments.goalTypes),
                      sources: [
                        {
                          field: 'task',
                          origin: 'derived',
                          sourceId: input.userSources.find((s: any) => s.kind === 'current')
                            .sourceId,
                        },
                      ],
                    },
                  };
          if (c.name === 'set_task_patch' && provider === 'ollama') {
            const keys: Record<string, string> = {
              'comparison.second': 'second',
              'deliveries.view.channels': 'viewChannels',
              'deliveries.view.interval': 'viewInterval',
              'deliveries.report': 'report',
              'deliveries.export': 'export',
            };
            c = {
              ...c,
              arguments: {
                changes: Object.fromEntries(
                  c.arguments.changes
                    .filter(({ field }: any) => !field.startsWith('deliveries.view.'))
                    .map(({ field, value }: any) => [
                      keys[field] ?? field,
                      field === 'deliveries.export' ? value.interval : value,
                    ]),
                ),
              },
            };
          } else if (c.name === 'set_task_patch')
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
                  model: body.model,
                  systemFingerprint: null,
                  finishReason: 'tool_calls',
                },
              }
            : {
                done: true,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    calls: mapped.map((c) => ({ tool: c.name, values: c.arguments })),
                  }),
                },
              },
        );
      };
      const names =
        provider === 'ollama'
          ? body.format.properties.calls.items.anyOf.map((t: any) => t.properties.tool.enum[0])
          : body.tools.map((t: any) => t.function.name);
      if (names.includes('connection_check'))
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
      const requestIndex = steps.get(input.goal) ?? 0;
      steps.set(input.goal, requestIndex + 1);
      const step = requestIndex - (provider === 'ollama' ? 1 : 0);
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
      if (step < 0) return calls([call('get_session_info', {})]);
      const sessionCall = provider === 'deepseek' ? [call('get_session_info', {})] : [];
      if (step === 0) {
        if (!turn)
          return calls([
            ...sessionCall,
            call(
              'set_task_spec',
              archivedDeclaration ??
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
          ...sessionCall,
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
          ...(archivedDeclaration && turn === 0
            ? [call('set_chart_view', { taskRef: input.bindings.taskRef })]
            : []),
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
        .filter((m: any) => m.role === 'tool' || m.content.startsWith('本地工具反馈：'))
        .map((m: any) => JSON.parse(m.content.replace(/^本地工具反馈：/, '')));
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
        call('finish_analysis', {
          outcome: 'completed',
          messageCode: 'evidence_ready',
          ...(provider === 'ollama'
            ? {
                evidence: Object.fromEntries(
                  feedback
                    .map((f: any) => [
                      f.tool,
                      (f.evidenceCatalog?.entries ?? [])
                        .filter((entry: any) => labels.includes(entry.label))
                        .map((entry: any) => entry.evidenceId),
                    ])
                    .filter(([, ids]: any) => ids.length),
                ),
              }
            : { citations }),
        }),
      ]);
    },
  );
  return requests;
}
