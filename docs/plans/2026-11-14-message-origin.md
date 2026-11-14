# Message origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages that agent tools deliver to another session carry server-written `origin` metadata, render as a distinctive card with a named link to the sender, and agent-tool confirmations and tool rows show sessions by name instead of UUID.

**Architecture:** omp-web's runner already journals per-message data as a `client-message-entry` custom entry. `origin` rides on that entry and on the stamped `message_start`/`message_end` events, so the transcript reader and the live stream both put `message.origin` on the user message. The server builds the origin and the model-facing header; the browser renders from the metadata only.

**Tech Stack:** TypeScript, Bun (`bun test --parallel`), React, lucide-react, the runner (`runner/`, omp SDK).

**Spec:** `docs/specs/2026-11-14-message-origin-design.md`

## Global Constraints

- Only the server creates an origin. `POST /api/agent/[id]` and the browser link's `cmd` refuse a command carrying `origin` with 400 `origin_not_allowed`.
- An origin whose JSON exceeds 4096 UTF-8 bytes is refused (runner) and ignored (reader).
- `origin.v` is `1`. Unknown `kind` values render as a generic card, never as an error.
- The delivered message stays a native user message (`prompt` / `steer` / `follow_up`); no custom messages.
- Session UUIDs never appear as visible labels in the card, tool rows or confirm dialog. Unnamed sessions show `Untitled session · <project> · <date>`.
- Design tokens only, `lucide-react` icons only, no `AbortSignal.timeout`/`any` or `Promise.withResolvers` in client code.
- When the confirm dialog appears does not change: only the two existing prompts get the payload.
- Outbox `origin` (GitHub updates, PR #477) is out of this plan: whichever of the two PRs lands second adds it.

## Review Focus

1. Text that copies the model header, typed by a user or an agent, with no `origin`: must render as an ordinary user bubble.
2. A runner or extension `ui_request` that carries its own `serverPayload`: the wrapper must strip it, so only omp-web's own dialogs show the rich payload.
3. A malformed or oversized `origin` in a journal entry: the reader drops it and the message renders as a plain user bubble.
4. A sender session with no name: the header says `an unnamed omp-web session`, and the UI label is `Untitled session · <project> · <date>`, never the UUID.
5. A host whose daemon lacks the `messageOrigin` feature: the message is still delivered with its header text, without `origin`.

---

### Task 1: Shared origin module

**Files:**
- Create: `lib/message-origin.ts` (browser-safe, relative imports only: the daemon loads the reader)
- Modify: `lib/types.ts` (`UserMessage`)
- Test: `lib/message-origin.test.mjs`

**Interfaces:**
- Produces:
  - `export const ORIGIN_MAX_BYTES = 4096`
  - `export interface SessionOriginRef { id: string; name: string | null; hostId: string; hostLabel: string; cwd?: string; createdAt?: string }`
  - `export interface MessageOrigin { v: 1; kind: string; sentAt: string; session?: SessionOriginRef & { tool: "send_to_session" | "new_session"; delivery: "prompt" | "steer" | "followUp" }; github?: { repo: string; number: number; target: "pr" | "issue"; url: string; events: { kind: string; author: string; bot: boolean; state?: string }[] } }`
  - `parseMessageOrigin(value: unknown): MessageOrigin | null` (shape check plus size cap; `null` when invalid)
  - `formatSessionOriginHeader(origin: MessageOrigin): string`
  - `splitOriginHeader(text: string): { header: string; body: string } | null` (recognizes only the exact header produced above)
  - `parseLegacyAttribution(text: string): { sessionId: string; body: string } | null` for `[From session <uuid> via omp-web agent tools]: <body>`
  - `UserMessage.origin?: MessageOrigin` in `lib/types.ts`

- [ ] **Step 1: Write the failing tests** in `lib/message-origin.test.mjs`:
  - `parseMessageOrigin` accepts a valid session origin; returns `null` for `v: 2`, a missing `sentAt`, a non-object, and an origin of 4097 bytes; keeps an unknown `kind: "future"` with no sub-record.
  - `formatSessionOriginHeader` with name `"Incident review"`, id `01a1c9d8-4206-736f-b9cf-ebccf7912207`, hostLabel `worker-1`, delivery `followUp` equals exactly:
    ```text
    [Message from omp-web session "Incident review" (session id 01a1c9d8-4206-736f-b9cf-ebccf7912207, host worker-1, delivery follow-up).
    It was sent by another agent session, not by the user. Reply with send_to_session to that session id.]
    ```
    With `name: null` the first line starts `[Message from an unnamed omp-web session (session id …`. Delivery words: `prompt` is `new turn`, `steer` is `steer`, `followUp` is `follow-up`.
  - `splitOriginHeader(header + "\n\n" + "body")` returns `{ header, body: "body" }`; text without the header returns `null`.
  - `parseLegacyAttribution("[From session 019c625b-b900-7000-8000-000000000277 via omp-web agent tools]: hello")` returns `{ sessionId: "019c625b-…-277", body: "hello" }`; `null` for a non-UUID id.
- [ ] **Step 2: Run** `bun test --parallel lib/message-origin.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the functions in `lib/message-origin.ts`. Measure the size with `new TextEncoder().encode(JSON.stringify(value)).length`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(origin): shared message-origin contract and model header`.

### Task 2: Runner carries and journals origin

**Files:**
- Modify: `runner/src/commands/prompting.ts` (`readInput`, `UserInput`)
- Modify: `runner/src/correlation.ts` (`ClientMessageClaim`, `claimClientMessage`, `#ended`, `stampClientMessageId`)
- Test: `runner/test/correlation.test.ts`

**Interfaces:**
- Consumes: the `MessageOrigin` JSON shape from Task 1. The runner keeps its own minimal check: a plain object, `v === 1`, string `kind`, at most 4096 bytes. It does not import `lib/`.
- Produces:
  - `claimClientMessage(session, value, origin?: Record<string, unknown>)`. It throws `"origin requires clientMessageId"` when origin is set without an id, and `"origin is invalid or larger than 4096 bytes"` on a failed check.
  - Journal entry `client-message-entry` data `{ clientMessageId, entryId, origin? }`.
  - Stamped `message_start`/`message_end` events carry `message: { ...event.message, origin }` beside `clientMessageId`.

- [ ] **Step 1: Write failing tests** in `runner/test/correlation.test.ts`, following the file's existing harness:
  - A prompt with `clientMessageId: "c1"` and an origin journals `{ clientMessageId: "c1", entryId, origin }`.
  - Its stamped `message_start` and `message_end` have `event.message.origin` deep-equal to the origin.
  - `claimClientMessage(session, undefined, origin)` throws `origin requires clientMessageId`.
  - An origin of 4097 bytes throws `origin is invalid or larger than 4096 bytes`.
  - A follow-up while streaming journals its origin too.
- [ ] **Step 2: Run** `cd runner && bun test test/correlation.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `readInput` passes `args.origin` to `claimClientMessage`, and the claim stores it as `readonly origin`. `#ended` adds `origin` to the journal data when the claim has one. `stampClientMessageId` looks up the claim's origin by id and copies it onto the message.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(runner): journal and stamp a message's origin`.

### Task 3: Reader puts origin on the message

**Files:**
- Modify: `lib/session-reader.ts` (compact entry at the `client-message-entry` branch, `selectSessionContext` journal map, the two places that attach `clientMessageId` to the UI message)
- Test: `lib/session-reader.test.mjs`

**Interfaces:**
- Consumes: `parseMessageOrigin` (Task 1), journal data from Task 2.
- Produces: `entryClientIds` becomes `Map<string, { clientMessageId: string; origin: MessageOrigin | null }>`. Every UI user message built from a journaled entry gets `origin` when it is non-null.

- [ ] **Step 1: Write failing tests** in `lib/session-reader.test.mjs`:
  - A transcript with a user message entry `e1` and a `client-message-entry {clientMessageId: "c1", entryId: "e1", origin}` gives a context whose user message has `origin` deep-equal to the input and `clientMessageId: "c1"`.
  - The same transcript with an origin of `{ v: 2 }` gives a message without `origin`, keeping `clientMessageId`.
  - A journal entry on an abandoned branch does not attach its origin.
- [ ] **Step 2: Run** `bun test --parallel lib/session-reader.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** The compact branch keeps `origin: parseMessageOrigin(entry.data.origin)` when it is non-null. Update every reader of `entryClientIds` to the new value shape.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(reader): attach a journaled origin to its message`.

### Task 4: Host feature flag `messageOrigin`

**Files:**
- Modify: `lib/hosts/link-protocol.ts` (hello `features?: string[]`, parsed like `workspaceOps`, capped at 32 entries)
- Modify: `lib/hosts/daemon.ts` (hello sends `features: ["messageOrigin"]`)
- Modify: `lib/hosts/hub.ts` (link state `features: Set<string>`, set from hello; `RemoteHost.hasFeature(name: string): boolean`)
- Modify: `lib/hosts/host.ts` (`Host.hasFeature(name: string): boolean`)
- Test: `lib/hosts/link-protocol.test.mjs`, `lib/hosts/hub.test.mjs` (existing files)

**Interfaces:**
- Produces: `host.hasFeature("messageOrigin")`, which is false for a daemon whose hello has no `features`.

- [ ] **Step 1: Write failing tests:** a hello line with `features: ["messageOrigin"]` decodes with that array, and one without it decodes with no `features`. A hub fed that hello reports `getHost(id).hasFeature("messageOrigin") === true`; after a hello without it, `false`.
- [ ] **Step 2: Run** `bun test --parallel lib/hosts/link-protocol.test.mjs lib/hosts/hub.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed. Add a one-line comment on the hello field: an optional field, so no protocol version bump.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hosts): hello advertises the messageOrigin feature`.

### Task 5: Agent tools send origin, header and named results

**Files:**
- Modify: `lib/agent-tools.ts` (`AgentToolContext`, `AgentToolDeliverInput`, `AgentToolCreateSessionInput`, the results, `executeAgentTool`; delete `formatAttributedMessage`)
- Modify: `lib/rpc-manager.ts` (`AgentSessionWrapper.send` option `origin`, `answerServerAgentTool` context, `createAgentToolOps().deliver` and `createSession`, including the pooled path)
- Modify: `lib/agent-command.ts` (refuse `origin`)
- Test: `lib/agent-tools.test.mjs`, `lib/rpc-manager.test.mjs`, `lib/agent-command.test.mjs` (existing files)

**Interfaces:**
- Consumes: Task 1 (`MessageOrigin`, `formatSessionOriginHeader`), Task 4 (`hasFeature`).
- Produces:
  - `AgentToolContext` gains `sourceSessionName: string | null`, `sourceHostLabel: string` and `confirm(title: string, payload?: AgentConfirmPayload): Promise<boolean>`. Task 6 defines `AgentConfirmPayload`; this task passes `undefined`.
  - `AgentToolDeliverInput` and `AgentToolCreateSessionInput` gain `origin: MessageOrigin` and `clientMessageId: string`. Their `message`/`prompt` is `formatSessionOriginHeader(origin) + "\n\n" + body`.
  - `AgentSessionWrapper.send(command, options?: { preserveUnknownDelivery?: boolean; origin?: MessageOrigin })` forwards `origin` and `clientMessageId` to the runner only when `this.host.hasFeature("messageOrigin")`. Otherwise it sends the text alone, without `origin` or `clientMessageId`.
  - `send_to_session` result adds `targetSessionName: string | null`. `new_session` result adds `sessionName: string | null`.
  - A declined confirmation returns `{ declined: true, message: "The user declined …" }` as a successful result instead of throwing.

- [ ] **Step 1: Write failing tests:**
  - `agent-tools.test.mjs`: replace the `formatAttributedMessage` assertions. A deliver call has `input.origin.session` `{ id: "source-1", name: "Source", hostId: "local", hostLabel: "This machine", tool: "send_to_session", delivery: "prompt" }`, and `input.message` starts with the Task 1 header and ends with `"\n\nThe build passed"`. A declined confirm returns `declined: true` and calls no `deliver`.
  - `rpc-manager.test.mjs`: `send({type:"prompt", message:"m", clientMessageId:"c1"}, { origin })` on a host with the feature writes a runner frame carrying `origin`. On a host without it, the frame has neither `origin` nor `clientMessageId`.
  - `rpc-manager.test.mjs`: the pooled `new_session` first prompt uses `clientMessageId` `sha256("ompweb:agent-prompt:v1:" + creationId)` in hex, first 64 chars. A replay that the runner answers with `clientMessageId already submitted: <id>` counts as delivered.
  - `agent-command.test.mjs`: a `prompt` command carrying `origin` answers 400 with code `origin_not_allowed`.
- [ ] **Step 2: Run** `bun test --parallel lib/agent-tools.test.mjs lib/rpc-manager.test.mjs lib/agent-command.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** `sentAt` is `new Date().toISOString()` on the server. `send_to_session` uses `randomUUID()` for `clientMessageId`. The replay check matches the runner's error text prefixes `clientMessageId already submitted` and `clientMessageId already resolved` (`runner/src/correlation.ts:124-125`). Add `targetSessionName` from `ops.listSessions()` by id.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent-tools): deliver with origin metadata and a model header`.

### Task 6: Typed confirm payload

**Files:**
- Modify: `lib/agent-tools.ts` (export `AgentConfirmPayload`; pass it at both confirm calls)
- Modify: `lib/rpc-manager.ts` (`confirmFromServer(title, payload?)`; strip `serverPayload` from any `ui_request` that is not in `serverUiRequests`)
- Modify: `lib/types.ts` (`UiDialogRequest` confirm variant gains `serverPayload?: AgentConfirmPayload`)
- Modify: `components/ExtensionDialog.tsx` (confirm body)
- Test: `lib/rpc-manager.test.mjs`, `lib/agent-tools.test.mjs`, `components/ExtensionDialog.test.mjs` (existing or new beside it)

**Interfaces:**
- Produces:
  ```ts
  export type AgentConfirmPayload =
    | { kind: "send_to_session"; from: SessionOriginRef; to: SessionOriginRef | null; delivery: "prompt" | "steer" | "followUp"; message: string }
    | { kind: "new_session"; from: SessionOriginRef; host: { id: string; label: string }; cwd: string; name: string | null; message: string | null };
  ```
  `to: null` renders as "Unknown session". `message` is the body without the header.

- [ ] **Step 1: Write failing tests:**
  - `rpc-manager.test.mjs`: `confirmFromServer("T", payload)` emits a `ui_request` with `serverPayload` deep-equal to the payload. A runner frame `{type:"ui_request", id:"r1", method:"confirm", args:["x",""], serverPayload:{…}}` reaches the browser with no `serverPayload`.
  - `ExtensionDialog.test.mjs`: a confirm with a `send_to_session` payload renders the From and To names as links (`href` contains `session=` and `host=`), the delivery label `Follow-up`, the message in a `pre`-wrapped element, and buttons labelled `Deny` and `Allow and send`. Initial focus is on `Deny`. Escape answers `false`. With `to: null` it shows `Unknown session`.
- [ ] **Step 2: Run** `bun test --parallel lib/rpc-manager.test.mjs lib/agent-tools.test.mjs components/ExtensionDialog.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** The title text becomes `Allow this session to send a message?` or `Start a session on <host label>?`. Links in the dialog use `SessionLink` from Task 7 with `newTab`. The message preview is capped at 300px with a "Show full message" toggle, using the same i18n keys as Task 8.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(confirm): agent-tool confirmations show who, where and what`.

### Task 7: Session links and names

**Files:**
- Create: `components/SessionLink.tsx`
- Create: `lib/session-names.ts` (client cache over `GET /api/sessions`, 30 s TTL, one request in flight)
- Modify: `lib/notification-client.ts` (`OPEN_SESSION_EVENT` detail may be `string | { sessionId: string; hostId?: string }`)
- Modify: `hooks/useNotifications.ts`, `components/AppShell.tsx` (`openSessionById(sessionId: string, hostId?: string)`: offline host gives a toast `"<host> is offline"`; not found gives the existing toast)
- Test: `components/SessionLink.test.mjs`

**Interfaces:**
- Produces:
  - `<SessionLink session={SessionOriginRef} newTab?: boolean />`: an anchor with `href="/?session=<id>&host=<hostId>"`. A plain click dispatches `OPEN_SESSION_EVENT` with `{ sessionId, hostId }` and calls `preventDefault`. A modified click or `newTab` uses the default browser behaviour (`target="_blank"`, `rel="noopener"` when `newTab`). The label comes from `sessionLabel`. When the cached current name differs, a `title` says `Now named <current>`.
  - `sessionLabel(ref: SessionOriginRef, locale: string): string`: `ref.name` when it is set; else `Untitled session · <basename(cwd)> · <date>` (date from `createdAt`, `Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })`); else `Untitled session`.
  - `useSessionName(id: string): string | null` from `lib/session-names.ts`.

- [ ] **Step 1: Write failing tests:**
  - A plain click dispatches `omp-open-session` with detail `{ sessionId: "s1", hostId: "h1" }`. A ctrl-click dispatches nothing.
  - With `name: null`, `cwd: "/srv/app"` and a `createdAt`, the label matches `/^Untitled session · app · /` and never contains the id.
  - `useNotifications` given a string detail still calls `onOpenSession("s1", undefined)`.
- [ ] **Step 2: Run** `bun test --parallel components/SessionLink.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `.ui-focus-ring`, `--accent` link colour, and an `aria-label` of `Open session <label> on <hostLabel>`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): named session links`.

### Task 8: Origin message card

**Files:**
- Create: `components/OriginMessageView.tsx`
- Modify: `components/MessageView.tsx` (in the `role === "user"` branch: `message.origin` renders `OriginMessageView`; no origin plus `parseLegacyAttribution` renders it in legacy mode)
- Modify: the i18n catalogues that hold the `messageView.*` keys
- Test: `components/MessageView.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`splitOriginHeader`, `parseLegacyAttribution`), Task 7 (`SessionLink`, `useSessionName`).
- Produces: `<OriginMessageView message={UserMessage} legacySenderId?: string … UserMessageView's fork/edit props />`.

- [ ] **Step 1: Write failing tests** in `components/MessageView.test.mjs`:
  - A user message with a session origin renders a `role="article"` element labelled `Message from session Incident review on worker-1`, the text `Session message`, a sender link, `worker-1 · Follow-up`, and the body without the header text. A "Show raw" toggle reveals the header.
  - A user message whose text starts with the exact header but has no `origin` renders as the ordinary user bubble (Review Focus 1).
  - An origin of `kind: "github"` shows `owner/repo#12` as an external link and one summary line per event. `kind: "future"` shows a generic label and the body.
  - A legacy-prefixed message renders the card with `Legacy attribution` and a link labelled from `useSessionName`. When the session is unknown, the label is `Unknown session`.
  - The body longer than 300px shows `Show full message` with `aria-expanded="false"`.
- [ ] **Step 2: Run** `bun test --parallel components/MessageView.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the spec's "Incoming card" section for layout, tokens and icons (`MessagesSquare`, `GitPullRequest`, `CircleDot`). Fork and Edit props pass through unchanged.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): render messages from other sessions as an origin card`.

### Task 9: Sender's tool rows

**Files:**
- Modify: `components/MessageView-tool-format.ts` (summary for `send_to_session` / `new_session`)
- Modify: `components/MessageView.tsx` (`ToolCallBlock`: the header renders `SessionLink` for these two tools, outside the toggle button)
- Test: `components/MessageView.test.mjs`

**Interfaces:**
- Consumes: Task 5 result fields (`targetSessionName`, `sessionName`, `declined`, `waited`, `responseText`), Task 7 (`SessionLink`, `useSessionName`).

- [ ] **Step 1: Write failing tests:**
  - A `send_to_session` call `{sessionId:"t1", message:"hello", delivery:"followUp"}` with result `{accepted:true, targetSessionName:"Deploy", waited:false}` renders `To`, a link `Deploy`, `Follow-up`, the state `Accepted`, and the preview `hello`. The text `t1` is not visible.
  - With `waited:true` and `responseText`, the state is `Response received`, and expanding shows the reply.
  - A result with `declined:true` shows `Declined`. An error result shows `Failed`. A partial (running) result shows `Sending`.
  - A `new_session` result `{sessionId:"n1", sessionName:"Release worker"}` renders `Started` with a link `Release worker`.
- [ ] **Step 2: Run** `bun test --parallel components/MessageView.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Before a result exists, the target label comes from `useSessionName(args.sessionId)`, then `Unknown session`. The raw arguments stay behind the existing details disclosure.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): name the target session in agent-tool rows`.

### Task 10: Docs and settings copy

**Files:**
- Modify: `AGENTS.md` (a "Message origin" subsection under Key Design Decisions: journal field, server-only origin, `messageOrigin` hello feature, `serverPayload` stripping)
- Modify: `components/SettingsConfig.tsx` and its i18n string for `settingsConfig.agentToolsDesc` (replace "Delivered messages are prefixed with the sending session's ID." with "Delivered messages show which session sent them.")
- Modify: `CHANGELOG.md` (Unreleased: one Added line)

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run** `npm run typecheck && npm run lint && npm test`. Expected: all pass.
- [ ] **Step 3: Commit** `docs: message origin`.
