// Frozen real failure replay. This is a local regression, not model success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTaskSpec } from '../src/agent/taskSpec.ts';
import { ModelProtocolAdapter, modelGoalTypes } from '../src/agent/modelProtocol.ts';
import { evaluationSession } from '../src/agent/evaluation.ts';

test('H3 real overlapping source failure identifies the conflicting paths without repairing intent', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/h3-source-overlap.json', import.meta.url), 'utf8'),
  );
  const goal = JSON.parse(fixture.goal).goal;
  const value = {
    ...fixture.call.arguments,
    sources: fixture.call.arguments.sources.map((s: any) => ({
      field: s.field,
      origin: s.origin,
      text: goal,
      fromRunId: null,
    })),
  };
  const before = structuredClone(value);
  assert.throws(
    () => validateTaskSpec(value, goal),
    /TASK_SPEC_SOURCE_OVERLAP:deliveries\.view:deliveries\.view\.joint/,
  );
  assert.deepEqual(value, before);
});

test('H3 model source IDs are enumerated per request; foreign IDs still fail locally', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/h3-source-overlap.json', import.meta.url), 'utf8'),
  );
  const goal = JSON.parse(fixture.goal).goal;
  const session = evaluationSession();
  const adapter = new ModelProtocolAdapter('run', session.info(), goal);
  const run = { id: 'run', reference: session.info(), calls: [] } as any;
  const offered = adapter.tools(run, [
    { name: 'set_task_spec', description: '', inputSchema: {}, outputSchema: {} },
  ]);
  const schema = offered[0]!.inputSchema;
  assert.deepEqual(
    schema.properties!.sources.items!.properties!.sourceId.enum,
    adapter.userSources.map((s) => s.sourceId),
  );
  const spec = structuredClone(fixture.call.arguments);
  spec.goalTypes = modelGoalTypes(spec.goalTypes);
  spec.sources.forEach((s: any) => {
    s.sourceId = adapter.userSources[0]!.sourceId;
  });
  spec.sources[0].sourceId = 'invented';
  assert.throws(
    () => adapter.expand({ name: 'set_task_spec', arguments: spec }, run, offered),
    /sources\[0\].sourceId.*enum/,
  );
});
