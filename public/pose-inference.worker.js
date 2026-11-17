// Classic worker: MediaPipe 0.10.32 loads its WASM glue with importScripts.
// The installed CJS distribution exposes exports; no CDN or eval shim is used.
self.exports = {};
const assets = new URL('./mediapipe/', self.location.href).href;
importScripts(`${assets}vision_bundle.js`);
let engine;
let detector;
let acquisitionDetector;
let vision;
const offlineDetectionConfidence = 0.75;
const models = {
  baseOptions: { delegate: 'CPU' },
  numPoses: 1,
};
async function readModel(cache) {
  const response = await fetch(`${assets}pose_landmarker_lite.task`, { cache });
  if (!response.ok) throw new Error(`本地姿态模型加载失败（HTTP ${response.status}）。`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadModel() {
  try {
    return await readModel('default');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Retry a transport failure once, bypassing the cache for the interrupted response.
    return readModel('reload');
  }
}
// MediaPipe labels joints by anatomical side. Reflecting an image swaps sides.
const mirroredIndices = [
  0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24,
  23, 26, 25, 28, 27, 30, 29, 32, 31,
];
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      models.baseOptions.modelAssetBuffer = await loadModel();
      vision = await self.exports.FilesetResolver.forVisionTasks(`${assets}wasm`);
      engine = await self.exports.PoseLandmarker.createFromOptions(vision, {
        ...models,
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO',
        minPoseDetectionConfidence: data.offline ? offlineDetectionConfidence : 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'detect') {
      try {
        let image = data.bitmap;
        const crop = data.crop;
        if (crop) {
          const { width, height } = data.bitmap;
          image = new OffscreenCanvas(
            Math.max(1, Math.round(crop.width * width)),
            Math.max(1, Math.round(crop.height * height)),
          );
          image.getContext('2d').drawImage(
            data.bitmap,
            crop.x * width,
            crop.y * height,
            crop.width * width,
            crop.height * height,
            0,
            0,
            image.width,
            image.height,
          );
        } else if (data.mirrored) {
          const { width, height } = data.bitmap;
          image = new OffscreenCanvas(width, height);
          const context = image.getContext('2d');
          context.setTransform(-1, 0, 0, 1, width, 0);
          context.drawImage(data.bitmap, 0, 0);
        }
        // Keep stateless retries separate from the VIDEO graph's tracking state.
        const result = data.redetect
          ? (await imageDetector(data.strict)).detect(image)
          : engine.detectForVideo(image, data.timestamp);
        const landmarks = result.landmarks[0];
        const points =
          landmarks?.map((point, i) => {
            const p = data.mirrored ? landmarks[mirroredIndices[i]] : point;
            return {
              x: crop ? crop.x + p.x * crop.width : data.mirrored ? 1 - p.x : p.x,
              y: crop ? crop.y + p.y * crop.height : p.y,
              z: crop ? p.z * crop.width : p.z,
              visibility: p.visibility ?? 0,
            };
          }) ?? [];
        result.close();
        if (data.preview)
          self.postMessage({ type: 'result', points, bitmap: data.bitmap }, [data.bitmap]);
        else self.postMessage({ type: 'result', points });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};

function imageDetector(strict) {
  const existing = strict ? acquisitionDetector : detector;
  if (existing) return existing;
  const options = {
    ...models,
    canvas: new OffscreenCanvas(1, 1),
    runningMode: 'IMAGE',
    minPoseDetectionConfidence: strict ? offlineDetectionConfidence : 0.35,
    minPosePresenceConfidence: strict ? 0.5 : 0.4,
  };
  const pending = self.exports.PoseLandmarker.createFromOptions(vision, options);
  if (strict) acquisitionDetector = pending;
  else detector = pending;
  return pending;
}
