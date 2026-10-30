import { readFile } from 'node:fs/promises';
import { parseCSV, replayFullCSV, verifyAudit } from '../tests/browser/files.ts';

const [csv, ...audits] = process.argv.slice(2);
if (!csv)
  throw new Error(
    'Usage: pnpm verify:browser-files <downloaded-session.csv> [downloaded-audit.json ...]',
  );
const rows = parseCSV(await readFile(csv));
const fullReplay = replayFullCSV(rows);
console.log(
  JSON.stringify({
    csv,
    rows: rows.length,
    sessionId: rows[0].session_id,
    revision: Number(rows[0].session_revision),
    synthetic: rows[0].synthetic,
    nodeRawReplay: 'passed',
    fullReplay,
  }),
);
for (const path of audits) {
  const audit = JSON.parse(await readFile(path, 'utf8'));
  const checked = verifyAudit(rows, audit);
  console.log(
    JSON.stringify({
      audit: path,
      status: audit.run.status,
      checked,
      numericalEvidence: checked.length ? 'passed' : 'none; not a successful analysis',
    }),
  );
}
