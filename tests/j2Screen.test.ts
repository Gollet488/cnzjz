import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseEvaluationArgs } from '../scripts/evaluate-agent.mjs';
import { runAgentScreen } from '../scripts/run-agent-screen.mjs';

const directory = await mkdtemp(join(tmpdir(), 'j2-screen-'));
after(async () => {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('j2-screen-'));
  await rm(target, { recursive: true, force: true });
});
let sequence = 0;
const options = (extra: string[] = []) =>
  parseEvaluationArgs([
    '--model',
    'installed-test-only',
    '--case',
    'compare,multi_turn,quality,export',
    '--repeat',
    '1',
    '--output',
    join(directory, `${++sequence}.json`),
    ...extra,
  ]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reply = (calls: any[] = []) =>
  new Response(
    JSON.stringify({
      done: true,
      message: { role: 'assistant', content: '', tool_calls: calls },
      prompt_eval_count: 7,
      eval_count: 3,
    }),
  );
function fakeFetch(business: (init: any) => Promise<Response>, badProbe = false) {
  return async (url: any, init: any) => {
    if (String(url).endsWith('/api/show')) return new Response('{"capabilities":["tools"]}');
    if (String(url).endsWith('/api/ps')) return new Response('{"models":[]}');
    const body = JSON.parse(init.body);
    if (body.tools?.[0]?.function.name === 'connection_check')
      return reply(
        badProbe
          ? []
          : [{ function: { name: 'connection_check', arguments: { echo: 'kinetic' } } }],
      );
    return business(init);
  };
}

test('J2 exact raw bytes, failed HTTP/invalid JSON usage unknown, partial result and scope accounting survive', async () => {
  const opt = options(['--max-business-requests', '1']);
  const bytes = Buffer.from('失败\r\n\u0000not JSON');
  const result = await runAgentScreen(opt, {
    fetch: fakeFetch(async () => new Response(bytes, { status: 500 })),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.record.evidenceKind, 'scripted-protocol-only');
  const saved = JSON.parse(await readFile(opt.output, 'utf8'));
  const runner = JSON.parse(await readFile(`${opt.output}.runner.json`, 'utf8'));
  assert.equal(saved.businessBudget.requests, 1);
  assert.equal(runner.costs.probe.requests, 1);
  assert.equal(runner.costs.business.requests, 1);
  assert.equal(runner.costs.business.inputTokens, null);
  assert.equal(result.receipts[1].httpStatus, 500);
  assert.equal(result.receipts[1].responseSha256, sha(bytes));
  assert.deepEqual(await readFile(`${opt.output}.http/http-002.response.body.bin`), bytes);
  const request = await readFile(`${opt.output}.http/http-002.request.body.bin`);
  assert.equal(result.receipts[1].requestSha256, sha(request));
  assert.equal(result.receipts[1].requestBytes, request.length);
  assert.equal(result.receipts[0].scope, 'probe');
  assert.equal(result.receipts[1].scope, 'business');
  assert.equal(result.receipts[1].caseId, 'compare');
  assert.equal(saved.auditFiles.length, 1);
});

test('J2 time budget interrupts a response stream and saves partial original bytes', async () => {
  const opt = options(['--max-business-ms', '1000']);
  const prefix = Buffer.from('partial-响应');
  const result = await runAgentScreen(opt, {
    fetch: fakeFetch(
      async (init) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(prefix);
              init.signal.addEventListener(
                'abort',
                () => stream.error(new Error('interrupted stream')),
                { once: true },
              );
            },
          }),
        ),
    ),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.record.businessBudget.stoppedBy, 'business_time_budget');
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[1].completeResponse, false);
  assert.deepEqual(await readFile(`${opt.output}.http/http-002.response.body.bin`), prefix);
  assert.equal(JSON.parse(await readFile(opt.output, 'utf8')).runs.length, 1);
  assert.equal(result.receipts[1].inputTokens, null);
});

test('J2 rejects existing output or raw namespace before any request', async () => {
  const opt = options();
  await writeFile(opt.output, 'original');
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return reply();
  };
  await assert.rejects(runAgentScreen(opt, { fetch: fetcher }), /OUTPUT_EXISTS/);
  assert.equal(await readFile(opt.output, 'utf8'), 'original');
  assert.equal(requests, 0);
  const fresh = options(['--skip-real']);
  await runAgentScreen(fresh, { fetch: fetcher });
  await assert.rejects(runAgentScreen(fresh, { fetch: fetcher }), /OUTPUT_EXISTS/);
  assert.equal(requests, 0);
  const third = options();
  await mkdir(`${third.output}.http`);
  await assert.rejects(runAgentScreen(third, { fetch: fetcher }), /EEXIST/);
  assert.equal(requests, 0);
});

test('J2 failed tool probe performs no business request and keeps a separate receipt', async () => {
  let business = 0;
  const opt = options();
  const result = await runAgentScreen(opt, {
    fetch: fakeFetch(async () => {
      business++;
      return reply();
    }, true),
  });
  assert.equal(result.record.connectionProbe.status, 'failed');
  assert.equal(business, 0);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].scope, 'probe');
  assert.equal(result.record.runs.length, 0);
  const summary = JSON.parse(await readFile(`${opt.output}.runner.json`, 'utf8'));
  assert.equal(summary.costs.probe.inputTokens, 7);
  assert.equal(summary.costs.business.requests, 0);
});

test('J2 stops at the failed screen gate after exactly the selected cases and necessary turns, without summaries or case retries', async () => {
  const opt = options();
  const result = await runAgentScreen(opt, { fetch: fakeFetch(async () => reply()) });
  assert.equal(result.record.error, 'SCREEN_GATE_FAILED_STOP');
  assert.equal(result.record.runs.length, 4);
  assert.deepEqual(
    result.record.runs.map((r: any) => r.caseId),
    ['compare', 'quality', 'multi_turn', 'export'],
  );
  assert.equal(result.record.runs.find((r: any) => r.caseId === 'multi_turn').turns.length, 2);
  assert.equal(result.gate.planned, 4);
  assert.equal(result.gate.passed, false);
  assert.equal(result.record.baseline, null);
  assert.equal(result.record.baselinePolicy.requests, 0);
  assert.equal(
    result.receipts.filter((r: any) => r.scope === 'business').length,
    result.record.businessBudget.requests,
  );
  assert.equal(result.receipts.length, result.record.businessBudget.requests + 1);
  const files = await readdir(`${opt.output}.http`);
  assert.equal(files.filter((f) => f.endsWith('.receipt.json')).length, result.receipts.length);
});

test('J2 unexpected checkpoint failure retains receipts and the finished partial evaluation', async () => {
  const opt = options();
  const result = await runAgentScreen(opt, {
    fetch: fakeFetch(async () => reply()),
    onCheckpoint(snapshot: any) {
      if (snapshot.checkpoint.reason === 'turn_completed')
        throw new Error('unexpected interruption');
    },
  });
  assert.equal(result.exitCode, 1);
  const saved = JSON.parse(await readFile(opt.output, 'utf8'));
  assert.equal(saved.error, 'unexpected interruption');
  assert.equal(saved.runs[0].turns.length, 1);
  assert.equal(saved.runs[0].assessment, null);
  assert.equal(saved.checkpoint.reason, 'finished');
  assert.equal(saved.auditFiles.length, 1);
  assert.ok(result.receipts.length > 1);
});
