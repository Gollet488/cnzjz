import { createServer, preview, build } from 'vite';
import { execFileSync } from 'node:child_process';

// Spawn without a platform shell; production uses exactly the build checks.
const production = process.argv[2] === 'production';
execFileSync(process.execPath, ['scripts/check-browser-fixtures.mjs'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (production) {
  for (const args of [['scripts/check-assets.mjs'], ['node_modules/vue-tsc/bin/vue-tsc.js', '-b']])
    execFileSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  await build();
  await preview({ preview: { host: '127.0.0.1', port: 5187, strictPort: true } });
} else {
  const server = await createServer({
    cacheDir: process.env.BROWSER_VITE_CACHE || undefined,
    server: { host: '127.0.0.1', port: 5186, strictPort: true },
  });
  await server.listen();
}
