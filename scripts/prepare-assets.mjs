import { mkdir, cp, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { modelURL, modelSHA256 } from './asset-policy.mjs';
const folder = new URL('../public/mediapipe/', import.meta.url);
await mkdir(folder, { recursive: true });
await cp(
  new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url),
  new URL('wasm/', folder),
  { recursive: true },
);
// The classic pose worker uses the installed CJS distribution so MediaPipe's
// WASM importScripts loader works in both Vite development and static builds.
await cp(
  new URL('../node_modules/@mediapipe/tasks-vision/vision_bundle.cjs', import.meta.url),
  new URL('vision_bundle.js', folder),
);
const model = new URL('pose_landmarker_lite.task', folder);
try {
  const bytes = await readFile(model);
  if (createHash('sha256').update(bytes).digest('hex') !== modelSHA256)
    throw new Error('Existing model SHA-256 mismatch; preserve and inspect it before replacing.');
  console.log('Model already present.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Downloading the official MediaPipe Lite model…');
  const response = await fetch(modelURL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`, { cause: error });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== modelSHA256)
    throw new Error('Downloaded model SHA-256 mismatch.', { cause: error });
  const temporary = new URL('pose_landmarker_lite.task.download', folder);
  await writeFile(temporary, bytes);
  await rename(temporary, model);
}
await import('./check-assets.mjs');
console.log('Local inference assets ready.');
