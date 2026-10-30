import type { PoseFrame } from '../types.ts';
import type { AnalysisSession } from '../analysis/session.ts';
import { angleValue, channels } from './poseMath.ts';
import { JOINTS } from '../config.ts';
import { REPORT_LAYOUT, reportSize } from './dimensions.ts';
import { download } from './download.ts';
export { download } from './download.ts';
export { serializeCSV } from './csv.ts';
export { exportCSV } from './csvExport.ts';
export interface ReportContext {
  time?: number;
  reference?: ReturnType<AnalysisSession['info']>;
  assertCurrent?: () => void;
}
export function createReportCanvas(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  isDemo: boolean,
  context: ReportContext = {},
) {
  const size = reportSize(canvas);
  const report = document.createElement('canvas');
  report.width = size.width;
  report.height = size.height;
  const ctx = report.getContext('2d')!;
  const { margin, imageTop } = REPORT_LAYOUT;
  ctx.fillStyle = '#f3f6f5';
  ctx.fillRect(0, 0, report.width, report.height);
  ctx.fillStyle = '#172e2b';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText('KINETIC / 动观 · 姿态量化报告', margin, 76);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#64807a';
  ctx.fillText(
    `${isDemo ? '合成演示数据' : '本地采集数据'} · filtered · 画面 ${context.time?.toFixed(3) ?? '—'} s · ${new Date().toLocaleString('zh-CN')}`,
    margin,
    118,
  );
  // Match the source aspect exactly. No second image box, crop or letterbox.
  ctx.drawImage(canvas, margin, imageTop, size.imageWidth, size.imageHeight);
  const top = imageTop + size.imageHeight;
  const avg = (v: number[]) => (v.length ? v.reduce((s, n) => s + n, 0) / v.length : null);
  const centers = frames.flatMap((f) => (f.center ? [f.center.y] : [])),
    asym = frames.flatMap((f) => (f.asymmetry === null ? [] : [f.asymmetry]));
  ctx.fillStyle = '#172e2b';
  ctx.font = '24px sans-serif';
  ctx.fillText(
    `统计区间 ${frames[0]?.time.toFixed(3) ?? '—'}–${frames.at(-1)?.time.toFixed(3) ?? '—'} s    样本 ${frames.length}    平均不对称 ${avg(asym)?.toFixed(2) ?? '—'}%`,
    margin,
    top + 52,
  );
  ctx.fillText(
    `重心纵向范围 ${centers.length ? (Math.max(...centers) - Math.min(...centers)).toFixed(4) : '—'}（归一化坐标）`,
    margin,
    top + 96,
  );
  ctx.font = '20px sans-serif';
  JOINTS.forEach((j, i) => {
    const ranges = channels(j.key).flatMap((side) => {
      const values = frames.flatMap((f) =>
        angleValue(f.angles, j.key, side) === null ? [] : [angleValue(f.angles, j.key, side)!],
      );
      return values.length >= 2 ? [Math.max(...values) - Math.min(...values)] : [];
    });
    const speeds = frames.slice(1).flatMap((f) =>
      channels(j.key)
        .map((side) => angleValue(f.velocity, j.key, side))
        .filter((n): n is number => n !== null),
    );
    ctx.fillText(
      `${j.label}${j.key === 'spine' ? '（中线）' : ''}   最大 ROM ${ranges.length ? Math.max(...ranges).toFixed(1) : '—'}°   峰值 ${speeds.length ? Math.max(...speeds.map(Math.abs)).toFixed(1) : '—'}°/s`,
      margin + (i % 2) * 660,
      top + 150 + Math.floor(i / 2) * 40,
    );
  });
  ctx.fillStyle = '#64807a';
  ctx.font = '17px sans-serif';
  const reference = context.reference;
  ctx.fillText(
    `filtered · 双侧各自统计取最大 ROM / 绝对速度峰值；缺失留空；区间首帧不借用区间外速度。`,
    margin,
    top + 315,
  );
  if (reference) {
    ctx.fillText(
      `会话 ${reference.sessionId} · revision ${reference.revision} · ${reference.source} · synthetic=${reference.synthetic}`,
      margin,
      top + 350,
    );
    ctx.fillText(
      `阈值 ${reference.parameters.threshold} · 窗口 ${reference.parameters.window} 帧 · 源宽高比 ${reference.parameters.aspect.toFixed(6)} · 指标 ${reference.parameters.metricVersion}${reference.acquisition ? ` · ${reference.acquisition.status} ${reference.acquisition.processedFrames}/${reference.acquisition.expectedFrames ?? '—'} 帧` : ''}`,
      margin,
      top + 382,
    );
  }
  ctx.fillStyle = '#7a8c87';
  ctx.fillText(
    '单人单目 2D 平面投影；髋中点仅为重心近似。仅供相对对比，不用于动作对错判定。',
    margin,
    top + 425,
  );
  return report;
}
export async function exportReport(
  canvas: HTMLCanvasElement,
  frames: PoseFrame[],
  isDemo: boolean,
  context: ReportContext = {},
) {
  context.assertCurrent?.();
  const report = createReportCanvas(canvas, frames, isDemo, context);
  const blob = await new Promise<Blob>((resolve, reject) =>
    report.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('PNG 编码失败'))),
      'image/png',
    ),
  );
  context.assertCurrent?.();
  download(blob, `kinetic-report-${Date.now()}.png`);
}
