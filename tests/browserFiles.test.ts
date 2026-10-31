import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, numericEqual, verifyAudit, replayFullCSV } from './browser/files.ts';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { serializeCSV } from '../src/utils/csv.ts';
import { demoPose } from '../src/utils/demo.ts';

test('browser download oracle includes EOF row with/without CRLF, preserves quoted commas/newlines', () => {
  const header = Array.from({ length: 354 }, (_, i) => `"c${i}"`).join(',');
  const row = ['"F,""quoted""\nsynthetic"', ...Array(353).fill('""')].join(',');
  for (const ending of ['', '\r\n']) {
    const rows = parseCSV(Buffer.from(`\uFEFF${header}\r\n${row}${ending}`));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].c0, 'F,"quoted"\nsynthetic');
    assert.equal(rows[0].c353, '');
  }
  assert.throws(() => parseCSV(Buffer.from(`${header}\r\n${row}`)));
});

test('Node/browser numeric comparison tolerates libm rounding and rejects changed metrics/shape', () => {
  numericEqual({ rom: 176.39277035345833 }, { rom: 176.39277035345836 });
  assert.throws(() => numericEqual({ rom: 1 }, { rom: 1.001 }));
  assert.throws(() => numericEqual({ rom: 1 }, { mean: 1 }));
});

test('full downloaded CSV replay checks non-knee channels, raw/filtered coordinates, missing cells and markers', () => {
  const session = new AnalysisSession('file', {
    threshold: 0.5,
    window: 3,
    aspect: 9 / 16,
    metricVersion: '2.0',
  });
  session.append(demoPose(0), 0);
  session.append(demoPose(0.1), 0.1);
  session.append([], 0.3);
  session.append(demoPose(0.6), 0.6);
  const rows = parseCSV(
    Buffer.from(serializeCSV(session.frames, [{ time: 0.1, label: 'A,"B"\nC' }], session.info())),
  );
  assert.equal(replayFullCSV(rows).rows, 4);
  for (const [index, key, value] of [
    [1, 'filtered_elbow_right_deg', '1'],
    [1, 'raw_nose_z', '1'],
    [1, 'filtered_nose_x', '1'],
    [2, 'filtered_knee_left_deg', '0'],
  ] as const) {
    const changed = structuredClone(rows);
    changed[index][key] = value;
    assert.throws(() => replayFullCSV(changed), `${index}/${key}`);
  }
});

test('download verification rejects an individually stale tool reference before replay normalization', () => {
  const session = new AnalysisSession('demo', {
    threshold: 0.5,
    window: 5,
    aspect: 1,
    metricVersion: '2.0',
  });
  session.append(demoPose(0), 0);
  session.append(demoPose(1), 1);
  const rows = parseCSV(Buffer.from(serializeCSV(session.frames, [], session.info())));
  const args = {
    sessionId: session.info().sessionId,
    revision: session.info().revision,
    joint: 'knee',
    channels: ['right'],
    basis: 'filtered',
    interval: [0, 1],
  };
  const output = createToolRegistry(session).execute('query_metrics', args);
  assert.ok(output.ok);
  const audit = {
    run: { reference: session.info(), calls: [{ name: 'query_metrics', arguments: args, output }] },
  };
  assert.deepEqual(verifyAudit(rows, audit), ['query_metrics']);
  (output.result as any).evidence.revision--;
  assert.throws(() => verifyAudit(rows, audit));
  (output.result as any).evidence.revision++;
  args.sessionId = 'wrong-session';
  assert.throws(() => verifyAudit(rows, audit));
});
