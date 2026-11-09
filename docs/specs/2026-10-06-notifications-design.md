# Notifications: Web Push, in-page fallback, and settings

Status: approved design, 2026-10-06; updated to match the implementation.

## Goal

omp-web notifies the user about session events on desktop browsers and on the
installed PWA (Android, and iOS 16.4+ when added to the Home Screen). A
Notifications tab in Settings lets each device choose which events notify and
how. Tapping a notification opens the session that produced it. No
notification is shown for a session the user is currently viewing.

## Notification types

| Type | Trigger frame (rpc-ui) | Body |
|---|---|---|
| `completed` | `session_settled`, unless the last `prompt_result` of that stretch had `status` `error` or `aborted` | "Task finished." |
| `input` | `extension_ui_request` with `method` `select`, `confirm`, `input`, `editor`, `ask` or `open_url` that omp-web does not auto-answer | "Waiting for your answer: <title or first question>" |
| `error` | `prompt_result` with `agentInvoked: true` and `status: "error"`, an asynchronous prompt failure (`response` with `success: false`), or omp child exit while a run or its background work is in progress; one notification per run | "Run failed: <error.message>" |
| `modelSwitch` | `retry_fallback_applied {from, to, reason?}`, or `notice` with `source` `prewalk` or `plan-yolo` | "Switched <from> → <to>: <reason>", or the notice text |

The title is the session name, falling back to the cwd's last path segment.

Rules:

- Subagent activity never notifies. Subagent frames arrive as
  `subagent_lifecycle` / `subagent_progress` / `subagent_event`; the detector
  only inspects top-level frame types.
- `completed` waits for `session_settled` rather than `prompt_result`, so
  background work the prompt started (async tasks, queued follow-ups) is done
  too. A run woken by background work with no prompt also completes this way.
- Local slash commands (`prompt_result` with `agentInvoked: false`), aborted
  runs, `auto_retry_start` and `auto_retry_end {success: true}` never notify.
- The `modelSwitch` reason is `retry_fallback_applied.reason` when present
  (usage-aware fallback). omp sends a reason-less fallback before the
  `auto_retry_start` of the same failure, so the detector holds it and takes
  that frame's `errorMessage` (classifier refusals such as Fable falling back
  to Opus, rate limits, provider failures). A fallback still held at
  `auto_retry_end`, `prompt_result` or `session_settled` is sent without one.
- Every notification has tag `<sessionId>:<type>`, so a repeat replaces the
  previous one instead of stacking. An `input` notification is retracted when
  the dialog behind it settles (answered, cancelled, expired, or its omp child
  went away): every reachable tab gets a `notification-dismiss` frame naming
  the tag and request id. No push carries the retraction — a push that
  displays nothing is a silent push, which browsers punish — so a device that
  is not reachable keeps the stale card until the next `input` push replaces
  it by tag. The request id rides on every delivery, so a retraction closes
  only its own dialog and never the next one of the same tag.

## Architecture

```
omp child ──frames──▶ AgentSessionWrapper.handleFrame (lib/rpc-manager.ts)
                          │  createNotificationDetector() (lib/notification-events.ts)
                          ▼
                 publishNotification() (lib/notification-hub.ts: presence-aware routing)
                    │                                   │
     {kind: toast|os} on /api/agent/running/events   Web Push (web-push)
                    │                                   │
     SessionSidebar → window event → useNotifications   public/sw.js
```

Detection and routing run on the server, so sessions that are not open in any
tab still notify. Toast and in-page messages ride the running-sessions SSE
stream the sidebar already holds (`?clientId=`): browsers allow only
six HTTP/1.1 connections per host, so a tab must not open another stream.

### `NotificationEvent`

```ts
interface NotificationEvent {
  type: "completed" | "input" | "error" | "modelSwitch" | "test";
  sessionId: string;
  sessionName: string | null;
  detail?: string; // question, error text, or model-switch reason
  from?: string;
  to?: string;
}
```

`renderNotification(event, t)` turns it into `{title, body, url, tag,
sessionId}` with `url = "/?session=<encoded id>"`; details are clipped to 180
characters. The browser renders with its own locale; the server renders pushes
in the device's stored locale.

### Presence

Each page load generates a `clientId`; each browser profile keeps a `deviceId`
in `localStorage`. A tab reports presence with
`POST /api/notifications/presence {clientId, deviceId, visible, sessionId, seq}` on
mount, `visibilitychange`, session switch, the first input after idling,
`pagehide` (beacon, `visible: false`), and every 30 seconds while present.
`visible` means the page is visible and had input (pointer, key, wheel, touch,
focus) in the last 3 minutes. `sessionId` is null while full-page Settings
hides the chat. A report expires 60 seconds after the server received it.
`seq` increases with every report from the page; the server ignores a report
older than the one it holds, since requests can arrive out of order. Device
PUTs run one at a time and read the current prefs when sent.

Presence and SSE streams are tracked separately: streams reconnect and overlap
while the tab stays where it is. A tab is "reachable" while it has an open
stream, and "active" when its presence is visible and it is reachable.

### Routing (`routeNotification`)

For each event:

1. If a visible tab is showing `event.sessionId`, drop the event for every
   device, in every mode. This uses presence only, so a reconnecting stream
   cannot leak a notification for the viewed session. A session omp moved to a
   new file carries its earlier ids as `aliases`, and tabs showing any of them
   count as viewing it.
2. For each device whose prefs enable notifications and the event's type:
   - if any tab (on any device) is active and the device has
     `whenActive: "toast"`, send `{kind: "toast"}` to that device's active
     tabs; a device with no active tab stays quiet;
   - otherwise send a system notification: Web Push when the device has a
     subscription, else `{kind: "os"}` to each of its reachable tabs, which
     show it with `registration.showNotification` (or a toast when the
     browser no longer allows notifications).

A tab may declare its notification device on the `notifications` channel
(`{kind: "notifications", clientId, deviceId}`). Such a tab is reachable
without a presence report, which is how a native client with no push
subscription receives `{kind: "os"}` frames while its app is in the
background. Stream-only delivery fills only the gap presence leaves:
**it never overrides the `whenActive: "toast"` rule**. While another device
has an active tab, a stream-only tab of a `toast` device stays quiet — the
background app intentionally shows nothing while the user is at the desk —
and the same device with `whenActive: "system"` does get its frame. Rule 1
still applies first: a visible tab showing the session silences everything.
A stream that declares no device keeps the pre-device behaviour and receives
no stream-only delivery; a malformed `deviceId` is refused by
`parseEventStreamChannel` rather than silently ignored.

The server decides before pushing, and the service worker always displays a
push: iOS Safari revokes push permission for pushes that show nothing.

### Web Push and storage

- Dependency: `web-push`.
- The VAPID key pair, generated on first use, and up to 50 devices
  `{deviceId, prefs, subscription?, updatedAt}` live in omp-web's SQLite
  notification store (see
  `2026-10-12-persistent-notifications-design.md`, which replaced the original
  `notifications.json`). A push endpoint belongs to one device; saving it
  removes it from any other. Over the cap, devices that are neither enabled nor
  subscribed are dropped first. omp-web instances sharing the agent directory
  see each other's devices and keys.
- VAPID subject: `https://github.com/kahme247/ompweb` (Apple rejects subjects it
  cannot resolve, such as `mailto:…@localhost`).
- Only HTTPS push endpoints are accepted.
- A push failing with HTTP 404 or 410 drops that subscription and keeps the
  device prefs. Other failures are logged.
- Push TTL 1 hour; urgency `high` for `input` and `error`, `normal` otherwise.
- On every app load with notifications enabled and permission granted, the
  browser re-subscribes if it has no subscription or one signed with a
  different server key, and re-sends it to the server.

### Service worker (`public/sw.js`)

- Registered at `/sw.js`, scope `/`. No caching.
- `push`: `showNotification(title, {body, icon: "/icon-192.png", badge:
  "/badge-96.png", tag, renotify, data: {url, sessionId}})`.
- `notificationclick`: focus an existing window. An app window (`/`) gets
  `postMessage({type: "omp-open-session", sessionId})` and selects the session
  in place; any other window (the sign-in page) navigates to the session URL;
  with no window, `clients.openWindow(url)`.
- `/sw.js` and `/badge-96.png` are exempt from the password gate in
  `proxy.ts`: browsers re-fetch the worker for update checks without the
  sign-in cookie.
- Session links survive sign-in: `proxy.ts` redirects `/?session=…` without a
  valid cookie to `/login?next=/?session=…`, and the sign-in form returns to
  `next` when it starts with `/?`.

### HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/api/agent/running/events?clientId=` | GET | existing SSE stream, now also `{type: "notification", kind, event}` and `{type: "notification-dismiss", tag, sessionId, requestId}` |
| `/api/notifications/presence` | POST | presence report |
| `/api/notifications/devices?deviceId=` | GET | VAPID public key, whether this device has a subscription |
| `/api/notifications/devices` | PUT | `{deviceId, prefs, subscription?}`; an omitted subscription keeps the stored one |
| `/api/notifications/test` | POST | `{deviceId}`: a test push; 502 with the push service's answer when it fails |
| `/api/notifications/answer` | POST | `{sessionId, requestId, response}`: answer a pending blocking dialog from a notification |

All routes sit behind the existing password gate and origin check.

### Answering from a notification

A blocking dialog (`confirm`, `select`, `input`, `editor`, `ask`) is carried in
the `input` notification's `dialog` field, in the SSE frame, the history entry
and the push body, so a client can offer its answer without an open chat tab.
`POST /api/notifications/answer` takes `{sessionId, requestId, response}` with
exactly one response variant: `{confirmed}`, `{value}`, `{cancelled: true}`, or
`{answers}` for an `ask`. The body is capped at 64 KiB and read with
`parseJsonWithinLimit`.

- The route looks the session up in the live registry (also through the aliases
  omp's session moves left) and never spawns omp: an unknown or exited session
  answers `200 {status: "sessionGone"}`, and a request id that is not pending
  answers `200 {status: "alreadySettled"}`. Neither is an error.
- The answer is checked against the pending dialog first, so a payload the
  dialog cannot take is a 400 and leaves the question answerable: a `select`
  takes one of its own labels, a `confirm` a confirmation, an `input`/`editor`
  a value, and an `ask` its answers. A request whose method is not a dialog
  takes no answer at all: `open_url` is fire-and-forget (omp registers no
  resolver for it), so any response to it is a 400 `invalid_dialog_answer`
  before anything is sent. An `ask` payload is validated with omp's
  own rules (`parseAskDialogResponse` in `rpc-mode.ts`): one answer per
  question in request order, each answer naming its own question id, only
  labels that question offers, no label twice, and a single-select question
  takes either one label or free text — never both. `customInput` is trimmed
  before it counts, as omp trims it. A cancel is always accepted.
- An accepted answer goes through the same `extension_ui_response` command the
  desktop dialog sends, so it resolves a server-owned confirmation and applies
  the offline/restarting gate: a host that is offline answers 503
  `{hostOffline: true}` and a restarting session 400 `session_restarting`,
  never `answered`. The dialog is settled only after the answer was admitted.
- Settling a dialog retracts its notification on every reachable tab:
  `{type: "notification-dismiss", tag, sessionId, requestId}`, and the history
  entry of exactly that request becomes read. A newer dialog of the same tag
  keeps its own unread entry. A push retry that wakes after the settlement
  delivers nothing. No push carries the retraction: a push that displays
  nothing is a silent push (iOS revokes the permission, Chromium and Firefox
  substitute a generic card and mute the origin), so a device that is not
  reachable keeps the stale card until the next `input` push replaces it by
  tag or the app syncs.
- A resync that dropped a dialog (a linked host discarding buffered output)
  retracts it too, but as a *forgotten* settlement: the retraction is
  temporary, so if the host replays the same request id the question is
  announced and pushed again instead of being suppressed. A permanent
  settlement of the same request is never lifted by that.

## Settings: Notifications tab

A `SettingsTabs` category `notifications` (icon `Bell`). Contents:

- **Enable notifications**. Turning it on requests permission (first await in
  the click handler, for Safari), saves the prefs, and subscribes to push
  when available.
- **Status** (alert), one of: push active; in-page only (no push support);
  needs HTTPS; add to Home Screen first (iOS browser tab); blocked by the
  browser; unsupported.
- **Toggles**, one per type: Task finished (on), Waiting for input (on), Run
  failed (on), Model switched automatically (off).
- **When I'm using omp-web in another tab**: "Show an in-app toast" (default)
  or "Always send a system notification".
- **Send test notification**: a real push for subscribed devices, else a
  local notification from the page.

```ts
interface NotificationPrefs {
  enabled: boolean; // default false
  types: Record<"completed" | "input" | "error" | "modelSwitch", boolean>;
  whenActive: "toast" | "system";
  locale: string; // UI locale, for server-rendered pushes
}
```

Prefs live in `localStorage` and are sent to the server on every change, and
on app load for browsers that ever saved them (so a missed save, such as turning notifications off, is repaired). Other tabs pick changes up through the
`storage` event. Strings are in `lib/i18n` (English, Japanese, Simplified
Chinese).

## In-app toast

`{kind: "toast"}` shows through the existing `toast` helper (`toast.error` for
`error`, `toast.info` otherwise) with an **Open** button that selects the
session.

## Removed or replaced

- The completion notification in `AppShell.handleAgentEnd` and
  `lib/browser-notifications.ts` (with its test).
- The `notify` host tool shows through the service worker registration when
  one exists; `new Notification` remains the fallback.

## Platform notes

- Desktop: Web Push notifications appear in the OS notification center.
  Delivery needs the browser process running; no tab needs to be open.
- Android: Chrome and the installed PWA.
- iOS/iPadOS 16.4+: push only in the Home Screen app.
- Push, service workers and the Notification API need a secure context
  (`localhost` or HTTPS). Over plain HTTP on another host only in-app toasts
  work.
- The server needs outbound HTTPS to the browser push services.

## Testing

- `lib/notification-events.test.mjs`: completion on settle (not per prompt or
  subagent), slash commands and aborts silent, error once, input from blocking
  dialogs only, model-switch reason precedence, prefs validation, rendering.
- `lib/notification-hub.test.mjs`: routing rules above, stale presence, HTTPS
  endpoint validation, 410 drops the subscription, store file mode.
- Manual: desktop Chrome on `localhost` (push, toast, click opens the
  session); Android PWA over HTTPS.
