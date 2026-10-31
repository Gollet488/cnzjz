// Classic worker: MediaPipe 0.10.32 loads its WASM glue with importScripts.
// The installed CJS distribution exposes exports; no CDN or eval shim is used.
self.exports = {};
importScripts('/mediapipe/vision_bundle.js');
let engine;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const vision = await self.exports.FilesetResolver.forVisionTasks('/mediapipe/wasm');
      engine = await self.exports.PoseLandmarker.createFromOptions(vision, {
        canvas: new OffscreenCanvas(1, 1),
        baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'detect') {
      try {
        const result = engine.detectForVideo(data.bitmap, data.timestamp);
        const points =
          result.landmarks[0]?.map((p) => ({
            x: p.x,
            y: p.y,
            z: p.z,
            visibility: p.visibility ?? 0,
          })) ?? [];
        result.close();
        self.postMessage({ type: 'result', points });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) });
  }
};
