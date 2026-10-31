import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { snapshotPath, verifyManifest } from './delivery-manifest.mjs';

// A portable snapshot check, not a license decision or a replacement for CI.
const root = fileURLToPath(new URL('../', import.meta.url));
// pnpm can preserve the separator in script argv. Accept one leading separator.
const args = process.argv.slice(process.argv[2] === '--' ? 3 : 2);
if (args.length !== 2 || args[0] !== '--manifest' || !args[1])
  throw new Error(
    'Select a snapshot explicitly: node scripts/verify-delivery.mjs --manifest docs/evidence/<manifest.json>',
  );
const manifestPath = snapshotPath(args[1]);
const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'));
const result = await verifyManifest(root, manifest);
console.log(
  `Delivery snapshot verified: ${manifestPath} (${manifest.version}), ${result.checked} files, ${result.totalBytes} bytes. Hash integrity is not a new functional or CI run.`,
);
