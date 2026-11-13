import { createServer, preview, build } from 'vite';
import { execFileSync } from 'node:child_process';

function checkFixtures() {
  execFileSync(process.execPath, ['scripts/check-browser-fixtures.mjs'], {
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function productionPreview() {
  checkFixtures();
  // Spawn without a platform shell; production uses exactly the build checks.
  for (const args of [['scripts/check-assets.mjs'], ['node_modules/vue-tsc/bin/vue-tsc.js', '-b']])
    execFileSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  const buildOptions = { outDir: 'test-results/browser-dist' };
  await build({ build: buildOptions });
  return preview({
    build: buildOptions,
    preview: { host: '127.0.0.1', port: 5187, strictPort: true },
  });
}

// Playwright global setup for human acceptance. Own the listening socket in
// process so teardown on Windows does not depend on taskkill /T.
export default async function setupHumanPreview() {
  const { httpServer } = await productionPreview();
  return () =>
    new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
      httpServer.closeAllConnections();
    });
}

if (import.meta.main) {
  if (process.argv[2] === 'production') await productionPreview();
  else {
    checkFixtures();
    const server = await createServer({
      cacheDir: process.env.BROWSER_VITE_CACHE || undefined,
      server: { host: '127.0.0.1', port: 5186, strictPort: true },
    });
    await server.listen();
  }
}
