import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function checkNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1))
    throw new Error('Use PATH Node >=24.22.1 <25 (see .node-version), and pnpm 11.25.0.');
}
export const root = fileURLToPath(new URL('../', import.meta.url));
export const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
export const recordPath = path.join(root, '.demo', 'server.json');
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid project PID.');
  if (process.platform === 'win32') {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    if (!output) return null;
    const info = JSON.parse(output);
    return { command: info.CommandLine ?? '', created: info.CreationDate };
  }
  try {
    return {
      command: execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim(),
      created: execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
      }).trim(),
    };
  } catch {
    return null;
  }
}
export function assertOwner(state) {
  if (path.resolve(state.vite ?? '') !== path.resolve(vite))
    throw new Error('Record belongs to another project.');
  const identity = processIdentity(state.pid);
  if (!identity) return false;
  const normalized = identity.command.replaceAll('\\', '/');
  const expected = vite.replaceAll('\\', '/');
  // Exact argument boundaries prevent matching a prefix/suffix of this path.
  if (
    !(normalized.includes(`"${expected}"`) || normalized.split(/\s+/).includes(expected)) ||
    (state.created && identity.created !== state.created)
  )
    throw new Error('PID does not belong to this demo; no process was stopped.');
  return true;
}
