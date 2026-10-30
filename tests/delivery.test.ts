import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  createManifest,
  fingerprintFile,
  snapshotPath,
  verifyManifest,
  writeManifest,
} from '../scripts/delivery-manifest.mjs';

const directories: string[] = [];
const repository = fileURLToPath(new URL('../', import.meta.url));
async function deliveryFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinetic-delivery-'));
  directories.push(directory);
  await mkdir(path.join(directory, '.github'));
  for (const name of [
    'src/App.vue',
    'package.json',
    'pnpm-lock.yaml',
    'public/mediapipe/pose_landmarker_lite.task',
    'tests/fixtures/browser-manifest.json',
    'scripts/verify-delivery.mjs',
    'docs/architecture.md',
    'docs/evidence/selected.json',
    '.gitattributes',
    '.gitignore',
    '.node-version',
    '.prettierignore',
    '.prettierrc.json',
    'eslint.config.mjs',
    'index.html',
    'playwright.config.ts',
    'playwright.real.config.ts',
    'pnpm-workspace.yaml',
    'README.md',
    'requirement.md',
    'tsconfig.json',
    'vite.config.ts',
    '启动Demo.cmd',
    '停止Demo.cmd',
  ]) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), '{}');
  }
  for (const name of ['verify-delivery.mjs', 'delivery-manifest.mjs'])
    await copyFile(path.join(repository, 'scripts', name), path.join(directory, 'scripts', name));
  return directory;
}
after(async () => {
  for (const directory of directories) {
    const child = path.relative(path.resolve(tmpdir()), path.resolve(directory));
    assert.ok(
      !child.startsWith('..') && !path.isAbsolute(child) && child.startsWith('kinetic-delivery-'),
    );
    await rm(directory, { recursive: true });
  }
});

test('delivery selection rejects traversal, dependency copies, build outputs and secrets', () => {
  for (const name of [
    '../source.ts',
    'src/../source.ts',
    '/absolute.json',
    'C:/external.json',
    'src\\file.ts',
    'src//file.ts',
    'node_modules/package/index.js',
    'docs/evidence/copy/node_modules/dependency.js',
    'dist/index.html',
    '.qa/output.json',
    'test-results/results.json',
    '.env',
    'src/.env.local',
    'tsconfig.tsbuildinfo',
  ])
    assert.throws(() => snapshotPath(name), /Invalid or excluded delivery path/);
  assert.equal(
    snapshotPath('docs/evidence/phase-h5/result.json'),
    'docs/evidence/phase-h5/result.json',
  );
  assert.equal(snapshotPath('启动Demo.cmd'), '启动Demo.cmd');
});

test('delivery verification detects a changed byte, duplicate entries and missing hash metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinetic-delivery-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'source.ts'), 'export const value = 1;\n');
  const entry = await fingerprintFile(directory, 'source.ts');
  const manifest = { sourceFiles: [entry], evidenceFiles: [] };
  assert.deepEqual(await verifyManifest(directory, manifest), {
    checked: 1,
    totalBytes: entry.bytes,
  });
  await assert.rejects(
    verifyManifest(directory, { sourceFiles: [entry], evidenceFiles: [entry] }),
    /Invalid or duplicate/,
  );
  await assert.rejects(
    verifyManifest(directory, { sourceFiles: [{ ...entry, sha256: null }], evidenceFiles: [] }),
    /Invalid or duplicate/,
  );
  await writeFile(path.join(directory, 'source.ts'), 'export const value = 2;\n');
  await assert.rejects(verifyManifest(directory, manifest), /snapshot mismatch: source.ts/);
});

test('new manifest writing refuses overwrite and self fingerprints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinetic-delivery-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'docs/evidence'), { recursive: true });
  const output = 'docs/evidence/manifest.json';
  const manifest = { version: 'H-1', sourceFiles: [], evidenceFiles: [] };
  await writeManifest(directory, output, manifest);
  const original = await readFile(path.join(directory, output), 'utf8');
  await assert.rejects(writeManifest(directory, output, { ...manifest, version: 'changed' }), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(path.join(directory, output), 'utf8'), original);
  await assert.rejects(
    writeManifest(directory, 'docs/evidence/other.json', {
      ...manifest,
      evidenceFiles: [{ path: 'docs/evidence/other.json' }],
    }),
    /cannot fingerprint itself/,
  );
});

test('manifest includes source, configuration and assets while evidence remains explicit', async () => {
  const directory = await deliveryFixture();
  const selected = 'docs/evidence/selected.json';
  const original = await readFile(path.join(directory, selected));
  const manifest = await createManifest(directory, [selected], { head: 'fixture-only' });
  const sources = new Set(manifest.sourceFiles.map((entry: any) => entry.path));
  for (const expected of [
    'src/App.vue',
    'package.json',
    'pnpm-lock.yaml',
    'public/mediapipe/pose_landmarker_lite.task',
    'tests/fixtures/browser-manifest.json',
    'scripts/verify-delivery.mjs',
    'requirement.md',
    'docs/architecture.md',
  ])
    assert.ok(sources.has(expected), `Missing delivery input: ${expected}`);
  assert.ok(
    [...sources].every(
      (entry) => !entry.startsWith('docs/evidence/') && !entry.startsWith('node_modules/'),
    ),
  );
  assert.deepEqual(
    manifest.evidenceFiles.map((entry: any) => entry.path),
    [selected],
  );
  assert.equal((await verifyManifest(directory, manifest)).checked, sources.size + 1);
  assert.deepEqual(await readFile(path.join(directory, selected)), original);
});

test('verification CLI requires an explicit manifest and does not silently use G', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/verify-delivery.mjs'], {
        cwd: repository,
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe',
      }),
    /Select a snapshot explicitly/,
  );
});

test('verification CLI accepts one optional pnpm delimiter and detects changed source', async () => {
  const directory = await deliveryFixture();
  const manifest = await createManifest(directory, ['docs/evidence/selected.json']);
  await writeManifest(directory, 'docs/evidence/manifest.json', manifest);
  await writeFile(path.join(directory, 'src/App.vue'), 'changed');
  for (const delimiter of [[], ['--']])
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            path.join(directory, 'scripts/verify-delivery.mjs'),
            ...delimiter,
            '--manifest',
            'docs/evidence/manifest.json',
          ],
          { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
        ),
      // Argument parsing must reach actual integrity checking.
      /Delivery snapshot mismatch:/,
    );
});

test('creation CLI accepts one optional pnpm delimiter and reaches evidence reading', () => {
  for (const delimiter of [[], ['--']])
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            path.join(repository, 'scripts/create-delivery-manifest.mjs'),
            ...delimiter,
            '--output',
            'docs/evidence/unused-cli-test-manifest.json',
            '--evidence-list',
            'docs/evidence/absent-cli-test-list.json',
          ],
          { cwd: repository, encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
        ),
      /ENOENT/,
    );
});

test('delivery CLIs continue to reject duplicate delimiters and traversal paths', () => {
  for (const [script, args, expected] of [
    [
      'verify-delivery.mjs',
      ['--', '--', '--manifest', 'docs/evidence/stage-g/delivery-manifest.json'],
      /Select a snapshot explicitly/,
    ],
    [
      'create-delivery-manifest.mjs',
      ['--', '--', '--output', 'docs/evidence/new.json', '--evidence-list', '../outside.json'],
      /Usage:/,
    ],
    ['verify-delivery.mjs', ['--', '--manifest', '../outside.json'], /Invalid or excluded/],
    [
      'create-delivery-manifest.mjs',
      ['--', '--output', '../outside.json', '--evidence-list', 'docs/evidence/list.json'],
      /Invalid or excluded/,
    ],
  ] as const)
    assert.throws(
      () =>
        execFileSync(process.execPath, [`scripts/${script}`, ...args], {
          cwd: repository,
          encoding: 'utf8',
          windowsHide: true,
          stdio: 'pipe',
        }),
      expected,
    );
});
