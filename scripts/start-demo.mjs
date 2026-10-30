import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkNode,
  root,
  vite,
  recordPath,
  assertOwner,
  processIdentity,
} from './demo-process.mjs';
import { healthPath } from './demo-health.mjs';

const { values } = parseArgs({
  options: {
    'no-open': { type: 'boolean' },
    production: { type: 'boolean' },
    port: { type: 'string', default: '5173' },
  },
});
const port = Number(values.port);
const url = `http://127.0.0.1:${port}/`;
const logPath = path.join(root, '.demo', 'server.log');
async function ready(state) {
  try {
    const response = await fetch(new URL(healthPath, url), { signal: AbortSignal.timeout(1200) });
    const info = await response.json();
    return response.ok && info.token === state.token && info.pid === state.pid;
  } catch {
    return false;
  }
}
function available() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(
          `Port ${port} is occupied by an unmanaged server; nothing was stopped. Choose --port <number>.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function openBrowser() {
  if (values['no-open']) return;
  const child =
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], {
          windowsHide: true,
          stdio: 'ignore',
        })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}
try {
  checkNode();
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('port must be 1024–65535');
  let state;
  if (existsSync(recordPath)) {
    state = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (assertOwner(state)) {
      if (
        state.url !== url ||
        Boolean(state.production) !== Boolean(values.production) ||
        !state.token ||
        !(await ready(state))
      )
        throw new Error(
          'Managed PID is still running but not ready at this address. Run stop-demo first; it was not replaced.',
        );
    } else {
      unlinkSync(recordPath);
      state = undefined;
    }
  }
  if (!state) {
    if (!existsSync(vite))
      throw new Error(
        'Dependencies missing. Install PATH Node 24.22.1 and pnpm 11.25.0; run pnpm install --frozen-lockfile, then pnpm prepare:assets.',
      );
    await available();
    if (values.production && !existsSync(path.join(root, 'dist', 'index.html')))
      throw new Error('Production build missing. Run pnpm build before --production.');
    mkdirSync(path.dirname(logPath), { recursive: true });
    const token = randomUUID();
    const log = openSync(logPath, 'w');
    const child = spawn(
      process.execPath,
      [
        vite,
        ...(values.production ? ['preview'] : []),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, KINETIC_DEMO_TOKEN: token },
      },
    );
    closeSync(log);
    let startError;
    child.on('error', (error) => {
      startError = error;
    });
    child.unref();
    state = { pid: child.pid, vite, url, token, production: Boolean(values.production) };
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      if (startError) throw startError;
      if (await ready(state)) {
        healthy = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!healthy) {
      // Only the child launched by this invocation may be cleaned up here.
      child.kill();
      throw new Error(`Server did not start.\n${readFileSync(logPath, 'utf8')}`);
    }
    try {
      const identity = processIdentity(child.pid);
      if (!identity) throw new Error('Cannot verify the new project PID.');
      state.created = identity.created;
      writeFileSync(recordPath, JSON.stringify(state, null, 2));
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  console.log(`Kinetic demo is ready: ${url}`);
  openBrowser();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
