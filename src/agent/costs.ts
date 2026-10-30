export interface RequestMeasurement {
  index: number;
  messageBytes: number;
  toolBytes: number;
  offeredTools?: string[];
  toolFingerprint?: string;
  inputBytes: number;
  wireBytes: number | null;
  messageCount: number;
  elapsedMs: number;
  status: 'pending' | 'returned' | 'failed';
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface ConversationCosts {
  turns: number;
  requests: number;
  rounds: number;
  elapsedMs: number;
  maxRequestBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedUsage: {
    inputTokens: number;
    outputTokens: number;
    inputRequests: number;
    outputRequests: number;
  };
}
export function emptyCosts(): ConversationCosts {
  return {
    turns: 0,
    requests: 0,
    rounds: 0,
    elapsedMs: 0,
    maxRequestBytes: 0,
    inputTokens: null,
    outputTokens: null,
    reportedUsage: { inputTokens: 0, outputTokens: 0, inputRequests: 0, outputRequests: 0 },
  };
}
export function addCosts(
  total: ConversationCosts,
  requests: RequestMeasurement[],
  rounds: number,
  elapsedMs: number,
) {
  total.turns++;
  total.rounds += rounds;
  total.elapsedMs += elapsedMs;
  total.requests += requests.length;
  for (const r of requests) {
    total.maxRequestBytes = Math.max(total.maxRequestBytes, r.inputBytes);
    if (r.inputTokens !== null) {
      total.reportedUsage.inputTokens += r.inputTokens;
      total.reportedUsage.inputRequests++;
    }
    if (r.outputTokens !== null) {
      total.reportedUsage.outputTokens += r.outputTokens;
      total.reportedUsage.outputRequests++;
    }
  }
  total.inputTokens =
    total.requests && total.reportedUsage.inputRequests === total.requests
      ? total.reportedUsage.inputTokens
      : null;
  total.outputTokens =
    total.requests && total.reportedUsage.outputRequests === total.requests
      ? total.reportedUsage.outputTokens
      : null;
}
export function requestUsage(requests: RequestMeasurement[]) {
  const cost = emptyCosts();
  addCosts(cost, requests, 0, 0);
  return {
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    reportedRequests: requests.filter((r) => r.inputTokens !== null || r.outputTokens !== null)
      .length,
  };
}
