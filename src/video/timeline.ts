export interface EncodedSample {
  offset: number;
  size: number;
  dts: number;
  cts: number;
  duration: number;
  is_sync: boolean;
}
export interface SourceSample extends EncodedSample {
  timestamp: number;
  durationUs: number;
  included: boolean;
}
export interface Edit {
  segment_duration: number;
  media_time: number;
  media_rate_integer: number;
  media_rate_fraction: number;
}

// MP4 samples stay in decode (DTS) order. Only the expected output index is
// sorted by PTS. Never estimate a frame time from frame rate or wall clock.
export function sourceTimeline(
  samples: EncodedSample[],
  timescale: number,
  movieTimescale: number,
  edits: Edit[] = [],
) {
  if (!(timescale > 0) || !(movieTimescale > 0) || !samples.length)
    throw new Error('MP4 时间表为空或时间基准无效。');
  let start = 0;
  let lead = 0;
  let end = Infinity;
  if (edits.length) {
    const media = edits.filter((e) => e.media_time !== -1);
    if (
      media.length !== 1 ||
      edits.length > 2 ||
      edits.at(-1) !== media[0] ||
      edits.some((e) => e.media_rate_integer !== 1 || e.media_rate_fraction !== 0)
    )
      throw new Error('暂不支持多段、倒放或变速 MP4 edit list，请转为普通 H.264 MP4。');
    start = media[0].media_time / timescale;
    lead = edits[0].media_time === -1 ? edits[0].segment_duration / movieTimescale : 0;
    end = start + media[0].segment_duration / movieTimescale;
  }
  const decode = samples.map((s, i): SourceSample => {
    if (
      ![s.cts, s.dts, s.duration, s.offset, s.size].every(Number.isSafeInteger) ||
      s.duration <= 0 ||
      s.offset < 0 ||
      s.size <= 0 ||
      (i > 0 && s.dts <= samples[i - 1].dts)
    )
      throw new Error('MP4 样本时间、大小或解码顺序无效。');
    const seconds = s.cts / timescale;
    const timestamp = Math.round((seconds - start + lead) * 1e6);
    if (!Number.isSafeInteger(timestamp)) throw new Error('MP4 时间超出精确范围。');
    return {
      ...s,
      timestamp,
      durationUs: Math.round((s.duration / timescale) * 1e6),
      included: seconds >= start && seconds < end,
    };
  });
  if (!decode[0].is_sync) throw new Error('视频缺少起始关键帧。');
  const presentation = decode.filter((s) => s.included).sort((a, b) => a.timestamp - b.timestamp);
  if (
    !presentation.length ||
    presentation[0].timestamp < 0 ||
    presentation.some((s, i) => i > 0 && s.timestamp <= presentation[i - 1].timestamp)
  )
    throw new Error('视频包含空、重复或倒退的呈现时间，不能无损写入会话。');
  return { decode, presentation, mediaTimeOffset: lead - start };
}

// ISO tkhd matrix uses unsigned fixed-point words. Translation is irrelevant
// to an isolated video track; reject shear, scale, mirror and perspective.
export function trackRotation(matrix: ArrayLike<number>): 0 | 90 | 180 | 270 {
  const signed = (v: number) => (v | 0) / 65536;
  const actual = [matrix[0], matrix[1], matrix[3], matrix[4]].map(signed);
  const rotations = [
    [1, 0, 0, 1],
    [0, 1, -1, 0],
    [-1, 0, 0, -1],
    [0, -1, 1, 0],
  ];
  const index = rotations.findIndex((m) => m.every((v, i) => Math.abs(v - actual[i]) < 1e-4));
  if (index < 0 || matrix[2] !== 0 || matrix[5] !== 0 || matrix[8] !== 1073741824)
    throw new Error('暂不支持带缩放、镜像或透视变换的视频轨道。');
  return (index * 90) as 0 | 90 | 180 | 270;
}

export class PresentationAudit {
  count = 0;
  readonly expected: number[];
  constructor(expected: number[]) {
    this.expected = expected;
  }
  accept(timestamp: number) {
    if (timestamp !== this.expected[this.count])
      throw new Error(
        `解码 PTS 不匹配：第 ${this.count + 1} 帧，预期 ${this.expected[this.count]}，实际 ${timestamp}。`,
      );
    this.count++;
  }
  finish() {
    if (this.count !== this.expected.length)
      throw new Error(`解码帧数不完整：${this.count}/${this.expected.length}，未标记完成。`);
  }
}
