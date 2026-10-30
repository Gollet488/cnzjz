// The synthetic coordinate system is also the analysis aspect ratio.
export const DEMO_SIZE = { width: 850, height: 590 } as const;
export const STAGE_WIDTH = 1100;
export const REPORT_LAYOUT = {
  width: 1440,
  margin: 60,
  imageTop: 155,
  summaryHeight: 460,
} as const;
export function stageSize(aspect = DEMO_SIZE.width / DEMO_SIZE.height) {
  if (!Number.isFinite(aspect) || aspect <= 0) aspect = DEMO_SIZE.width / DEMO_SIZE.height;
  if (Math.abs(aspect - DEMO_SIZE.width / DEMO_SIZE.height) < 1e-12) return { ...DEMO_SIZE };
  return { width: STAGE_WIDTH, height: Math.max(1, Math.round(STAGE_WIDTH / aspect)) };
}
export function reportSize(source: { width: number; height: number }) {
  const imageWidth = REPORT_LAYOUT.width - REPORT_LAYOUT.margin * 2;
  const imageHeight = (imageWidth * source.height) / source.width;
  return {
    width: REPORT_LAYOUT.width,
    height: Math.ceil(REPORT_LAYOUT.imageTop + imageHeight + REPORT_LAYOUT.summaryHeight),
    imageWidth,
    imageHeight,
  };
}
