// Monotonic durations; wall timestamps are for evidence correlation only.
// The receipt is emitted AFTER the primary audit commits. Its own recording is
// observer overhead, outside the measured user-goal transaction.
export interface RunTiming {
  version: '1.0.0';
  submittedAt: number;
  completedAt: number | null;
  wallMs: number | null;
  computeMs: number | null;
  manualWaitMs: number;
  requestMs: number;
  toolMs: number;
  applicationMs: number | null;
  auditMs: number | null;
  application: 'ready' | 'failed' | 'unmeasured';
  audit: 'saved' | 'failed' | 'unmeasured';
}

export function beginTiming(submittedAt = Date.now()): RunTiming {
  return {
    version: '1.0.0',
    submittedAt,
    completedAt: null,
    wallMs: null,
    computeMs: null,
    manualWaitMs: 0,
    requestMs: 0,
    toolMs: 0,
    applicationMs: null,
    auditMs: null,
    application: 'unmeasured',
    audit: 'unmeasured',
  };
}
