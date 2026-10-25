import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const record = fileURLToPath(new URL('../.demo/server.json', import.meta.url));
if (!existsSync(record)) { console.log('No managed demo server to stop.'); process.exit(0); }
const state = JSON.parse(readFileSync(record, 'utf8'));
if (!Number.isSafeInteger(state.pid) || state.pid <= 0) throw new Error('Invalid server record.');
// Check the command line before stopping a persisted PID: Windows may reuse it.
const output = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}' | Select-Object CommandLine | ConvertTo-Json -Compress`,
], { encoding: 'utf8', windowsHide: true }).trim();
if (output) {
  const command = JSON.parse(output).CommandLine ?? '';
  const expected = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  if (!command.toLowerCase().includes(expected.toLowerCase())) throw new Error('PID does not belong to this demo; no process was stopped.');
  process.kill(state.pid);
  console.log('Kinetic demo server stopped.');
} else console.log('Demo server is already stopped.');
unlinkSync(record);
