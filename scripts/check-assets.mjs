import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { modelSHA256 } from './asset-policy.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => readFile(new URL('../' + path, import.meta.url));
const pkg = JSON.parse(await read('node_modules/@mediapipe/tasks-vision/package.json'));
if (pkg.version !== '0.10.32')
  throw new Error('Unexpected MediaPipe version; review assets before updating.');
if (digest(await read('public/mediapipe/pose_landmarker_lite.task')) !== modelSHA256)
  throw new Error('Model SHA-256 mismatch. Preserve it and restore the official pinned model.');
for (const [source, target] of [
  ['vision_bundle.cjs', 'vision_bundle.js'],
  ...[
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ].map((name) => ['wasm/' + name, 'wasm/' + name]),
]) {
  if (
    digest(await read('node_modules/@mediapipe/tasks-vision/' + source)) !==
    digest(await read('public/mediapipe/' + target))
  )
    throw new Error(`Asset mismatch: ${target}. Run pnpm prepare:assets.`);
}
console.log('MediaPipe 0.10.32 assets and pinned Lite model SHA-256 verified.');
