import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const excludedSegments = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'dist',
  '.qa',
  '.demo',
  'test-results',
  'playwright-report',
]);

// Portable repository-relative paths only. Resolve files as filesystem paths,
// never as URLs (which would interpret percent escapes or fragment characters).
export function snapshotPath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    value.split('/').some((part) => excludedSegments.has(part.toLowerCase())) ||
    (value !== '.env.example' && /(?:^|\/)\.env(?:\.|$)/i.test(value)) ||
    /\.tsbuildinfo$/i.test(value)
  )
    throw new Error(`Invalid or excluded delivery path: ${String(value)}`);
  return value;
}

async function fileWithin(root, relative) {
  const checked = snapshotPath(relative);
  const absoluteRoot = await realpath(root);
  const absolute = path.resolve(root, ...checked.split('/'));
  const actual = await realpath(absolute);
  const child = path.relative(absoluteRoot, actual);
  if (!child || child.startsWith(`..${path.sep}`) || child === '..' || path.isAbsolute(child))
    throw new Error(`Delivery path escapes repository: ${relative}`);
  if (!(await lstat(absolute)).isFile())
    throw new Error(`Delivery entry must be a regular file: ${relative}`);
  return absolute;
}

export async function fingerprintFile(root, relative) {
  const bytes = await readFile(await fileWithin(root, relative));
  return {
    path: relative,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function verifyManifest(root, manifest) {
  if (
    !manifest ||
    !Array.isArray(manifest.sourceFiles) ||
    !Array.isArray(manifest.evidenceFiles) ||
    manifest.sourceFiles.length === 0
  )
    throw new Error('Delivery manifest requires nonempty sourceFiles and an evidenceFiles array');
  const seen = new Set();
  let checked = 0;
  let totalBytes = 0;
  for (const entry of [...manifest.sourceFiles, ...manifest.evidenceFiles]) {
    snapshotPath(entry?.path);
    if (
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error(`Invalid or duplicate delivery entry: ${entry.path}`);
    seen.add(entry.path);
    const actual = await fingerprintFile(root, entry.path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      throw new Error(`Delivery snapshot mismatch: ${entry.path}`);
    checked++;
    totalBytes += actual.bytes;
  }
  return { checked, totalBytes };
}

const sourceRoots = ['.github', 'public', 'scripts', 'src', 'tests'];
const rootFiles = [
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.prettierignore',
  '.prettierrc.json',
  'eslint.config.mjs',
  'index.html',
  'package.json',
  'playwright.config.ts',
  'playwright.real.config.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'README.md',
  'requirement.md',
  'tsconfig.json',
  'vite.config.ts',
  '启动Demo.cmd',
  '停止Demo.cmd',
];

async function collect(root, relative, onlyMarkdown = false) {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (excludedSegments.has(entry.name.toLowerCase())) continue;
    if (relative === 'docs' && entry.name === 'evidence') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink in delivery source: ${child}`);
    if (entry.isDirectory()) result.push(...(await collect(root, child, onlyMarkdown)));
    else if (entry.isFile() && (!onlyMarkdown || child.endsWith('.md')))
      result.push(snapshotPath(child));
  }
  return result;
}

export async function createManifest(root, evidencePaths, metadata = {}) {
  if (!Array.isArray(evidencePaths) || evidencePaths.length === 0)
    throw new Error('Select a nonempty explicit evidence file list');
  const sourcePaths = [...rootFiles];
  for (const directory of sourceRoots) sourcePaths.push(...(await collect(root, directory)));
  sourcePaths.push(...(await collect(root, 'docs', true)));
  const sources = new Set(sourcePaths);
  const selected = new Set();
  for (const relative of evidencePaths) {
    snapshotPath(relative);
    if (!relative.startsWith('docs/evidence/'))
      throw new Error(`Evidence must be selected from docs/evidence: ${relative}`);
    if (selected.has(relative) || sources.has(relative))
      throw new Error(`Duplicate selected evidence: ${relative}`);
    selected.add(relative);
  }
  const fingerprint = async (paths) => {
    const result = [];
    for (const relative of [...paths].sort()) result.push(await fingerprintFile(root, relative));
    return result;
  };
  return {
    version: 'H-1',
    createdAt: new Date().toISOString(),
    ...metadata,
    scope:
      'Uncommitted H candidate source, configuration, local assets and explicitly selected reproducible evidence. Hash integrity is not functional acceptance, remote CI, licensing or redistribution approval.',
    excludes: [
      'This manifest (self)',
      '.git, node_modules, .pnpm-store, dist, .qa, .demo, test-results, playwright-report',
      'Temporary build metadata and environment secrets',
      'Unselected historical evidence and repeated large benchmark CSV files',
    ],
    sourceFiles: await fingerprint(sourcePaths),
    evidenceFiles: await fingerprint(selected),
  };
}

export async function writeManifest(root, output, manifest) {
  snapshotPath(output);
  if (!output.startsWith('docs/evidence/'))
    throw new Error('Delivery manifest output must be within docs/evidence');
  if ([...manifest.sourceFiles, ...manifest.evidenceFiles].some((entry) => entry.path === output))
    throw new Error('Delivery manifest cannot fingerprint itself');
  // Refuse to replace any historical manifest or existing candidate.
  await writeFile(path.join(root, output), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
}
