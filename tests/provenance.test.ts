import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisSession } from '../src/analysis/session.ts';
import { createToolRegistry } from '../src/analysis/tools.ts';
import { serializeCSV } from '../src/utils/csv.ts';

test('explicit synthetic upload provenance versions evidence and survives recalculation, reset clears it', () => {
  const s = new AnalysisSession('file', {
    threshold: 0.5,
    window: 5,
    aspect: 4 / 3,
    metricVersion: '2.0',
  });
  s.append([], 0);
  const old = s.info();
  s.setFileSynthetic(true);
  assert.equal(s.info().source, 'file');
  assert.equal(s.info().synthetic, true);
  assert.equal(s.info().revision, old.revision + 1);
  assert.throws(() => s.assertCurrent(old), /STALE_SESSION/);
  assert.throws(() => s.setFileSynthetic(false, old), /STALE_SESSION/);
  const output = createToolRegistry(s).execute('get_session_info', {});
  assert.ok(output.ok && (output.result as any).synthetic);
  assert.match(serializeCSV(s.frames, [], s.info()), /"file","true","2.0"/);
  s.recalculate(s.info().parameters);
  assert.equal(s.info().synthetic, true);
  s.reset('file');
  assert.equal(s.info().synthetic, false);
  s.reset('demo');
  assert.equal(s.info().synthetic, true);
  assert.throws(() => s.setFileSynthetic(false), /INVALID_PROVENANCE/);
  s.reset('camera');
  assert.equal(s.info().synthetic, false);
});
