import { mkdir, cp, access, writeFile } from 'node:fs/promises';
const folder=new URL('../public/mediapipe/',import.meta.url);
await mkdir(folder,{recursive:true});
await cp(new URL('../node_modules/@mediapipe/tasks-vision/wasm/',import.meta.url),new URL('wasm/',folder),{recursive:true});
const model=new URL('pose_landmarker_lite.task',folder);
try {await access(model);console.log('Model already present.');}catch {
  console.log('Downloading the official MediaPipe Lite model…');
  const response=await fetch('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task');
  if(!response.ok)throw new Error(`Model download failed: ${response.status}`);
  await writeFile(model,new Uint8Array(await response.arrayBuffer()));
}
console.log('Local inference assets ready.');
