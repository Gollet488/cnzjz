import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = new URL('../tests/fixtures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('browser-manifest.json', root), 'utf8'));
assert.equal(manifest.synthetic, true);
for (const entry of manifest.files) {
  const bytes = await readFile(new URL(entry.name, root));
  assert.equal(bytes.length, entry.bytes, entry.name);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.name);
}
console.log(`Browser fixtures verified: ${manifest.files.length} fixed files; synthetic=true`);
