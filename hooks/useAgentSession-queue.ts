// Queued-prompt tracking, persistence, and same-document queue notifications.

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };

// omp reports only queuedMessageCount over RPC; the queued texts live in React
// state and would vanish on reload. Mirror them into sessionStorage (per
// session, best-effort, size-bounded) so a reload can restore the queue panel.
export const QUEUE_STORAGE_PREFIX = "omp-queue-";
export const QUEUE_STORAGE_MAX_CHARS = 50_000;

export function isEmptyQueue(queue: QueuedMessages): boolean {
  return queue.steering.length === 0 && queue.followUp.length === 0;
}

export function readPersistedQueue(sessionId: string): QueuedMessages | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueuedMessages> | null;
    const onlyStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const queue = { steering: onlyStrings(parsed?.steering), followUp: onlyStrings(parsed?.followUp) };
    return isEmptyQueue(queue) ? null : queue;
  } catch {
    return null;
  }
}

export function persistQueue(sessionId: string, queue: QueuedMessages): void {
  try {
    const key = QUEUE_STORAGE_PREFIX + sessionId;
    if (isEmptyQueue(queue)) {
      sessionStorage.removeItem(key);
      return;
    }
    // Size bound: drop oldest texts until the payload fits.
    let bounded = queue;
    let raw = JSON.stringify(bounded);
    while (raw.length > QUEUE_STORAGE_MAX_CHARS && bounded.steering.length + bounded.followUp.length > 1) {
      bounded = bounded.steering.length >= bounded.followUp.length
        ? { ...bounded, steering: bounded.steering.slice(1) }
        : { ...bounded, followUp: bounded.followUp.slice(1) };
      raw = JSON.stringify(bounded);
    }
    if (raw.length > QUEUE_STORAGE_MAX_CHARS) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, raw);
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

export function clearPersistedQueue(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    sessionStorage.removeItem(QUEUE_STORAGE_PREFIX + sessionId);
  } catch {
    // ignore storage errors
  }
}

type QueueListener = (sessionId: string, queue: QueuedMessages) => void;
const queueListeners = new Set<QueueListener>();

/** Publish the already-applied snapshot, not a removal to repeat per listener. */
export function publishQueueChange(sessionId: string, queue: QueuedMessages): void {
  persistQueue(sessionId, queue);
  for (const listener of [...queueListeners]) {
    try {
      listener(sessionId, queue);
    } catch {
      // A failing subscriber must not stop the others.
    }
  }
}

export function subscribeQueueChanges(listener: QueueListener): () => void {
  queueListeners.add(listener);
  return () => { queueListeners.delete(listener); };
}
