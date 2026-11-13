import type { SessionInfo } from './session.ts';

export function sourceLabel(info: Pick<SessionInfo, 'source' | 'fileName'>) {
  if (info.source === 'demo') return '合成姿态演示';
  if (info.source === 'camera') return '实时摄像头';
  if (!info.fileName) return '本地视频';
  return `本地视频 · ${info.fileName}`;
}

export function sourceClock(info: Pick<SessionInfo, 'source' | 'acquisition'>) {
  if (info.source === 'camera') return '从本次摄像头首帧起计';
  if (info.source === 'demo') return '演示序列时间';
  return info.acquisition?.mode.includes('transcoded') ? '转换后视频时间' : '视频时间';
}

export function sourceTimeSpan(span: readonly number[] | null) {
  if (!span) return '暂无采样';
  const first = Number(span[0].toFixed(6));
  if (span[0] === span[1]) return `${first} s`;
  return `${first}–${Number(span[1].toFixed(6))} s`;
}
