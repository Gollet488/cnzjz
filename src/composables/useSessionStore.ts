import { onBeforeUnmount, shallowRef, triggerRef } from 'vue';
import { AnalysisSession } from '../analysis/session.ts';
import { FrameSummaryIndex } from '../analysis/frameIndex.ts';
import { SessionPublication } from '../utils/publication.ts';
import type { AnalysisParameters, PoseFrame, Source } from '../types.ts';

// Session owns source samples and revision. Vue receives batched publications;
// chart updates must never clone the complete session on each captured frame.
export function useSessionStore(source: Source, parameters: AnalysisParameters) {
  const session = new AnalysisSession(source, parameters);
  const frames = shallowRef<PoseFrame[]>([]);
  const sessionInfo = shallowRef(session.info());
  const summaryIndex = new FrameSummaryIndex();
  function publishSession() {
    summaryIndex.update(session.frames);
    if (frames.value !== session.frames) frames.value = session.frames;
    else triggerRef(frames);
    sessionInfo.value = session.info();
  }
  const publication = new SessionPublication(publishSession);
  onBeforeUnmount(() => publication.cancel());
  return { session, frames, sessionInfo, summaryIndex, publishSession, publication };
}
