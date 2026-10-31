import type { PoseFrame } from '../types.ts';
import { JOINTS } from '../config.ts';
import { angleValue, channels } from '../utils/poseMath.ts';

export function timeBound(frames: readonly PoseFrame[], time: number, after = false) {
  let lo = 0,
    hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].time < time || (after && frames[mid].time === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function intervalFrames(frames: PoseFrame[], interval: readonly [number, number]) {
  return frames.slice(timeBound(frames, interval[0]), timeBound(frames, interval[1], true));
}
const slots = JOINTS.flatMap((j) => channels(j.key).map((side) => ({ joint: j.key, side })));
type Extent = { min: number; max: number; count: number };
function extent(): Extent {
  return { min: Infinity, max: -Infinity, count: 0 };
}
function add(e: Extent, n: number | null) {
  if (n !== null) {
    e.min = Math.min(e.min, n);
    e.max = Math.max(e.max, n);
    e.count++;
  }
}
function empty() {
  return { angles: slots.map(extent), center: extent(), asymSum: 0, asymCount: 0, speed: extent() };
}
type Summary = ReturnType<typeof empty>;
function addFrame(s: Summary, f: PoseFrame, includeSpeed = true) {
  slots.forEach((slot, i) => {
    add(s.angles[i], angleValue(f.angles, slot.joint, slot.side));
    if (includeSpeed) {
      const n = angleValue(f.velocity, slot.joint, slot.side);
      add(s.speed, n === null ? null : Math.abs(n));
    }
  });
  add(s.center, f.center?.y ?? null);
  if (f.asymmetry !== null) {
    s.asymSum += f.asymmetry;
    s.asymCount++;
  }
}
function merge(to: Summary, from: Summary) {
  const pairs = [...to.angles, to.center, to.speed];
  [...from.angles, from.center, from.speed].forEach((v, i) => {
    pairs[i].min = Math.min(pairs[i].min, v.min);
    pairs[i].max = Math.max(pairs[i].max, v.max);
    pairs[i].count += v.count;
  });
  to.asymSum += from.asymSum;
  to.asymCount += from.asymCount;
}
const BLOCK = 128;
// Incremental block summaries: append touches just the new samples. Arbitrary
// clips merge complete blocks and inspect at most two boundary blocks.
export class FrameSummaryIndex {
  private frames: PoseFrame[] = [];
  private count = 0;
  private blocks: Summary[] = [];
  update(frames: PoseFrame[]) {
    if (frames !== this.frames || frames.length < this.count) {
      this.frames = frames;
      this.count = 0;
      this.blocks = [];
    }
    for (; this.count < frames.length; this.count++) {
      const b = Math.floor(this.count / BLOCK);
      this.blocks[b] ??= empty();
      addFrame(this.blocks[b], frames[this.count]);
    }
  }
  query(interval?: readonly [number, number] | null) {
    const start = interval ? Math.min(this.count, timeBound(this.frames, interval[0])) : 0;
    const end = interval
      ? Math.min(this.count, timeBound(this.frames, interval[1], true))
      : this.count;
    const result = empty();
    for (let i = start; i < end; ) {
      if (i > start && i % BLOCK === 0 && i + BLOCK <= end) {
        merge(result, this.blocks[i / BLOCK]);
        i += BLOCK;
      } else {
        addFrame(result, this.frames[i], i > start);
        i++;
      }
    }
    return {
      meanAsym: result.asymCount ? result.asymSum / result.asymCount : null,
      centerRange: result.center.count ? result.center.max - result.center.min : null,
      maxVelocity: result.speed.count ? result.speed.max : null,
      joints: JOINTS.map((j) => {
        const stat = (side: string) => {
          const i = slots.findIndex((s) => s.joint === j.key && s.side === side);
          const e = i < 0 ? extent() : result.angles[i];
          return {
            min: e.count ? e.min : null,
            max: e.count ? e.max : null,
            rom: e.count >= 2 ? e.max - e.min : null,
          };
        };
        return { ...j, left: stat(j.key === 'spine' ? 'midline' : 'left'), right: stat('right') };
      }),
    };
  }
}
