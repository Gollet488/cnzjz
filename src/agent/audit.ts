import type { AgentRun } from './runtime.ts';
import type { ModelMessage, ModelReply, ProviderFailure } from './provider.ts';
import type { ToolDefinition } from '../analysis/tools.ts';

export interface RunAudit {
  version: '1.0.0';
  conversationId: string;
  run: AgentRun;
  tools: ToolDefinition[];
  requests: {
    messages: ModelMessage[];
    tools?: ToolDefinition[];
    reply?: ModelReply;
    error?: string;
    providerFailure?: ProviderFailure;
  }[];
}

// This database is audit-only: it is never read to restore model context,
// evidence IDs, artifact handles or connection configuration.
function openAudit(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kinetic-agent-audit', 1);
    let settled = false;
    const fail = (error: unknown) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('AUDIT_OPEN_TIMEOUT')), 5000);
    request.onupgradeneeded = () => request.result.createObjectStore('runs', { keyPath: 'run.id' });
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail(new Error('AUDIT_DATABASE_BLOCKED'));
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
  });
}
export async function saveRunAudit(audit: RunAudit): Promise<void> {
  const database = await openAudit();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('runs', 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('AUDIT_WRITE_ABORTED'));
      transaction.objectStore('runs').add(audit);
    });
  } finally {
    database.close();
  }
}

export async function readRunAudit(id: string): Promise<RunAudit> {
  const database = await openAudit();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('runs', 'readonly').objectStore('runs').get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () =>
        request.result ? resolve(request.result) : reject(new Error('UNKNOWN_RUN_AUDIT'));
    });
  } finally {
    database.close();
  }
}
