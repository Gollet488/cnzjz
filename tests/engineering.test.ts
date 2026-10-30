import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  copyFile,
  symlink,
  writeFile,
  readFile,
  lstat,
  unlink,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = path.join(root, '.qa');
const temporaryDirectories: string[] = [];
after(async () => {
  for (const folder of temporaryDirectories) {
    const child = path.relative(scratchRoot, path.resolve(folder));
    assert.ok(
      !child.startsWith('..') &&
        !path.isAbsolute(child) &&
        child.startsWith('kinetic launcher space '),
    );
    // Remove only this fixture's junction before recursive cleanup. Never
    // traverse the shared dependency directory through a Windows junction.
    const link = path.join(folder, 'node_modules');
    try {
      assert.ok((await lstat(link)).isSymbolicLink());
      await unlink(link);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rm(folder, { recursive: true });
  }
});
async function fixture(dependencies = true) {
  await mkdir(scratchRoot, { recursive: true });
  const folder = await mkdtemp(path.join(scratchRoot, 'kinetic launcher space '));
  temporaryDirectories.push(folder);
  await mkdir(path.join(folder, 'scripts'));
  for (const name of ['start-demo.mjs', 'stop-demo.mjs', 'demo-process.mjs', 'demo-health.mjs'])
    await copyFile(path.join(root, 'scripts', name), path.join(folder, 'scripts', name));
  if (process.platform === 'win32')
    for (const name of ['启动Demo.cmd', '停止Demo.cmd'])
      await copyFile(path.join(root, name), path.join(folder, name));
  await writeFile(path.join(folder, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(folder, 'index.html'), '<title>Kinetic launcher test</title>');
  await writeFile(
    path.join(folder, 'vite.config.mjs'),
    "import {demoHealth} from './scripts/demo-health.mjs'; export default {plugins:[demoHealth()]};",
  );
  if (dependencies)
    await symlink(
      path.join(root, 'node_modules'),
      path.join(folder, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  return folder;
}
const run = (folder: string, name: string, ...args: string[]) =>
  execute(process.execPath, [path.join(folder, 'scripts', name + '-demo.mjs'), ...args], {
    cwd: folder,
    windowsHide: true,
    timeout: 30_000,
  });
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  'launcher handles paths with spaces, repeated start/stop and refuses a reused foreign PID',
  { timeout: 60_000 },
  async () => {
    const folder = await fixture();
    const port = String(await freePort());
    const record = path.join(folder, '.demo', 'server.json');
    let original;
    try {
      await run(folder, 'start', '--no-open', '--port', port);
      original = JSON.parse(await readFile(record, 'utf8'));
      if (process.platform === 'win32')
        await execute('cmd.exe', ['/d', '/s', '/c', `启动Demo.cmd --no-open --port ${port}`], {
          cwd: folder,
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 15_000,
        });
      await run(folder, 'start', '--no-open', '--port', port);
      assert.equal(JSON.parse(await readFile(record, 'utf8')).pid, original.pid);
      await writeFile(record, JSON.stringify({ ...original, pid: process.pid }));
      await assert.rejects(run(folder, 'stop'), /PID does not belong/);
      assert.equal((await fetch(original.url)).status, 200);
      await writeFile(record, JSON.stringify(original));
      await run(folder, 'stop');
      await run(folder, 'stop');
      await assert.rejects(fetch(original.url));
    } finally {
      if (original) {
        await writeFile(record, JSON.stringify(original));
        await run(folder, 'stop').catch(() => {});
      }
    }
  },
);
test('occupied unmanaged port is preserved; missing dependencies explain frozen pnpm install', async () => {
  const folder = await fixture();
  const server = createServer((socket) =>
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nKinetic'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      run(
        folder,
        'start',
        '--no-open',
        '--port',
        String((server.address() as { port: number }).port),
      ),
      /occupied by an unmanaged server/,
    );
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assert.rejects(
    run(await fixture(false), 'start', '--no-open'),
    /pnpm install --frozen-lockfile/,
  );
});

test('production launcher uses existing build, exact preview health, refuses mode reuse and stops same PID', async () => {
  const folder = await fixture();
  const port = String(await freePort());
  const record = path.join(folder, '.demo', 'server.json');
  await assert.rejects(
    run(folder, 'start', '--no-open', '--production', '--port', port),
    /Production build missing/,
  );
  await mkdir(path.join(folder, 'dist'));
  await writeFile(path.join(folder, 'dist', 'index.html'), '<title>Production fixture</title>');
  let started = false;
  try {
    await run(folder, 'start', '--no-open', '--production', '--port', port);
    started = true;
    const state = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(state.production, true);
    assert.match(await (await fetch(state.url)).text(), /Production fixture/);
    await run(folder, 'start', '--no-open', '--production', '--port', port);
    assert.equal(JSON.parse(await readFile(record, 'utf8')).pid, state.pid);
    await assert.rejects(
      run(folder, 'start', '--no-open', '--port', port),
      /not ready at this address/,
    );
    await run(folder, 'stop');
    started = false;
    await assert.rejects(fetch(state.url));
  } finally {
    if (started) await run(folder, 'stop');
  }
});
