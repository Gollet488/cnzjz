import type { Marker, PoseFrame } from '../types.ts';
import type { SessionInfo } from '../analysis/session.ts';
import { csvChunks } from './csv.ts';
import { download } from './download.ts';

export interface CSVProgress {
  rows: number;
  total: number;
  bytes: number;
  state: 'writing' | 'completed';
}
export interface CSVSink {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface CSVOptions {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onProgress?: (progress: CSVProgress) => void;
  onDestination?: (mode: 'file' | 'blob') => void;
}
const yieldUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const CSV_SLICE_MS = 6;
function check(options: CSVOptions) {
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
}
// One encoded chunk in flight. Await the destination before producing another;
// Cooperate on a short wall-time budget, including immediately resolved sinks.
// A microtask-only yield cannot deliver user cancellation events. Keep each
// encoded chunk at <=24 frames; this budget never increases the write batch.
export async function writeCSV(
  frames: readonly PoseFrame[],
  markers: readonly Marker[],
  session: SessionInfo,
  sink: CSVSink,
  options: CSVOptions = {},
) {
  let bytes = 0;
  try {
    check(options);
    options.onProgress?.({ rows: 0, total: frames.length, bytes, state: 'writing' });
    let sliceStart = performance.now();
    for (const chunk of csvChunks(frames, markers, session)) {
      check(options);
      await sink.write(chunk.data);
      bytes += chunk.data.byteLength;
      check(options);
      options.onProgress?.({ rows: chunk.rows, total: frames.length, bytes, state: 'writing' });
      if (performance.now() - sliceStart >= CSV_SLICE_MS) {
        await yieldUI();
        sliceStart = performance.now();
      }
      check(options);
    }
    await sink.close();
    check(options);
    options.onProgress?.({ rows: frames.length, total: frames.length, bytes, state: 'completed' });
    return { rows: frames.length, bytes };
  } catch (error) {
    // Preserve the originating error even if aborting an already failed sink fails.
    await sink.abort(error).catch(() => {});
    throw error;
  }
}

export function blobCSVSink() {
  let parts: BlobPart[] = [];
  let blob: Blob | undefined;
  const sink: CSVSink = {
    async write(chunk) {
      parts.push(chunk);
    },
    async close() {
      blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
      parts = [];
    },
    async abort() {
      parts = [];
      blob = undefined;
    },
  };
  return { sink, getBlob: () => blob };
}
interface SavePicker {
  (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<{ createWritable(): Promise<CSVSink> }>;
}
export function supportsCSVFileStream() {
  return (
    typeof (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === 'function'
  );
}
export async function exportCSV(
  frames: readonly PoseFrame[],
  markers: readonly Marker[],
  session: SessionInfo,
  options: CSVOptions = {},
) {
  const name = `kinetic-${Date.now()}.csv`;
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    // Called directly from the click handler to retain transient user activation.
    let handle;
    try {
      handle = await picker.call(globalThis, {
        suggestedName: name,
        types: [{ description: 'CSV 数据', accept: { 'text/csv': ['.csv'] } }],
      });
    } catch (error) {
      // Embedded/insecure contexts may expose the method but prohibit using it.
      // User cancellation and denied access are not silently converted to downloads.
      if (
        !(
          error instanceof DOMException &&
          ['SecurityError', 'NotSupportedError'].includes(error.name)
        )
      )
        throw error;
    }
    if (handle) {
      check(options);
      const sink = await handle.createWritable();
      options.onDestination?.('file');
      return {
        ...(await writeCSV(frames, markers, session, sink, options)),
        mode: 'file' as const,
      };
    }
  }
  check(options);
  options.onDestination?.('blob');
  const blob = blobCSVSink();
  const result = await writeCSV(frames, markers, session, blob.sink, options);
  check(options);
  download(blob.getBlob()!, name);
  return { ...result, mode: 'blob' as const };
}
