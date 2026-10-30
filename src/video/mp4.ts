import { createFile, MultiBufferStream } from 'mp4box';
import type { Movie, VisualSampleEntry } from 'mp4box';
import { sourceTimeline, trackRotation } from './timeline.ts';
import type { Edit } from './timeline.ts';

export async function readMP4(file: Blob, checkpoint: () => Promise<void> = async () => {}) {
  // Metadata only: MP4Box skips mdat, then samples are read with Blob.slice.
  // Neither FileReader nor a second whole-file Blob is needed.
  const parser = createFile(false);
  let info: Movie | undefined;
  parser.onReady = (value) => {
    info = value;
  };
  parser.onError = (_module, message) => {
    throw new Error(`MP4 解封装失败：${message}`);
  };
  let offset = 0;
  let bytesRead = 0;
  while (!info && offset < file.size) {
    await checkpoint();
    const buffer = await file.slice(offset, offset + 1024 * 1024).arrayBuffer();
    await checkpoint();
    bytesRead += buffer.byteLength;
    if (bytesRead > 32 * 1024 * 1024) throw new Error('MP4 元数据超过 32 MB 限制。');
    const input = Object.assign(buffer, { fileStart: offset });
    const next = parser.appendBuffer(input);
    offset = next > offset ? next : offset + buffer.byteLength;
  }
  if (!info) throw new Error('未找到完整 MP4 moov 索引，文件可能损坏或格式不受支持。');
  // TypeScript cannot follow assignment from parser callbacks.
  const movie = info as Movie;
  if (movie.isFragmented) throw new Error('暂不支持 fragmented MP4，请转为普通 H.264 MP4。');
  if (movie.videoTracks.length !== 1) throw new Error('需要且仅支持一个视频轨道。');
  const track = movie.videoTracks[0];
  if (!/^avc1\./.test(track.codec))
    throw new Error(
      `不支持编码 ${track.codec}；目前仅支持 H.264 avc1 MP4，WebM/MOV/HEVC 不降级采样。`,
    );
  const samples = parser.getTrackSamplesInfo(track.id);
  if (!samples.length || samples.length > 500000)
    throw new Error('视频为空或样本索引超过 500,000 条限制。');
  const entry = samples[0].description as VisualSampleEntry;
  if (!entry.avcC || samples.some((s) => s.description !== entry))
    throw new Error('缺少 AVC 配置或视频在中途切换编码参数。');
  if (entry.boxes?.some((b) => ['sinf', 'clap'].includes(b.type)))
    throw new Error('暂不支持加密或 clean aperture 视频，请转为普通 H.264 MP4。');
  if (samples.some((s) => s.offset + s.size > file.size || s.size > 16 * 1024 * 1024))
    throw new Error('视频样本越界或单帧压缩数据超过 16 MB。');
  const stream = new MultiBufferStream();
  entry.avcC.write(stream);
  const description = new Uint8Array(stream.buffer, 8);
  const timeline = sourceTimeline(samples, track.timescale, movie.timescale, track.edits as Edit[]);
  const rotation = trackRotation(track.matrix);
  const pasp = entry.boxes?.find((b) => b.type === 'pasp') as
    | { hSpacing: number; vSpacing: number }
    | undefined;
  const width = entry.width,
    height = entry.height;
  // pasp defines pixel aspect. In its absence, honor tkhd's display aspect;
  // an integer raster introduces at most one display-pixel rounding error.
  const pixelAspect = pasp
    ? pasp.hSpacing / pasp.vSpacing
    : track.track_width > 0 && track.track_height > 0
      ? track.track_width / track.track_height / (width / height)
      : 1;
  if (
    !Number.isFinite(pixelAspect) ||
    pixelAspect <= 0 ||
    !width ||
    !height ||
    width * height > 3840 * 2160
  )
    throw new Error('视频尺寸或像素宽高比无效；最高支持 3840×2160 像素数。');
  const displayWidth = Math.round(width * pixelAspect);
  const displayHeight = height;
  if (displayWidth * displayHeight > 3840 * 2160) throw new Error('显示比例调整后的像素数过大。');
  return {
    ...timeline,
    rotation,
    displayWidth,
    displayHeight,
    bytesRead,
    config: {
      codec: track.codec,
      codedWidth: width,
      codedHeight: height,
      description,
      optimizeForLatency: false,
    } satisfies VideoDecoderConfig,
    aspect: rotation % 180 ? displayHeight / displayWidth : displayWidth / displayHeight,
  };
}
