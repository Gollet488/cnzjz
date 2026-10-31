import type { Landmark } from '../types';
// Synthetic 33-point sequence. It represents no sport and is never model output.
export function demoPose(t: number): Landmark[] {
  const sway = Math.sin(t * 0.9) * 0.015,
    bob = Math.sin(t * 1.8) * 0.018;
  const p = Array.from({ length: 33 }, () => ({
    x: 0.5 + sway,
    y: 0.18 + bob,
    z: 0,
    visibility: 0.98,
  }));
  const set = (i: number, x: number, y: number) => {
    p[i] = { x: x + sway, y: y + bob, z: 0, visibility: 0.96 + Math.sin(t + i) * 0.025 };
  };
  set(0, 0.5, 0.158);
  for (let i = 1; i <= 10; i++)
    set(i, 0.5 + (i <= 3 ? -1 : 1) * (0.009 + (i % 3) * 0.009), 0.148 + (i > 6 ? 0.025 : 0));
  set(7, 0.455, 0.168);
  set(8, 0.545, 0.168);
  set(9, 0.489, 0.19);
  set(10, 0.511, 0.19);
  set(11, 0.422, 0.285);
  set(12, 0.578, 0.285);
  const wave = Math.sin(t * 1.6),
    wave2 = Math.sin(t * 1.6 + 0.25);
  set(13, 0.34 - 0.05 * wave, 0.425 - 0.04 * wave);
  set(14, 0.665 + 0.05 * wave2, 0.415 - 0.06 * wave2);
  set(15, 0.27 - 0.07 * wave, 0.325 - 0.11 * wave);
  set(16, 0.74 + 0.06 * wave2, 0.305 - 0.1 * wave2);
  for (const [i, w] of [
    [17, 15],
    [19, 15],
    [21, 15],
    [18, 16],
    [20, 16],
    [22, 16],
  ]) {
    const sign = i % 2 ? -1 : 1;
    set(
      i,
      p[w].x - sway + sign * (0.012 + (i % 3) * 0.007),
      p[w].y - bob - 0.025 - (i % 3) * 0.005,
    );
  }
  set(23, 0.455, 0.54);
  set(24, 0.545, 0.54);
  set(25, 0.4 + 0.02 * Math.sin(t * 1.8), 0.715);
  set(26, 0.61 + 0.025 * Math.sin(t * 1.8 + 0.4), 0.71);
  set(27, 0.36, 0.88);
  set(28, 0.65, 0.875);
  set(29, 0.348, 0.902);
  set(30, 0.655, 0.902);
  set(31, 0.305, 0.915);
  set(32, 0.705, 0.91);
  return p;
}
