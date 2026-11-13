export function median(values: readonly number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = ordered.length >>> 1;
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

// Use only earlier source-time deltas, so live results and replay agree and a
// gap cannot raise its own limit. Allow a sustained cadence change to settle.
export class SampleContinuity {
  private recent: number[] = [];

  observe(seconds: number, live: boolean): number | null {
    const typical = median(this.recent);
    const limit = Math.min(
      typical === null ? Infinity : Math.max(0.1, typical * 3),
      live ? 0.5 : Infinity,
    );
    this.recent.push(seconds);
    if (this.recent.length > 9) this.recent.shift();
    return seconds > limit ? limit : null;
  }
}
