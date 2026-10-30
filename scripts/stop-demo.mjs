import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { checkNode, recordPath, assertOwner } from './demo-process.mjs';
try {
  checkNode();
  if (!existsSync(recordPath)) console.log('No managed demo server to stop.');
  else {
    const state = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (assertOwner(state)) {
      process.kill(state.pid);
      console.log('Kinetic demo server stopped.');
    } else console.log('Demo server is already stopped.');
    unlinkSync(recordPath);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
