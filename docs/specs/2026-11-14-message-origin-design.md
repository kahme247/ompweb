# Message origin: messages from other sessions and tools

Status: draft for approval (2026-11-14).

## Intent

Some messages a session receives were not typed by the user. Another agent session sends them through omp-web's agent tools (`send_to_session`, `new_session` with a first prompt), and soon omp-web's GitHub watch tool will send them too (PR #477). Today they arrive as plain user messages whose text starts with a prefix such as `[From session 01a1c9d8-… via omp-web agent tools]: …`, so in the chat they look like something the user typed, and the only clue to the sender is a UUID.

The user wants to:

1. see at a glance that a message came from another session or tool, which one, and open the sending session with one click;
2. never read raw session UUIDs in the UI: sessions appear by name, as links;
3. approve a cross-session send knowing what will be sent, from where, and to where;
4. keep the receiving agent fully informed: it must still know who sent the message and how to reply (for example, the sender's session id for `send_to_session`).

## Goals

- Every message omp-web itself sends on behalf of a session or tool carries structured **origin** metadata that is stored beside the message and never reaches the model.
- The chat renders such messages as a distinctive card built from that metadata.
- The receiving agent still gets a readable header with what it needs to reply.
- Agent-tool confirmations show the sender, the target, the delivery mode and the message itself, with sessions as named links.
- The sender's own `send_to_session` / `new_session` tool rows name the target session as a link instead of showing its id.

## Non-goals

- Rewriting UUIDs that appear inside arbitrary transcript text (assistant prose, tool output). Only structured places (cards, tool rows, confirmations, receipts) get names.
- Changing delivery semantics: prompt / steer / follow-up rules, waiting for a reply, outbox durability and the chain-depth cap stay as they are.
- Changing what omp sends the model beyond the header text below.
- A new auto-approval setting for agent tools.

## Anti-goals

- **Forgeable provenance.** A user or agent typing the header text must never produce the card. The card comes only from metadata the server wrote.
- **Raising message authority.** The delivered message stays a native user message. It is not a custom message, which omp would hand the model as a developer message.
- **Breaking the outbox or delivery tracking.** Echo matching, queue chips, `clientMessageId` correlation and wait-for-turn-end must behave exactly as today.

## Constraints

- omp-web runs its own omp build through `runner/` (`ompweb-omp`, pinned in `runner/omp-build.json`). omp's entries cannot carry extra fields, so the runner already journals per-message data as a `client-message-entry` custom entry `{clientMessageId, entryId}` (`runner/src/correlation.ts`), which `lib/session-reader.ts` joins back onto the message.
- Sessions live on several hosts. Transcripts are read on the owning daemon, and names and hosts come from the session index (`listSessionsAllHosts`).
- The confirm dialog takes only a plain-text title today (`confirmFromServer(title)` in `lib/rpc-manager.ts`, rendered as text by `components/ExtensionDialog.tsx`).
- UI rules from `AGENTS.md`: design tokens only, `lucide-react` icons, no client APIs that old mobile browsers lack.

## Approaches considered

- **A. Structured text header only, parsed when rendering.** Smallest change, and it covers old messages. Rejected as the main transport: anyone can type the header, so the card could be faked.
- **B. Native user message plus stored origin metadata (chosen by the user).** Delivery stays a native prompt / steer / follow-up. The metadata travels with the command and is stored and replayed beside the entry. omp-web ships its own runner, so this needs no upstream omp change.
- **C. An extension custom message with `details`.** Rejected: omp converts custom messages to developer messages for the model (more authority), agent-attributed ones are missing from the queue chips, and the outbox and wait-for-turn-end logic would need reworking.
- **D. A separate sidecar store.** Rejected: two writes and a join, with orphans, branches and exports going out of sync.

### How B is built (my call, within the user's choice)

The runner's existing correlation journal carries the metadata. A command that carries `origin` also carries a `clientMessageId` (outbox entries already do; agent-tool deliveries get a fresh one). The runner writes `origin` into that message's `client-message-entry` journal entry and stamps it on the live `message_start` / `message_end` events, exactly as it stamps `clientMessageId` today. No omp fork change is needed.

## Design

### Origin contract

```ts
interface MessageOrigin {
  v: 1;
  kind: "session" | "github"; // unknown kinds render as a generic card
  sentAt: string;             // ISO, set by the server
  session?: {                 // kind "session"
    id: string;
    name: string | null;      // snapshot at send time
    hostId: string;
    hostLabel: string;        // snapshot at send time
    tool: "send_to_session" | "new_session";
    delivery: "prompt" | "steer" | "followUp";
  };
  github?: {                  // kind "github" (PR #477)
    repo: string;             // OWNER/REPO
    number: number;
    target: "pr" | "issue";
    url: string;
    events: { kind: string; author: string; bot: boolean; state?: string }[];
  };
}
```

- Only the server creates origins. The agent tools fill `session` from the calling wrapper (`ctx.sourceSessionId`, its current name and host), never from tool arguments. The GitHub watcher fills `github` itself.
- Trust boundary: a browser `outbox_add` or `POST /api/agent/[id]` that carries `origin` is refused (400). Server-side callers set it through an internal parameter that the HTTP and browser-link parsers never accept.
- Size cap: an origin over 4 KiB is refused. Event lists are truncated to the first 20 events plus a count.

### Flow

1. **Agent tools** (`lib/agent-tools.ts`, `createAgentToolOps` in `lib/rpc-manager.ts`): `deliver` and `createSession` send `{ type, message, clientMessageId, origin }`. `message` is the model header plus the body (below).
2. **GitHub watch** (PR #477): its outbox entries store `origin`. The dispatcher passes it along with the entry's `clientMessageId`. Whichever PR lands second adds this. If #477 lands first, this design adds `origin` to its entries.
3. **Outbox** (`lib/message-outbox.ts`): a server-set `origin` column, shown in the `outbox_update` held entries, so a held bubble already renders as the card.
4. **Runner** (`runner/src/commands/prompting.ts`, `runner/src/correlation.ts`): `readInput` accepts an optional `origin` (validated shape and size) only together with `clientMessageId`. The claim keeps it, journals it as `client-message-entry {clientMessageId, entryId, origin}`, and `stampClientMessageId` adds it to `message_start` / `message_end`. Queue snapshots carry it beside `clientMessageIds`, so queue chips can show the sender.
5. **Reader** (`lib/session-reader.ts`): the compact entry keeps `origin` from the journal, and the join puts it on the message (`message.origin`). Live frames carry it the same way.
6. **Fallback for old messages**: a user message that has no origin but starts with the legacy prefix `[From session <uuid> via omp-web agent tools]: ` renders as the card with a "Legacy attribution" note. The sender is resolved by id from the session list, with no host or delivery shown.

### What the receiving model sees

The server writes a fixed header before the body. Session messages:

```text
[Message from omp-web session "Incident review" (session id 01a1c9d8-4206-736f-b9cf-ebccf7912207, host worker-1, delivery follow-up).
It was sent by another agent session, not by the user. Reply with send_to_session to that session id.]

<body>
```

An unnamed sender gets `an unnamed omp-web session`. GitHub updates keep #477's own `GitHub update (omp-web): OWNER/REPO#N <URL>` header.

When a message has an origin, the card hides the header it recognizes. A "Show raw" toggle shows the text as sent. Text with a header but no origin renders as an ordinary user message.

### Incoming card (`components/MessageView.tsx`)

A new `OriginMessageView`, chosen when a user message has `origin`:

- Full transcript width, left-aligned, with a left accent rule. It is not the right-aligned user bubble, and not a centred system notice.
- Surface: `--bg` body, `--bg-panel` header, `--border`, `--radius-card`, accent rule `--accent`. Text `--text`, metadata `--text-muted`, links `--accent`. No new colours, shadows or opacity changes. Light and dark use the same structure and tokens.
- Header for `session`: `MessagesSquare` icon, "Session message", then "From **‹name›**" as a link, host, delivery ("New turn", "Steer", "Follow-up"), time right-aligned (`<time>` with the full date in a tooltip).
- Header for `github`: `GitPullRequest` or `CircleDot` icon, "**OWNER/REPO#N**" linking to GitHub in a new tab, and one short summary per event ("Review from coderabbitai · changes requested", "CI: 12 passed, 1 failed", "Merged").
- Unknown kind: generic icon and label, body only.
- Body: the chat's markdown renderer, capped at the existing 300px user-message height, with Show full message / Collapse (`aria-expanded`, `aria-controls`) and Copy. The identity header stays outside the capped area.
- Mobile: two header lines (sender, then host · delivery · time), wrapping long names; no horizontal scrolling.
- Accessibility: the card's label is "Message from session ‹name› on ‹host›". The link's label is "Open sender session ‹name› on ‹host›". Icons are `aria-hidden`. The card itself is not clickable.
- Fork and Edit on these messages behave as on any user message.

Desktop:

```text
┃ [MessagesSquare] Session message                       12:41
┃ From Incident review ↗     worker-1 · Follow-up
┃ ───────────────────────────────────────────────────────────
┃ Incident attribution from read-only historical consult:
┃ most likely nested agent ...
┃ Show full message                                     Copy
```

Mobile:

```text
┃ [icon] Session message
┃ From Incident review ↗
┃ worker-1 · Follow-up · 12:41
┃ ─────────────────────────────
┃ Incident attribution from
┃ read-only historical consult…
┃ Show full message       Copy
```

Held outbox bubbles and queue chips use the same header in compact form: an icon plus "From ‹name›".

### Session links and names

- A session link is a real anchor (`/?session=<id>`). A plain click opens the session through `openSessionById` (`components/AppShell.tsx`). A modified click opens a new tab.
- The label is the name snapshot from the origin. A session with no name shows "Untitled session · ‹project› · ‹date›", never its UUID. If the session has since been renamed, a tooltip says "Now named ‹current›".
- A deleted or unknown session keeps its name, and the link reports "Session no longer available". On an offline host, the link reports "‹host› is offline" instead of treating the session as deleted. `openSessionById` gets that distinction.
- One shared component (`SessionLink`) serves the card, the tool rows, the confirm dialog and receipts.

### Confirm dialog

`confirmFromServer` takes an optional typed payload next to the title:

```ts
{ kind: "send_to_session", from: SessionRef, to: SessionRef, delivery, message }
{ kind: "new_session", from: SessionRef, host: { id, label }, cwd, name?, message? }
// SessionRef = { id, name, hostId, hostLabel }
```

The plain title stays as the fallback for clients without the payload. `ExtensionDialog` renders the payload:

```text
Allow this session to send a message?

From     Incident review ↗           worker-1
To       Deployment investigation ↗  production-host
Delivery Follow-up (after its current turn)

Message
┌──────────────────────────────────────────────┐
│ Incident attribution from read-only …         │
└──────────────────────────────────────────────┘
Show full message
                                  [Deny] [Allow and send]
```

- The message is shown as escaped, pre-wrapped text, not rendered markdown. The full text is reachable before approving.
- Links in the dialog open in a new tab, so the pending decision is kept.
- Default focus is Deny. Escape or close means deny. One approval covers exactly this sender, target, message and delivery.
- `new_session`: "Start a session on ‹host›?" with the cwd, the proposed name and the first-message preview.
- The approval and declined error texts sent back to the agent keep their ids, because the agent addresses sessions by id.

### Sender's tool rows

`send_to_session` and `new_session` tool calls in the sender's transcript render as a compact activity row, not a card:

```text
✓ [MessagesSquare] To Deployment investigation ↗ · Follow-up
  Incident attribution from read-only historical consult…     ▸
```

- State comes from the actual tool state: Sending, Accepted, Response received, Declined, Failed.
- The target name comes from the session index when the row renders. If the tool result has the session's name, that wins.
- Expanding the row shows the message and the reply text (for a waited delivery). The raw arguments stay behind the existing diagnostic disclosure.
- The link sits outside the row's toggle button, so controls are never nested.

### Compatibility

- Hosts running a runner without `origin` support refuse unknown fields or ignore them. The server checks the runner's capability (hello) and omits `origin` for older runners. The message then arrives with the header only and renders as a plain user message.
- Old transcripts render via the legacy-prefix fallback.

### Decisions settled after review (author's calls)

- **When the confirm dialog appears does not change.** Only the two existing prompts are enriched: `send_to_session` from a session on another host, and `new_session` on a host that does not allow agent starts. A target that cannot be resolved shows "Unknown session" and the send then fails as today.
- **Idempotent `new_session` replays.** The first prompt's `clientMessageId` is derived from the pooled path's `creationId`. When the runner reports the id as already journaled on a replay, that counts as delivered, not as an error. `send_to_session` gets a fresh random id per call.
- **Capability gate.** The runner and the daemon ship in the same release, since each install fetches its runner from its own release. One hello capability on the host link (`messageOrigin`) gates sending `origin`. No link-protocol version bump is needed: the field is optional and ignored by readers that predate it.
- **Internal entry point.** `AgentSessionWrapper.send(command, { origin })` takes the origin as an option. Command parsers (`POST /api/agent/[id]`, browser-link `cmd`, `outbox_add` from a browser) refuse an `origin` field with 400.
- **Structured tool results.** `send_to_session` results add `targetSessionName`. `new_session` results add `sessionName`. A declined confirmation returns a result with `declined: true` instead of only an error string. These fields are visible to the model, which is harmless and helps it.
- **Host-qualified links.** Session links carry the host (`/?session=<id>&host=<hostId>`), and `openSessionById(id, hostId?)` prefers that host. This keeps "‹host› is offline" apart from "no longer available" when a copied session id exists on two hosts.
- **Edit and Fork drop the origin.** Editing an origin message and resending it makes it the user's own message, so it renders as an ordinary user message.

## Left to the builder

- Exact i18n keys and wording beyond the strings shown here.
- How the capability check is exposed (hello field or version comparison), following the runner's existing pattern.
- Whether `SessionLink` resolves current names from the existing sessions list in the shell or through a small hook.
- Test layout, following the repo's existing test files for each module.
