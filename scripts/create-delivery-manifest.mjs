import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createManifest, snapshotPath, writeManifest } from './delivery-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// pnpm can preserve the separator in script argv. Accept one leading separator
// while keeping the exact option count and all path checks unchanged.
const args = process.argv.slice(process.argv[2] === '--' ? 3 : 2);
if (
  args.length !== 4 ||
  args[0] !== '--output' ||
  args[2] !== '--evidence-list' ||
  !args[1] ||
  !args[3]
)
  throw new Error(
    'Usage: node scripts/create-delivery-manifest.mjs --output docs/evidence/<new-manifest.json> --evidence-list docs/evidence/<selected-files.json>',
  );
const [output, evidenceList] = [snapshotPath(args[1]), snapshotPath(args[3])];
const selected = JSON.parse(await readFile(path.join(root, evidenceList), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const manifest = await createManifest(root, selected, { head, evidenceList });
await writeManifest(root, output, manifest);
console.log(
  `Created ${output}: ${manifest.sourceFiles.length} source/configuration/asset files, ${manifest.evidenceFiles.length} evidence files. Existing snapshots were preserved.`,
);
