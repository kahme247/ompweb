/** Queued sends still waiting for omp's answer, per draft key. Module state, so
 *  the "Sending…" row survives the composer remount a chat switch causes. */
export type PendingSend = { id: number; key: string | undefined; text: string; recoveryIdentity: { key: string | undefined } };

let pending: readonly PendingSend[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function set(next: readonly PendingSend[]) {
  pending = next;
  for (const listener of listeners) listener();
}

export function trackPendingSend(recoveryIdentity: PendingSend["recoveryIdentity"], text: string, reply: Promise<unknown>): void {
  const id = ++nextId;
  set([...pending, { id, key: recoveryIdentity.key, text, recoveryIdentity }]);
  void reply.finally(() => set(pending.filter((entry) => entry.id !== id))).catch(() => {});
}

/** A confirmed identity move keeps these sends in the same conversation. */
export function retargetPendingSends(from: string, to: string): void {
  if (from === to || !pending.some((entry) => entry.key === from)) return;
  set(pending.map((entry) => {
    if (entry.key !== from) return entry;
    // The refusal callback may belong to an earlier composer mount.
    entry.recoveryIdentity.key = to;
    return { ...entry, key: to };
  }));
}

export function subscribePendingSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingSends(): readonly PendingSend[] {
  return pending;
}
