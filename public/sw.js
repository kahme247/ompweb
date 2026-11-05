// omp-web service worker: shows notifications and opens their session on click, and sends the message outbox a closed
// tab left (Background Sync). It does not cache anything; the app stays online-only.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data?.type === "omp-outbox-capability") event.ports[0]?.postMessage({ type: "omp-outbox-capability", version: 1 });
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Unreadable payload: still show something (iOS revokes silent pushes).
  }
  const shown = {
    type: data.type === "error" ? "error" : "info",
    title: data.title || "omp web",
    body: data.body || "",
    tag: data.tag || "",
    sessionId: data.sessionId || "",
  };
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(shown.title, {
        body: shown.body,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        tag: shown.tag || undefined,
        renotify: Boolean(shown.tag),
        data: { url: data.url || "/", sessionId: shown.sessionId },
      });
      // Open tabs list it in their Notifications tab, like a notification the page showed itself.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: "omp-notification-shown", notification: shown });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", sessionId = "" } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((candidate) => candidate.focused) || windows.find((candidate) => candidate.visibilityState === "visible") || windows[0];
      if (client) {
        try {
          await client.focus();
          // The app selects the session in place, keeping its live state. Any
          // other page (the sign-in screen after the cookie expired) loads the
          // session URL, which the sign-in screen carries through as `next`.
          if (new URL(client.url).pathname === "/") {
            if (sessionId) client.postMessage({ type: "omp-open-session", sessionId });
          } else {
            await client.navigate(url);
          }
          return;
        } catch {
          // focus() or navigate() can be refused; open a window instead.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// Background Sync (docs/specs/2026-11-04-message-outbox-design.md O2): the browser fires it once online, even with no
// tab open. The event-stream worker's IndexedDB outbox (lib/event-stream-worker.ts) is sent like the worker sends it.
self.addEventListener("sync", (event) => {
  if (event.tag === "omp-outbox") event.waitUntil(flushOutbox());
});

const done = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function markOutboxFailed(db, id, error) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("entries", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Could not save the outbox failure"));
    const store = transaction.objectStore("entries");
    const request = store.get(id);
    request.onsuccess = () => {
      const entry = request.result;
      // Another sender may have accepted and deleted it while this request was in flight.
      if (entry?.state === "sending") store.put({ ...entry, state: "failed", error });
    };
  });
}

function deleteOutboxEntry(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("entries", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Could not remove the outbox entry"));
    transaction.objectStore("entries").delete(id);
  });
}

// Legacy rows predate every sequenced add; timestamp ties already lost their original ordering.
function compareOutbox(a, b) {
  return (a.enqueueOrder ?? 0) - (b.enqueueOrder ?? 0) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function acceptedOutboxEntry(reply, id) {
  const entry = reply?.data?.entry;
  return reply?.success === true && entry?.id === id &&
    typeof entry.sessionId === "string" && entry.sessionId.length > 0 &&
    ["prompt", "followUp", "steer"].includes(entry.mode) &&
    ["held", "waiting_host", "delivering", "failed", "delivered"].includes(entry.state) &&
    (entry.images === undefined || Array.isArray(entry.images) && entry.images.every((image) => image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string")) &&
    (entry.uploads === undefined || Array.isArray(entry.uploads) && entry.uploads.every((upload) => typeof upload === "string")) &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.mayHaveBeenSent === undefined || typeof entry.mayHaveBeenSent === "boolean") &&
    typeof entry.message === "string" && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) && entry.createdAt >= 0;
}

async function flushOutbox() {
  const open = indexedDB.open("omp-web-outbox", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("entries", { keyPath: "id" });
  const db = await done(open);
  try {
    const entries = await done(db.transaction("entries").objectStore("entries").getAll());
    // Oldest first, and a session's later entries wait while an earlier one fails: the server queues by arrival.
    entries.sort(compareOutbox);
    const waiting = new Set();
    for (const { id, sessionId, scope, advisor, mode, message, images, uploads, uploadProofs, state, createdAt } of entries) {
      if (state !== "sending" || waiting.has(sessionId)) continue;
      // Expired or unscoped rows are never rebound: they are not sent, so they stop blocking that session's later entries.
      const stale = Date.now() - createdAt > 7 * 24 * 60 * 60 * 1000 ? "Not sent within 7 days."
        : typeof scope !== "string" || !scope ? "This message has no saved installation or sign-in scope and cannot be sent." : null;
      if (stale) {
        await markOutboxFailed(db, id, stale);
        continue;
      }
      // A running worker may have added or accepted an entry since our snapshot: only the shared session head can go.
      const current = await done(db.transaction("entries").objectStore("entries").getAll());
      const head = current.filter((entry) => entry.sessionId === sessionId && entry.state === "sending").sort(compareOutbox)[0];
      if (!head || head.id !== id) continue;
      let status = 0;
      let error;
      let timer;
      try {
        const body = JSON.stringify({ type: "outbox_add", id, scope, mode, message, images, uploads, uploadProofs });
        // Include the body read: a half-open POST must not keep every later sync entry waiting forever.
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 40_000 + Math.ceil(body.length / 2));
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${advisor === true ? "?advisor=1" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
        const reply = await response.json().catch((error) => {
          if (controller.signal.aborted) throw error;
        });
        if (typeof reply?.error === "string") error = reply.error;
        status = response.status >= 200 && response.status < 300 && !acceptedOutboxEntry(reply, id) ? 0 : response.status;
      } catch {
        // Offline or timed out: retried below.
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) await deleteOutboxEntry(db, id);
      else if (status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) waiting.add(sessionId);
      else await markOutboxFailed(db, id, error || `HTTP ${status}`);
    }
    if (waiting.size > 0) throw new Error("omp-outbox: entries left to send");
  } finally {
    db.close();
  }
}
