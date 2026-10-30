// Offline, read-only acceptance. This module never connects to a provider.
import { readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyEfficiency, verdict } from '../src/agent/efficiency.ts';
import { parseCSV, verifyAudit } from '../tests/browser/files.ts';

async function verifyPageFiles(session, directory) {
  const evidence = session?.pageOracle?.evidence;
  if (!Array.isArray(evidence) || evidence.length !== 6) {
    session.pageOracle = {
      ...session.pageOracle,
      independentReplay: false,
      offlineError: 'six_required_source_files_missing',
    };
    return;
  }
  try {
    const [csv, ...files] = await Promise.all(
      evidence.map((file) => readFile(resolve(directory, file))),
    );
    const rows = parseCSV(csv);
    for (const [i, bytes] of files.slice(0, 3).entries()) {
      const audit = JSON.parse(bytes);
      const turn = session.turns[i];
      turn.nodeConsistent =
        JSON.stringify(audit.run) === JSON.stringify(turn.run) &&
        verifyAudit(rows, audit).length > 0;
    }
    const final = session.turns.at(-1)?.run;
    const report = JSON.parse(files[3]);
    const reportCall = final?.calls.findLast((c) => c.name === 'prepare_report' && c.output.ok);
    session.reportCorrect =
      session.reportCorrect === true &&
      report.kind === 'report' &&
      JSON.stringify(report.result) === JSON.stringify(reportCall?.output.result) &&
      report.reference.sessionId === rows[0].session_id &&
      report.reference.revision === Number(rows[0].session_revision);
    const prepared = parseCSV(files[4]);
    session.csvCorrect =
      session.csvCorrect === true &&
      JSON.stringify(prepared) ===
        JSON.stringify(rows.filter((r) => Number(r.time_s) >= 0 && Number(r.time_s) <= 17));
    session.pageOracle.independentReplay = session.turns.every((t) => t.nodeConsistent === true);
  } catch (error) {
    session.pageOracle.independentReplay = false;
    session.pageOracle.offlineError = String(error);
    // Missing source files are unknown; an existing but invalid source is a failure.
    if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') session.completed = false;
  }
}

async function verifyAuditFiles(record, directory) {
  const checks = [];
  for (const entry of record.runs ?? [])
    for (const turn of entry.turns ?? []) {
      const manifest = record.auditFiles?.find((file) => file.runId === turn.run?.id);
      const id = `audit:${turn.run?.id ?? 'missing'}`;
      if (!manifest?.path || !manifest?.sha256) {
        checks.push({ id, status: 'unmeasured', reason: 'primary_audit_manifest_missing' });
        continue;
      }
      try {
        let bytes;
        try {
          bytes = await readFile(resolve(directory, manifest.path));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          bytes = await readFile(resolve(directory, basename(manifest.path.replaceAll('\\', '/'))));
        }
        const audit = JSON.parse(bytes);
        const keys = [
          'id',
          'goal',
          'reference',
          'status',
          'calls',
          'citations',
          'rounds',
          'requests',
          'usage',
          'conversationCosts',
        ];
        const valid =
          createHash('sha256').update(bytes).digest('hex') === manifest.sha256 &&
          keys.every((key) => JSON.stringify(audit.run[key]) === JSON.stringify(turn.run[key])) &&
          audit.requests.length === turn.run.requests?.length &&
          audit.requests.every(
            (request, i) =>
              (request.reply?.usage?.inputTokens ?? null) === turn.run.requests[i].inputTokens &&
              (request.reply?.usage?.outputTokens ?? null) === turn.run.requests[i].outputTokens,
          );
        checks.push({
          id,
          status: valid ? 'passed' : 'failed',
          reason: 'primary_audit_hash_requests_and_execution_match_receipt',
        });
      } catch (error) {
        checks.push({
          id,
          status: error?.code === 'ENOENT' || error?.code === 'EACCES' ? 'unmeasured' : 'failed',
          reason: String(error),
        });
      }
    }
  return checks;
}

export async function verifyEfficiencyFile(path) {
  const record = JSON.parse(await readFile(path, 'utf8'));
  const directory = dirname(resolve(path));
  for (const session of record.sessions ?? [record])
    await verifyPageFiles(session, resolve(directory, session.evidenceDirectory ?? '.'));
  const report = verifyEfficiency(record);
  report.checks.push(...(await verifyAuditFiles(record, directory)));
  report.status = verdict([{ status: report.status }, ...report.checks]);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    if (args.length !== 1) throw new Error('Usage: pnpm verify:efficiency -- <evaluation.json>');
    const report = await verifyEfficiencyFile(args[0]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
