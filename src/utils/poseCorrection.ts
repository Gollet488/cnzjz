type RangeStatus = 'below' | 'within' | 'above';

interface TargetReading {
  status: RangeStatus;
  distance: number;
}

export function compareTarget(angle: number, lower: number, upper: number): TargetReading {
  if (angle < lower) return { status: 'below', distance: lower - angle };
  if (angle > upper) return { status: 'above', distance: angle - upper };
  return { status: 'within', distance: Math.min(angle - lower, upper - angle) };
}

export interface LiveCorrection {
  confirmed: TargetReading | null;
  candidate?: { status: RangeStatus; since: number };
}

const DWELL_SECONDS = 0.3;

export function confirmCorrection(
  previous: LiveCorrection | undefined,
  measured: TargetReading | null,
  time: number,
): LiveCorrection {
  const confirmed = previous?.confirmed ?? null;
  if (!measured || measured.status === (confirmed?.status ?? 'within'))
    return { confirmed: measured };

  // Measure a continuous run in the same direction on the source sample clock.
  const { status } = measured;
  const since = previous?.candidate?.status === status ? previous.candidate.since : time;
  if (time + 1e-9 >= since + DWELL_SECONDS) return { confirmed: measured };
  return { confirmed, candidate: { status, since } };
}
