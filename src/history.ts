import { parseRegistry, type JobCompletion, type LogTail } from "./jobs.ts";

export interface HistoryCompletion extends JobCompletion { tail?: LogTail }

export function completionKey(completion: JobCompletion): string {
  return `${completion.id}:${completion.record.pid}:${completion.record.start_time}`;
}

/** Read only this branch's durable completion messages; ignore unrelated/corrupt entries. */
export function restoreCompletions(entries: readonly unknown[]): HistoryCompletion[] {
  const history = new Map<string, HistoryCompletion>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    type StoredMessage = { role?: string; customType?: string; details?: { jobs?: unknown } };
    const stored = entry as StoredMessage & { type?: string; message?: StoredMessage };
    const message = stored.type === "custom_message" ? stored : stored.type === "message" && stored.message?.role === "custom" ? stored.message : undefined;
    if (message?.customType !== "async-jobs-completion") continue;
    const jobs = message.details?.jobs;
    if (!Array.isArray(jobs)) continue;
    for (const value of jobs) {
      try {
        const completion = value?.completion as JobCompletion | undefined;
        if (!completion || typeof completion.id !== "string" || typeof completion.timedOut !== "boolean" ||
          !Number.isSafeInteger(completion.runtimeSeconds) || completion.runtimeSeconds < 0 ||
          (completion.exitCode !== null && !Number.isInteger(completion.exitCode)) ||
          (completion.signal !== null && (typeof completion.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(completion.signal)))) continue;
        const record = parseRegistry({ [completion.id]: completion.record })[completion.id];
        const restored = { id: completion.id, record, exitCode: completion.exitCode, signal: completion.signal, timedOut: completion.timedOut, runtimeSeconds: completion.runtimeSeconds };
        const tail = value?.tail;
        const archived = tail && typeof tail.text === "string" && typeof tail.truncated === "boolean"
          ? { text: tail.text, truncated: tail.truncated, ...(typeof tail.error === "string" ? { error: tail.error } : {}) } : undefined;
        history.set(completionKey(restored), { ...restored, ...(archived ? { tail: archived } : {}) });
      } catch { /* Old or malformed metadata must not affect job control. */ }
    }
  }
  return [...history.values()];
}
