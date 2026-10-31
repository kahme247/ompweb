// omp-web service worker: shows notifications and opens their session on click.
// It does not cache anything; the app stays online-only.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Unreadable payload: still show something (iOS revokes silent pushes).
  }
  // A settled dialog is retracted by tag. This branch never displays anything,
  // which is why the server sends dismiss pushes only to endpoints that are not
  // Apple's: iOS revokes Web Push permission for a push that shows no notification.
  if (data.type === "dismiss") {
    const tag = typeof data.tag === "string" ? data.tag : "";
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    event.waitUntil((async () => {
      // Web Push is not ordered and can be buffered while the device is
      // offline: a late retraction must not close the next dialog's
      // notification of the same tag, so only the matching request closes.
      if (!tag || !requestId || typeof self.registration.getNotifications !== "function") return;
      const shown = await self.registration.getNotifications({ tag });
      for (const notification of shown) {
        if (notification.data && notification.data.requestId === requestId) notification.close();
      }
    })());
    return;
  }
  const requestId = typeof data.requestId === "string"
    ? data.requestId
    : typeof data.dialog?.requestId === "string" ? data.dialog.requestId : "";
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
        data: { url: data.url || "/", sessionId: shown.sessionId, ...(requestId ? { requestId } : {}) },
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
