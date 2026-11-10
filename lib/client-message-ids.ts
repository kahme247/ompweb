import type { QueuedMessages } from "./pi-types";

/** Opaque native intent identity; never inferred from displayed text or a timestamp. */
export function isClientMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/** One selective native status request is bounded and cannot alias IDs within its own batch. */
export function readClientMessageIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 || !value.every(isClientMessageId)) return null;
  return new Set(value).size === value.length ? value : null;
}

/** Parse a native queue while retaining the identity of each validated display slot. */
export function readQueueSnapshot(value: unknown): QueuedMessages | null {
  if (!value || typeof value !== "object" || !("steering" in value) || !("followUp" in value)) return null;
  const queues = [value.steering, value.followUp];
  const [steering, followUp] = queues.map((list) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  const snapshot: QueuedMessages = { steering, followUp };
  if ("clientMessageIds" in value && value.clientMessageIds && typeof value.clientMessageIds === "object") {
    const ids = value.clientMessageIds as Record<string, unknown>;
    const aligned = (key: "steering" | "followUp", list: unknown): (string | null)[] =>
      Array.isArray(list) ? list.flatMap((text, index) => {
        if (typeof text !== "string") return [];
        const source = ids[key];
        const id = Array.isArray(source) && source.length === list.length ? source[index] : null;
        return [isClientMessageId(id) ? id : null];
      }) : [];
    snapshot.clientMessageIds = { steering: aligned("steering", queues[0]), followUp: aligned("followUp", queues[1]) };
  }
  return snapshot;
}
