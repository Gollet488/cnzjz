import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
let engine: Promise<PoseLandmarker> | undefined;
// WASM and model files are served locally. No video or frame leaves the browser.
export function getPoseEngine() {
  if (!engine)
    engine = (async () => {
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    })().catch((error) => {
      engine = undefined;
      throw error;
    });
  return engine;
}
