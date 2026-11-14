// Classic worker: MediaPipe 0.10.32 loads its WASM glue with importScripts.
// The installed CJS distribution exposes exports; no CDN or eval shim is used.
self.exports = {};
const assets = new URL('./mediapipe/', self.location.href).href;
importScripts(`${assets}vision_bundle.js`);
let engine;
let detector;
let vision;
const models = {
  baseOptions: { modelAssetPath: `${assets}pose_landmarker_lite.task`, delegate: 'CPU' },
  numPoses: 1,
};
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      vision = await self.exports.FilesetResolver.forVisionTasks(`${assets}wasm`);
      engine = await self.exports.PoseLandmarker.createFromOptions(vision, {
        ...models,
        canvas: new OffscreenCanvas(1, 1),
        runningMode: 'VIDEO',
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'detect') {
      try {
        let image = data.bitmap;
        const crop = data.crop;
        if (data.redetect) {
          // Keep the tracked ROI and temporal filters in the VIDEO graph.
          detector ??= await self.exports.PoseLandmarker.createFromOptions(vision, {
            ...models,
            canvas: new OffscreenCanvas(1, 1),
            runningMode: 'IMAGE',
            minPoseDetectionConfidence: 0.35,
            minPosePresenceConfidence: 0.4,
          });
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
          }
        }
        const result = data.redetect
          ? detector.detect(image)
          : engine.detectForVideo(image, data.timestamp);
        const points =
          result.landmarks[0]?.map((p) => ({
            x: crop ? crop.x + p.x * crop.width : p.x,
            y: crop ? crop.y + p.y * crop.height : p.y,
            z: crop ? p.z * crop.width : p.z,
            visibility: p.visibility ?? 0,
          })) ?? [];
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
