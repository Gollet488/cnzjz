import type { Landmark, Settings } from '../types';
import { CONNECTIONS, JOINTS } from '../config';
import { jointAngles, centerOfMass } from './poseMath';
import { angleValue } from './poseMath';
import { LABEL_ANCHORS, placeLabel } from './visualization';
import type { LabelBox } from './visualization';
export function renderPose(
  canvas: HTMLCanvasElement,
  points: Landmark[],
  settings: Settings,
  video?: HTMLVideoElement | ImageBitmap,
  trail: ({ x: number; y: number } | null)[] = [],
  sourceAspect?: number,
) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#182c34');
  bg.addColorStop(1, '#101d24');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  let ox = 0,
    oy = 0,
    dw = w,
    dh = h;
  const videoWidth = video && ('videoWidth' in video ? video.videoWidth : video.width);
  const videoHeight = video && ('videoHeight' in video ? video.videoHeight : video.height);
  if (video && videoWidth && videoHeight) {
    const aspect = sourceAspect ?? videoWidth / videoHeight;
    dh = Math.min(h, w / aspect);
    dw = dh * aspect;
    ox = (w - dw) / 2;
    oy = (h - dh) / 2;
    ctx.drawImage(video, ox, oy, dw, dh);
  } else {
    ctx.strokeStyle = 'rgba(105,160,166,.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 44) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const glow = ctx.createRadialGradient(w / 2, h * 0.47, 10, w / 2, h * 0.47, h * 0.6);
    glow.addColorStop(0, 'rgba(45,132,118,.2)');
    glow.addColorStop(1, 'rgba(45,132,118,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(99,156,158,.14)';
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo(w / 2 + i * 36, h * 0.76);
      ctx.lineTo(w / 2 + i * 155, h);
      ctx.stroke();
    }
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(0, h * 0.79 + i * i * 9);
      ctx.lineTo(w, h * 0.79 + i * i * 9);
      ctx.stroke();
    }
  }
  const xy = (p: { x: number; y: number }) => ({ x: ox + p.x * dw, y: oy + p.y * dh });
  if (points.length !== 33) return;
  if (!video) {
    // Stylized mannequin is explicitly synthetic; never presented as a real video.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const body = ctx.createLinearGradient(w * 0.4, 0, w * 0.6, h);
    body.addColorStop(0, '#3a5156');
    body.addColorStop(0.5, '#293f45');
    body.addColorStop(1, '#243940');
    ctx.strokeStyle = body;
    for (const [a, b] of [
      [11, 13],
      [13, 15],
      [12, 14],
      [14, 16],
      [23, 25],
      [25, 27],
      [24, 26],
      [26, 28],
      [27, 31],
      [28, 32],
    ]) {
      const pa = xy(points[a]),
        pb = xy(points[b]);
      ctx.lineWidth = a < 23 ? 35 : 48;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    [11, 12, 24, 23].forEach((i, n) => {
      const p = xy(points[i]);
      if (n) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fill();
    const head = xy(points[0]);
    ctx.beginPath();
    ctx.ellipse(head.x, head.y + 9, 29, 39, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a5156';
    ctx.lineWidth = 24;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y + 40);
    ctx.lineTo((xy(points[11]).x + xy(points[12]).x) / 2, xy(points[11]).y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(139,191,182,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.88, 190, 24, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (settings.trajectory && trail.length > 1) {
    ctx.strokeStyle = '#f6c36b';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    let connected = false;
    trail.forEach((p) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        connected = false;
        return;
      }
      const c = xy(p);
      if (connected) ctx.lineTo(c.x, c.y);
      else ctx.moveTo(c.x, c.y);
      connected = true;
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (settings.skeleton) {
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5;
    for (const [a, b] of CONNECTIONS) {
      const low = Math.min(points[a].visibility, points[b].visibility) < settings.threshold;
      ctx.strokeStyle = low ? 'rgba(250,111,105,.3)' : '#62dbac';
      ctx.shadowColor = '#5ce8bd';
      ctx.shadowBlur = low ? 0 : 7;
      const pa = xy(points[a]),
        pb = xy(points[b]);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    points.forEach((p, i) => {
      const c = xy(p),
        low = p.visibility < settings.threshold;
      ctx.fillStyle = low ? 'rgba(248,113,113,.55)' : '#a0ffda';
      ctx.beginPath();
      ctx.arc(c.x, c.y, i < 11 ? 2.5 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (i >= 11 && !low) {
        ctx.strokeStyle = 'rgba(102,232,180,.2)';
        ctx.beginPath();
        ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  }
  const center = centerOfMass(points, settings.threshold);
  if (center) {
    const c = xy(center);
    ctx.strokeStyle = '#e9c280';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
    ctx.moveTo(c.x - 17, c.y);
    ctx.lineTo(c.x + 17, c.y);
    ctx.moveTo(c.x, c.y - 17);
    ctx.lineTo(c.x, c.y + 17);
    ctx.stroke();
  }
  if (settings.labels) {
    const angles = jointAngles(points, settings.threshold, dw / dh);
    ctx.font = '500 14px sans-serif';
    const occupied: LabelBox[] = [];
    for (const { joint, index, channel } of LABEL_ANCHORS) {
      if (settings.labelJoints && !settings.labelJoints.includes(joint)) continue;
      const value = angleValue(angles, joint, channel);
      if (value === null) continue;
      const p =
        joint === 'spine'
          ? xy({ x: (points[23].x + points[24].x) / 2, y: (points[23].y + points[24].y) / 2 })
          : xy(points[index]);
      const text = `${channel === 'midline' ? '' : channel === 'left' ? '左' : '右'}${JOINTS.find((j) => j.key === joint)!.label.replace('关节', '')}${channel === 'midline' ? '中线' : ''} ${value.toFixed(1)}°`;
      const box = placeLabel(
        p,
        ctx.measureText(text).width + 18,
        27,
        occupied,
        { width: w, height: h },
        channel === 'left',
      );
      occupied.push(box);
      ctx.strokeStyle = 'rgba(113,189,163,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(
        Math.max(box.x, Math.min(box.x + box.width, p.x)),
        Math.max(box.y, Math.min(box.y + box.height, p.y)),
      );
      ctx.stroke();
      ctx.fillStyle = 'rgba(12,28,33,.85)';
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.width, box.height, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(113,189,163,.3)';
      ctx.stroke();
      ctx.fillStyle = '#c0f7dc';
      ctx.fillText(text, box.x + 9, box.y + 18);
    }
  }
}
