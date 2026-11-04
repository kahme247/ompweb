# Message outbox: omp-web holds every message until omp has it — design

Date: 2026-11-04. Status: proposed, not implemented.
Builds on: `docs/specs/2026-11-01-browser-link-design.md` (sequenced lines, `rid` dedupe), `docs/specs/2026-10-31-websocket-link-design.md` (host link seq/ack, outbox, hello), `docs/specs/2026-10-28-remote-hosts-design.md` ("Transport down is not exited").
Replaces, once shipped: the composer's "Sending…" row (`sendQueued` in `components/ChatInput.tsx`).

## Why

When a message cannot reach omp, the user finds out late and in the wrong place. Today:

- A prompt sent while idle shows an optimistic bubble that disappears on failure; a follow-up or steer sent during a run shows nothing in the transcript. While a remote host is offline the send waits for a 503 that can take seconds (`transport_unavailable` after 15 s on the browser link), and then the text drops back into the composer.
- The composer is the only place a refused message survives, so the user has to wait for the answer before typing the next thing.
- An outcome of `delivery: "unknown"` (the link dropped after the command left) drops the draft so it is never sent twice, and the message may be lost.

The outbox moves ownership: once the user presses Send, omp-web is responsible for delivering the message exactly once, across a browser reconnect, a web-server restart and a host outage. The composer clears at once, in every state.

## Decisions

### O1. What the user sees

- Every submitted message (an idle prompt, a follow-up, a steer) appears at once as a **held bubble** at the end of the transcript, after the live turn: dimmed (`--text-muted` on `--user-bg` at reduced opacity), with a status line:
  - **Sending** (spinner): on its way to the web server or the host.
  - **Waiting for <host>** (clock icon): the host is offline; it goes when the host links again.
  - **Not sent** (alert icon): omp refused it (O6). Actions: **Retry**, **Edit** (moves it back into the composer, removing it from the outbox), **Delete**.
- Held bubbles are ordered by submission. Each has a mode chip (Prompt / Follow-up / Steer), changeable while it is held.
- A held bubble leaves when omp has it: a prompt becomes the real user message when omp echoes it; a follow-up or steer becomes omp's queue chip (`queue_update`). There is no gap and no duplicate: the bubble stays until the replacing frame has been applied (O4).
- While held, a bubble offers **Edit** and **Delete**. Once dispatched to the host (O3) it cannot be withdrawn: it shows **Sending** without actions until omp answers.
- Every tab and device viewing the session sees the same held bubbles (O2). This is the one exception to "Never track chips client-side" in `AGENTS.md`: the outbox is server-owned and published like omp's queue, and it holds only what omp does not have yet. omp's queue stays omp's.

### O2. Where the outbox lives

- **Browser → web server.** The composer gives each message a client id (`Math.random().toString(36).slice(2, 12) + Date.now().toString(36)`, as the worker's ids) and keeps it in `sessionStorage` (text, mode, images, upload ids, draft key) until the server confirms it is stored. The message goes as `outbox_add {id, sessionId, mode, message, images?, uploads?}` over the browser link (a sequenced line, resent after a resume) or `POST /api/sessions/[id]/outbox` in SSE mode. `outbox_add` is idempotent by `id` on the server, with no time window: a repeat of a stored id answers the stored entry. This replaces the 10-minute `(session, rid)` dedupe for message sends.
- **Web server.** A per-session outbox in a SQLite store in omp-web's data dir (beside the notification store; `close(true)` on shutdown, WAL, 0600). Rows: `id, session_id, host_id, mode, message, images (JSON), uploads (JSON), state, error, created_at, dispatched_at`. It survives a web-server restart. The `session` channel carries an `outbox_update {entries}` snapshot frame on subscribe and on every change, with the same sequencing as `queue_update`.
- **Host.** The host link already delivers a sequenced line exactly once to a running daemon (seq/ack, resend, duplicate drop). The gap is a daemon restart or a reply lost on the way back; O5 closes it.

### O3. Dispatch

- One dispatcher per session on the web server, FIFO. It sends the oldest held entry when the session's host is linked (`isLinkUp`) and the wrapper is ready (started or adopted, handshake done); it starts the wrapper (`get_state`) if none runs. One entry is in flight at a time per session, so order is kept.
- Mode at dispatch time: a **prompt** whose session is running when it is dispatched goes as `follow_up` (omp starts a turn with it when idle and queues it behind a running one). **Follow-up** goes as `follow_up`, **steer** as `steer` (a steer with no run to steer goes as `follow_up`). `!cmd` and `/btw` never enter the outbox; they keep their own paths.
- Uploads attach at dispatch (`uploadAttach`), so an entry keeps its staged uploads only while the daemon's 24 h sweep has not removed them. An entry older than `STAGED_MAX_AGE_MS` with uploads fails with `upload_missing` (O6) instead of sending without them.
- A held entry has no expiry otherwise: it waits for its host. The bubble shows how long it has waited.

### O4. Hand-off to omp's own state

- **Prompt (idle):** the entry is removed when omp's reply to the command has arrived **and** the user message has been echoed (`message_end` with role `user`) on the session channel. The web server sends `outbox_update` without the entry in the same batch as, or after, the echo frame, so a tab never sees neither.
- **Follow-up / steer:** removed when the reply has arrived and a `queue_update` (or a `get_state` snapshot) containing it has been forwarded, or the user message has been echoed (it was delivered at once).
- The `queuedWhileShellRunning` degrade is a follow-up as above.

### O5. Exactly once across a daemon restart or a lost reply

- Each dispatched command carries the outbox id as `outboxId`. The daemon records, per channel, the outbox ids it has written to the child's stdin (a bounded ring, 256 entries) and reports them in its `hello` (`channels[].delivered`) and in each `res`. This is an added optional field: a compatible link change (`LINK_PROTOCOL_VERSION` 7, `MIN` unchanged). A daemon on v6 or below reports nothing, and the web server treats a lost reply from it as **unknown** (below).
- After a reconnect, an entry in flight whose id is in `delivered` is done (O4 then removes it as frames arrive); one whose id is absent was never written and goes again.
- **Unknown** (a v6 daemon, or a daemon restart, which also kills its children): the entry becomes **Not sent** with "may have been sent", and Retry warns. It is never resent automatically.
- omp itself has no message id to dedupe on; the daemon's record is the delivery proof, because a line written to a live child's stdin reaches it.

### O6. Failures

- omp refuses the command (validation, unknown command, oversized) → **Not sent** with omp's message. Nothing goes back into the composer by itself: Edit does that.
- The web server refuses `outbox_add` (413, 429, unknown session) → the composer keeps the message in its local list as **Not sent**; nothing reached the server.
- A deleted session fails its entries; an archived one keeps them held until it is restored.

### O7. Chat ids: omp-web names the conversation, not omp

The outbox needs a key before omp exists for the conversation: a new chat has no omp session until omp starts and writes its header, and today the browser waits for that (`ensureNewSession`, then `promoteNewSession`) before it can send.

- At the first Send of a new chat the composer creates a **chat id** (same generator as the message id), and `outbox_add` carries `{chatId, hostId, cwd, model?}` instead of a session id. The web server stores the chat (`chats` table: `chat_id, host_id, cwd, model, session_id`) and its entries, and the dispatcher starts the session when the host links (`/api/agent/new` semantics). When omp reports its session id, the server fills `session_id` and publishes it on the chat's channel; the URL and draft key move from the chat id to the session id as `promoteNewSession` does today.
- An existing session's chat id is its session id. A session move (omp >= 18.5 ownership) keeps the chat's entries: they follow the wrapper's registry, which already aliases the old id.
- Whether omp can take a caller-assigned session id (so the chat id *is* the omp id and the mapping disappears) is an open question; the design does not depend on it.

## What this retires

The browser stops being a delivery agent, so the code that keeps a send alive in the tab goes:

- **The "deliver after the chat was switched away" exceptions in `handleSend`** (`hooks/useAgentSession.ts`): the startup path that still sends the prompt when the hook unmounted while omp spawned (#389: the `hookAliveRef` / `EventStreamConnectionError` exception, and `AGENTS.md` "A user's prompt is the exception to abandoned readiness"), and the new-chat `ownerGone` background delivery. With the outbox, Send ends when the server has stored the message; switching chats afterwards cannot lose it, because no browser code is sending it. The tests added for them become outbox tests (a stored entry is dispatched with no tab open).
- **The composer's "Sending…" row** and its per-send recovery for messages (`recoverDraft` on refused queue sends, `PromptSubmissionResult.recoveryKey`, the `delivery: "refused" | "unknown"` draft handling).
- **The optimistic user bubble** (`optimisticUserMessage`): held bubbles replace it.
- **The 10-minute `(session, rid)` dedupe for message sends**: `outbox_add` dedupes by id with no window. It stays for other commands.

Readiness for observing a session (event stream waits, `ensureEventsConnected`) keeps its rules; it now serves display only, never delivery.

## Phases

1. **Server outbox for existing sessions** (O1–O4, O6): store, `outbox_add`, `outbox_update`, dispatcher, held bubbles. Retire the "Sending…" row, the optimistic bubble, the switched-away delivery in `handleSend` (#389) and the composer's per-send recovery.
2. **Delivery record on the daemon** (O5): link v7 field, resend on reconnect.
3. **New chats** (O7): chat ids, server-side session start; retire the `ownerGone` delivery.

## Open questions

- Should Stop (`abort_and_restore_queue`) also withdraw held entries into the composer, as it does omp's queue? Proposed: no, they are not in omp's run yet; Stop leaves them held and they go after the abort as their modes say.
- Inline images in SQLite: up to 5 MB per message base64; acceptable, or move them to the uploads path (As file) when held?
- Edit of a message being dispatched: proposed refused until omp answers, as above.

## Not doing

- Client-only holding (tab memory or `sessionStorage` alone): other tabs would not see the held messages, and a closed tab would lose them.
- Holding beyond what omp offers: no scheduled sends, no reordering of omp's queue.
