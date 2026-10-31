import { nextTick, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { Ref } from 'vue';
import type { AnalysisSession } from '../analysis/session.ts';
import type { createToolRegistry } from '../analysis/tools.ts';
import type { PoseFrame, Marker } from '../types.ts';
import { intervalFrames } from '../analysis/frameIndex.ts';
import { exportCSV, supportsCSVFileStream } from '../utils/csvExport.ts';
import type { CSVProgress } from '../utils/csvExport.ts';
import { ElMessage } from '../ui.ts';
import { SessionPublication } from '../utils/publication.ts';

// The export owns its cancellation, progress and frozen reference; acquisition
// must pause before taking that reference, and every chunk checks its revision.
export function useCSVExport({
  session,
  tools,
  playing,
  visibleFrames,
  markers,
  flush,
}: {
  session: AnalysisSession;
  tools: ReturnType<typeof createToolRegistry>;
  playing: Ref<boolean>;
  visibleFrames: () => PoseFrame[];
  markers: Ref<Marker[]>;
  flush: () => void;
}) {
  const csvProgress = shallowRef<CSVProgress>();
  const csvState = ref<'idle' | 'writing' | 'completed' | 'cancelled' | 'failed'>('idle');
  const csvMessage = ref('');
  const csvFileStream = supportsCSVFileStream();
  let latestProgress: CSVProgress | undefined;
  // The encoder still reports every chunk. Publish UI progress at 10 Hz so a
  // file stream does not patch the whole page 750 times during one export.
  const progressPublication = new SessionPublication(() => {
    csvProgress.value = latestProgress;
  });
  let csvController: AbortController | undefined;
  onBeforeUnmount(() => {
    csvController?.abort();
    progressPublication.cancel();
  });
  async function exportData(handle?: string | Event) {
    if (csvState.value === 'writing') return;
    let prepared;
    try {
      if (typeof handle === 'string') prepared = tools.getArtifact(handle);
      if (prepared && prepared.kind !== 'csv') throw new Error('INVALID_EXPORT_HANDLE');
    } catch (error) {
      ElMessage.error(String(error));
      return;
    }
    csvState.value = 'writing';
    playing.value = false;
    // Let PoseStage apply pause/acquisition metadata before fixing the revision.
    await nextTick();
    flush();
    if (!visibleFrames().length) {
      ElMessage.info('暂无可导出的数据。');
      csvState.value = 'idle';
      return;
    }
    const controller = new AbortController();
    csvController = controller;
    const reference = prepared?.reference ?? session.info();
    // Reference snapshot only; the frame objects are never cloned or edited by export.
    const snapshot = prepared
      ? intervalFrames(session.frames, prepared.interval)
      : visibleFrames().slice();
    const markerSnapshot = markers.value.map((m) => ({ ...m }));
    csvState.value = 'writing';
    csvMessage.value = csvFileStream ? '选择保存位置后开始写入…' : '正在准备分块下载…';
    csvProgress.value = { rows: 0, total: snapshot.length, bytes: 0, state: 'writing' };
    let destination = csvFileStream ? 'file' : 'blob';
    try {
      const result = await exportCSV(snapshot, markerSnapshot, reference, {
        signal: controller.signal,
        assertCurrent: () => session.assertCurrent(reference),
        onDestination: (mode) => {
          destination = mode;
        },
        onProgress: (p) => {
          latestProgress = p;
          if (!p.rows || p.state === 'completed') progressPublication.flush();
          else progressPublication.schedule();
          csvMessage.value =
            destination === 'file'
              ? '正在写入 CSV 文件…'
              : '正在分块生成 Blob，完整文件将驻留内存…';
        },
      });
      csvState.value = 'completed';
      csvMessage.value =
        result.mode === 'file'
          ? `已保存 ${result.rows.toLocaleString()} 帧 CSV`
          : `已准备 ${result.rows.toLocaleString()} 帧 CSV，已发起浏览器下载`;
      ElMessage.success(csvMessage.value);
    } catch (error) {
      const cancelled =
        controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      csvState.value = cancelled ? 'cancelled' : 'failed';
      csvMessage.value = cancelled
        ? 'CSV 导出已取消，未生成完整文件。'
        : `CSV 导出失败：${error instanceof Error ? error.message : String(error)}`;
      if (!cancelled) ElMessage.error(csvMessage.value);
    } finally {
      progressPublication.flush();
      if (csvController === controller) csvController = undefined;
    }
  }
  function cancelCSV() {
    csvController?.abort();
  }

  return { csvProgress, csvState, csvMessage, csvFileStream, exportData, cancelCSV };
}
