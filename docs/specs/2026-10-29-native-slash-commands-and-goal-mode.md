# Native Slash Commands and Goal Mode

- **Status:** Implemented
- **Date:** 2026-10-29
- **Scope:** omp-web command dispatch, native goal mode, extension/skill commands
- **omp baseline:** 18.13.3+ (`rpc-ui` protocol)

## 1. Summary

omp-web used to treat `/goal`, `/review`, `/advisor`, `/compact`, and `/session`
as client-side prompt expansions, and it hid every `builtin` command from the
composer palette. That made real omp commands look unavailable and made a
text prompt look like goal mode.

The implementation now treats `get_available_commands` as the single source of
truth:

- Every command omp reports — `builtin`, `extension`, `custom`, `mcp_prompt`,
  `file`, and `skill` — is shown in the palette and sent to omp through the
  normal `prompt` path.
- `/goal` uses omp's native `goal` RPC and `goal_updated` /
  `get_state.goal` state.
- Web-only prompt expansions are used only for names omp does not provide, and
  they yield to an omp command of the same name.
- TUI-only commands that omp does not expose over RPC are still reported as
  plain text with a warning; they are not simulated.

## 2. Goals

- `/goal <objective>` creates a real omp goal, with pause/resume/drop and live
  token/time/status state.
- No `sessionStorage` goal state and no fake "Goal active" banner.
- Refresh, a new tab, or a session switch shows the same goal state omp reports.
- All command sources are discoverable, including extension-registered and
  skill commands.
- The composer never expands, hides, or blocks a name that omp's catalog owns.

## 3. Non-goals

- No token-budget UI (`goal` RPC supports `token_budget`, but the UI does not).
- No automatic writes to the user's omp `config.yml`.
- No TUI-only command emulation for commands with no RPC surface.
- No generic `run_command` RPC or embedded PTY terminal.

## 4. Command architecture

### 4.1 Catalog authority

`get_available_commands` (and `available_commands_update`) is authoritative.
Each command carries `name`, `source`, optional `aliases`, `description`,
`input.hint`, and `subcommands`.

omp's RPC prompt path executes:

| Source | Execution |
| --- | --- |
| `builtin` | omp's text-mode builtin handler |
| `extension` | registered extension command handler |
| `custom` | TypeScript/MCP custom command |
| `mcp_prompt` | MCP prompt |
| `file` | markdown slash command |
| `skill` | `/skill:<name>` injection |

omp's own command pipeline handles these before the model request, so omp-web
sends the original command line. The client does not reimplement them.

### 4.2 Client-owned commands

These names have no omp slash equivalent and are dispatched by
`handleBuiltinSlashCommand`:

- `goal` — native `goal` RPC (section 5).
- `btw` — side-question RPC and panel.
- `reload` — reload omp resources, slash commands, and models.
- `name` — `set_session_name`.
- `copy` — copy the last assistant text.

They are listed in `CLIENT_ONLY_COMMAND_NAMES`
(`components/ChatInput-slash-commands.ts`).

### 4.3 Web-only prompt expansions

`lib/web-slash-commands.ts` keeps prompt expansions for names omp does not
provide: `plan`, `fix`, `test`, `explain`, `simplify`, `commit`, `loop`.

Precedence rules:

- If omp reports the same name, the web entry is hidden and the original
  command line is sent to omp.
- If omp does not report it, the expansion is sent through the normal prompt
  pipeline.
- The palette labels these under **Web commands**, separate from
  **omp commands**, **Extensions**, **Prompts**, and **Skills**.

### 4.4 Palette behavior

- All sources are shown; `builtin` is no longer filtered out.
- `input.hint` becomes the argument hint.
- Client-owned names are dropped from the external list so each command appears
  once.
- Web prompt expansions are dropped when `ompCommandNames` contains the name.
- While a run is streaming, client-owned commands are hidden from the palette
  but still work when typed; the streaming path intercepts them before the
  prompt queue.

### 4.5 Streaming behavior

`ChatInput.sendQueued` handles commands in this order:

1. `/btw` — side question, never a prompt.
2. Client-owned command — `runBuiltinCommand` immediately, never queued.
3. Web-only expansion — expand and queue with `prompt` +
   `streamingBehavior`.
4. omp command — queue the original command line; omp executes it on delivery
   (extension commands run immediately; builtins/custom/file/skill follow
   omp's streaming rules).

This is what makes `/goal` work during a run: the goal RPC is sent while the
current turn continues, and omp decides continuation at the next terminal
`agent_end`.

## 5. Native goal mode

### 5.1 RPC surface

omp exposes:

```json
{ "type": "goal", "op": "get" | "create" | "resume" | "pause" | "drop",
  "objective": "optional", "token_budget": 123 }
```

The command answers `{ goal: Goal | null, state: GoalModeState | null }`.
`get_state.goal` carries the same state. `goal_updated` reports every change,
including changes made by the agent's `goal` tool.

Shapes:

```json
{
  "id": "…",
  "objective": "…",
  "status": "active",
  "tokensUsed": 0,
  "timeUsedSeconds": 0,
  "createdAt": 1793283016449,
  "updatedAt": 1793283016449
}
```

```json
{ "enabled": true, "mode": "active", "goal": { "…": "Goal or null" } }
```

Notes:

- `get_state.goal` is `GoalModeState | null`.
- The command response is `{ goal, state }`; `drop` may answer
  `state: null` while the event still carries a `dropped` state.
- Unknown statuses are preserved.
- `create` requires `goal.enabled`, a non-empty objective, and no active or
  paused goal. It is refused in plan mode.
- RPC does not auto-continue goals unless `goal.continuationModes` contains
  `"rpc"`. That is a user configuration choice, not an omp-web bug.

### 5.2 Types and parsing

`lib/pi-types.ts` defines `GoalStatus`, `Goal`, `GoalModeState`, and
`GoalCommandResponse`, and adds `goal?: GoalModeState | null` to
`RpcSessionState` and `WebSessionState`.

`lib/goal-state.ts` provides defensive readers:

- `readGoalModeState`
- `readGoalUpdatedEvent`
- `readGoalCommandResponse`
- `hasGoal`
- `isGoalControllable`
- `goalElapsedSeconds`
- `formatGoalDuration`
- `isStaleGoalState`

A present-but-malformed goal is rejected rather than treated as "no goal".

### 5.3 Server plumbing

`lib/rpc-manager.ts`:

- Adds `"goal"` to `PASSTHROUGH_COMMANDS`.
- Maps `state.goal` into `WebSessionState` when omp reports it.
- Forwards `goal_updated` through the existing default event path.

`hooks/useAgentSession-stream.ts` adds `goal` to `AgentStateResponse`.

### 5.4 Client state and race handling

`hooks/useAgentSession.ts` owns `goalState` and a monotonic `goalSeqRef`:

- `publishGoalState` increments the sequence and applies an event/response.
- `applyGoalSnapshot` applies a `get_state` snapshot only if no newer event or
  response arrived while it was in flight.
- `isStaleGoalState` prevents a slower response with an older `updatedAt` from
  overwriting a newer goal.
- `loadSession`, `refreshAgentSnapshots`, and `reconcileAgentState` all feed the
  goal snapshot.
- `goal_updated` publishes the event state.

Session switching:

- A genuine switch clears the goal immediately and waits for the new session's
  `get_state`.
- Promoting an empty new chat to its real session id is not a switch; the guard
  `session.id === sessionIdRef.current` keeps the goal that was just created.

### 5.5 UI

`components/ChatInput-banners.tsx` renders the real state:

- Status label: active, paused, completed, dropped, or the raw unknown status.
- Objective, `tokensUsed`, and `timeUsedSeconds`.
- A live timer extrapolates from `updatedAt` only while active; omp remains the
  source of truth.
- Active: **Pause** and **Drop**.
- Paused: **Resume** and **Drop**.
- Completed/dropped: no actions; the banner disappears when omp sends `null`.
- Buttons disable while an action is in flight.

`ChatWindow` passes `goalState` and `handleGoalAction` into `ChatInput`.

### 5.6 Commands

`/goal <objective>`:

- Requires a non-empty objective.
- Sends `{ type: "goal", op: "create", objective }`.
- Never sends a prompt and never inserts the old
  "Work toward this goal…" message.
- Promotes a new chat to the real session id after success.
- Shows omp's error and keeps the existing goal when create fails.

`handleGoalAction("pause" | "resume" | "drop")` sends the matching RPC and
publishes the response state.

## 6. Native `/compact` and `/session`

- `/compact` is now omp's builtin, so `soft`, `remote`, `snapcompact`, and focus
  text work. `manual_compaction_start` / `manual_compaction_end` update
  `isCompacting`, `compactResult`, and `compactError`, then reload the session.
  The composer/top-bar compact button still uses the `compact` RPC.
- `/session` is now omp's builtin (`info`, `delete`, `pin`). The web stats panel
  is still available from the context ring; the old `/session` panel shortcut
  and its `onSessionStatsPanelOpen` plumbing were removed.

## 7. `/review` and `/advisor`

Both were removed from the web expansion list. omp's `review` (custom or
builtin) and `advisor` builtin are shown in the catalog and executed by omp.
The composer's per-chat advisor toggle remains a web spawn flag; it is
independent of the native `/advisor` command.

## 8. Skills and extension commands

- `skill` commands appear when omp reports them (`/skill:<name>`).
- Typed `/skill:<name>` is forwarded through `prompt`; omp injects the skill
  body and runs the turn.
- Extension and custom commands are shown with their source group and executed
  by omp.
- `slashCommandRosterNames` includes aliases, so `/models` (alias of `/model`)
  is recognized.
- `/reload` re-reads the catalog; a newly installed skill appears in the
  **Skills** group after reload.

## 9. `/plan` and `/loop` limitation

omp has native `/plan` and `/loop`, but both are **TUI-only**.

### 9.1 `/plan`

```ts
// packages/coding-agent/src/slash-commands/builtin-modes.ts
{
  name: "plan",
  description: "Toggle plan mode (agent plans before executing)",
  allowArgs: true,
  handleTui: async (command, runtime) => {
    await runWithDetachedDraft(command, runtime, () =>
      runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
    );
  },
}
```

```ts
// packages/coding-agent/src/slash-commands/acp-builtins.ts
export const ACP_BUILTIN_SLASH_COMMANDS = BUILTIN_SLASH_COMMANDS_INTERNAL
  .filter(command => command.handle !== undefined);
```

Consequences:

- `/plan` is absent from `get_available_commands`.
- `executeAcpBuiltinSlashCommand` returns `false` for a TUI-only entry, so a
  `/plan` prompt is delivered as literal text.
- `AgentSession` has `getPlanModeState()` / `setPlanModeState()`, but RPC does
  not expose them: `get_state` has no plan field and there is no `set_mode`,
  `plan`, or `run_command` RPC.
- Hooks cannot call it: hook `ctx` exposes a read-only `sessionManager`, not
  the `AgentSession`.
- Extension `ctx.sessionModes` is `undefined` in RPC/ACP; it is TUI-only.
- Monkey-patching `AgentSession.prototype` from an in-process extension is
  technically possible but unsupported, version-fragile, and would have to
  reimplement the TUI plan-mode transition (plan model switch, tool
  restrictions, plan file, context injection). It is not shipped.

### 9.2 `/loop`

`/loop` has the same shape, with an even smaller surface:

```ts
// packages/coding-agent/src/slash-commands/builtin-modes.ts
{
  name: "loop",
  allowArgs: true,
  handleTui: async (command, runtime) => {
    const prompt = await runtime.ctx.handleLoopCommand(command.args);
    clearSubmittedText(runtime);
    if (prompt) return { prompt };
  },
}
```

- The loop state (`loopModeEnabled`, `loopModePaused`, `loopPrompt`,
  `loopLimit`, `loopCondition`) lives in `InteractiveModeContext`, not in
  `AgentSession`. There is no session-level API to call and no `set_loop`
  RPC.
- `ctx.sessionModes` can drive loop in the TUI, but it is `undefined` in
  RPC/ACP.
- The web `/loop` entry is a prompt expansion that asks the model to retry up
  to N attempts. It is **not** omp's loop mode: it does not resubmit after
  each yield, has no pause/resume, no count/duration bound enforcement, and no
  `--while` / `--until` condition.
- A client-side loop that resends after `agent_end` would be emulation, not
  native support, and would have to reimplement bounds, conditions, pause,
  and interruption semantics. It is out of scope.

### 9.3 Shared limitation and upstream path

omp-web therefore keeps `/plan` and `/loop` as clearly labeled **Web commands**
prompt expansions. If omp adds a text-mode `handle` or a `set_mode` RPC,
omp-web automatically defers to it:

- The palette hides a web entry when `ompCommandNames` contains the same name.
- `handleBuiltinSlashCommand` returns `{ handled: false }` when the roster owns
  the name, so the original command line reaches omp.

## 10. Persistence and known limits

- A goal is journaled by omp in the session. Reload restores it from
  `get_state.goal` once the session has a `.jsonl` file.
- omp writes a session file lazily on the first message. A goal created on an
  empty new chat and followed by an immediate full reload has no file to list,
  so the session cannot be reopened until a message is sent. This is omp's
  persistence behavior, not a web state source.
- Goal continuation over RPC requires `goal.continuationModes` to include
  `"rpc"`; the default does not.
- TUI-only commands (`guided-goal`, `vibe`, `budget`, and `/plan`/`/loop` when
  absent from the catalog) are sent as plain text with a one-time warning.
- A malformed or unsupported `goal` RPC (older omp) surfaces omp's error; there
  is no fallback to the old fake goal.

## 11. Implementation map

- `lib/goal-state.ts` — defensive goal readers and formatting.
- `lib/pi-types.ts` — goal types and state fields.
- `lib/rpc-manager.ts` — `goal` passthrough and `get_state.goal` mapping.
- `hooks/useAgentSession-stream.ts` — `AgentStateResponse.goal`, catalog
  mapping, roster aliases.
- `hooks/useAgentSession.ts` — goal state sequencing, `/goal`, goal actions,
  command precedence, manual compaction events.
- `components/ChatInput.tsx` — catalog precedence, client-only commands,
  streaming interception, goal props.
- `components/ChatInput-slash-commands.ts` — client-owned command sets and
  palette defs.
- `components/ChatInput-banners.tsx` — real goal banner and controls.
- `components/ChatWindow.tsx` — goal plumbing.
- `lib/web-slash-commands.ts` — web-only expansions; `goal`, `review`, and
  `advisor` removed.
- `lib/web-mode-state.ts` — `ActivePlan` only.
- `lib/i18n/locales/{en,zh-CN,ja}.json` — goal status/control copy and group
  labels.
- `lib/goal-state.test.mjs`, `components/ChatInput-banners.test.mjs`,
  `hooks/useAgentSession.rpc.test.mjs` — goal lifecycle, parsing, streaming,
  persistence, and command routing.

## 12. Verification

- `tsc --noEmit` passes.
- `eslint .` reports 0 errors (existing warnings only).
- Full test suite: 1701 passed, 17 skipped. One environment-only failure in
  `lib/project-registry.test.mjs` was caused by a broken `node` shim on the
  test machine; re-running that file with a correct `PATH` passes 15/15.
- Headed-browser smoke test against a live omp child:
  - `/goal ship the export feature` sent only
    `{"type":"goal","op":"create","objective":"ship the export feature"}` and
    showed an active goal banner.
  - Pause, resume, and drop sent only the matching `goal` op; the banner
    tracked each state.
  - A goal created while the agent was streaming sent the goal RPC and did not
    queue a `/goal` prompt.
  - A page reload restored the active/paused goal from `get_state.goal`.
  - `/session` and `/tools` produced omp's `command_output`; `/skill:<name>`
    injected the skill and returned the skill's answer.
  - After `/reload`, the palette showed Web commands, Extensions, Prompts,
    Skills, and 46 omp commands.

## 13. Upstream follow-ups

To make `/plan`, `/vibe`, and `/loop` truly available over RPC, omp needs one
of:

1. A text-mode `handle` on the builtin spec (the `SlashCommandRuntime` already
   exposes the `AgentSession`), or
2. An RPC `set_mode` / `sessionModes` surface, or
3. A generic `run_command` RPC.

Until then, the only full-parity option is embedding a PTY running the real
omp TUI.

## 14. References

- omp RPC docs: `goal` payload, `goal_updated`, available commands.
- omp source:
  - `packages/coding-agent/src/slash-commands/builtin-modes.ts`
  - `packages/coding-agent/src/slash-commands/acp-builtins.ts`
  - `packages/coding-agent/src/session/agent-session.ts`
  - `packages/coding-agent/src/extensibility/extensions/types.ts`
  - `packages/coding-agent/src/extensibility/extensions/runner.ts`
- omp-web docs: `AGENTS.md` (Slash commands), `CHANGELOG.md`.
