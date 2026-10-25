import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const url = 'http://127.0.0.1:5173/';
const stateDir = path.join(root, '.demo');
const logPath = path.join(stateDir, 'server.log');

async function ready() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok && (await response.text()).includes('Kinetic');
  } catch { return false; }
}

function openBrowser() {
  if (process.argv.includes('--no-open')) return;
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`Open this address in your browser: ${url}`));
  child.unref();
}

try {
  if (!await ready()) {
    if (!existsSync(vite)) throw new Error('Dependencies are missing. Run npm install first.');
    mkdirSync(stateDir, { recursive: true });
    const log = openSync(logPath, 'w');
    const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    closeSync(log);
    let startError;
    child.on('error', error => { startError = error; });
    child.unref();
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      if (startError) throw startError;
      if (await ready()) { healthy = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!healthy) throw new Error(`Server did not start.\n${readFileSync(logPath, 'utf8')}`);
    writeFileSync(path.join(stateDir, 'server.json'), JSON.stringify({ pid: child.pid, vite, url }, null, 2));
  }
  console.log(`Kinetic demo is ready: ${url}`);
  openBrowser();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
