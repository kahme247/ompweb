# Composer file uploads over the links — design

Date: 2026-11-02. Branch: `feat/file-uploads` (on `main` b4e849b4).
Builds on: `docs/specs/2026-11-01-browser-link-design.md` (B2–B5), `docs/specs/2026-10-31-websocket-link-design.md` (D3, D6, D7), `docs/specs/2026-10-28-remote-hosts-design.md` ("Protocol versions and compatibility").

## Why

The composer refuses every file that is neither an image nor text (a `.zip` cannot be attached at all), and images are capped at 5 MB per message. Neither limit comes from omp: omp's RPC stdin has no inbound cap, and omp resizes prompt images itself. The caps are omp-web's own JSON body budget (8 MiB, base64 inline). Files of any type and size up to 2 GiB should reach the agent as files it can read, on the machine where the session's omp runs.

## Decisions

### U1. What the agent gets

- An attached file is written into the session's `local://` root on the session's host: `<sessions>/<project>/<session file minus .jsonl>/local/uploads/<name>`. This is omp's `resolveLocalRoot`; on Windows, a root of 180 characters or more becomes `<tmp>/omp-local/<session id>`, as in omp. A taken name gets ` (1)`, ` (2)`, … before the extension. Names are reduced to one safe path segment of at most 120 characters.
- When the prompt is sent, the server appends one block to the message:
  ```
  Attached files (this session's local:// directory):
  - local://uploads/data.zip (/home/u/.omp/agent/sessions/…/local/uploads/data.zip, 12.3 MB, application/zip)
  ```
  The `local://` URL is for omp's tools; the absolute path is for shell commands.
- Limits: 2 GiB per file, 20 files per message.

### U2. What the composer does

- **Images:** each image chip gets an **Inline / As file** switch, Inline by default. Inline is today's path: base64 in the prompt, which omp resizes for the model. As file is the U1 path and keeps the exact bytes. An image that does not fit the inline budget (5 MB per message) is switched to As file automatically, with a notice.
- **Text files** are still inlined while they fit the text budget (4 MB); past it they go As file instead of being refused.
- **Everything else** (archives, PDFs, binaries) goes As file. The "files skipped" refusals are gone, except for the 2 GiB and 20-file limits.
- Uploading starts on attach. A chip shows progress, then done, or an error with retry. Removing a chip aborts its upload. **Send** waits until every attached upload is done (the button shows the pending count).
- A draft keeps finished uploads (id, name, size, host); an upload still in flight is lost on reload and must be attached again.
- The target host is the open session's host, or for a new chat the host selected on the new-session screen.

### U3. Staging on the host, attach on send

Uploads go to a staging directory on the target host's daemon, `<agent dir>/omp-web/uploads/<id>.part` plus `<id>.json` (name, size, type, created). They are not written straight into a session because a new chat has no session yet when the file is attached.

1. On send, the prompt command (`prompt`, `steer`, `follow_up`; WebSocket `cmd` or HTTP route alike, so in `runAgentCommand`) carries `uploads: [id, …]`.
2. The server strips the field and calls the host op `uploadAttach {id, sessionFile, sessionId}` for each id. The daemon moves the staged file into the session's `local/uploads/` (a rename, with copy + unlink on `EXDEV`) and returns `{path, url}`.
3. The server then appends the U1 block to `message` and sends the command to omp.

A failed attach fails the command: 404 `upload_missing`, or 409 `upload_incomplete`. Nothing goes to omp, and the composer keeps the draft. The daemon deletes staged files older than 24 h, at start and on every `uploadStart`.

### U4. Browser → server (browser link)

The upload id is a client-generated UUID. It doubles as the binary frame id on both links, so the server forwards each chunk without re-encoding it.

| Message | Dir | Seq | Key | Meaning |
|---|---|---|---|---|
| `up_start {id, host, name, size, type}` | ↑ | yes | `up:<id>` | open, or resume, an upload on `host` |
| binary `[n][id][payload]` | ↑ | no | `up:<id>` | the next ≤ `pieceBytes` (256 KiB) of the file, in order |
| `up_abort {id}` | ↑ | yes | `up:<id>` | cancel and delete the staged file |
| `up_ack {id, received, done}` | ↓ | yes | `up:<id>` | the host has written `received` bytes; `done` once all `size` bytes are written and synced |
| `up_error {id, status, code, message}` | ↓ | yes | `up:<id>` | the upload failed (host offline, disk full, too large, old host) |

- Binary frames are units of the worker's `LinkSender` (it already carries `{id, blob}` items) under key `up:<id>`. A session's commands and replies therefore take turns with upload chunks and never wait behind a whole file.
- **Flow control is end to end.** The worker keeps at most `UPLOAD_WINDOW` = 2 MiB per upload sent beyond the last `up_ack.received`. The server holds no more than that per upload and writes nothing to its own disk.
- **Resume:** binary frames are not sequenced and are lost when the socket drops. After a resume or resync the worker sends `up_start` again with the same id; the host answers with its `received` offset, and the worker continues from there.
- The tab hands the worker `Blob` slices (`File.slice`, read in the worker) rather than buffers, so the tab holds no file bytes.
- `lib/browser-link.ts` accepts binary frames only for an upload this link started, and only up to `pieceBytes` plus the header. Any other binary frame still closes with 1007. `BROWSER_LINK_VERSION` stays 1: the worker is served by the same server (content-hashed URL), and an old worker never sends the new types.

**SSE mode (and the WebSocket fallback)** uses HTTP with the same semantics:
- `POST /api/uploads {id, host, name, size, type}` corresponds to `up_start` and answers `{received}`.
- `PUT /api/uploads/<id>?offset=N` carries a body of up to 1 MiB. The server cuts it into ≤ 256 KiB frames, forwards them, and answers once the host has acked through `N + length`, which is the HTTP form of the window.
- `DELETE /api/uploads/<id>` corresponds to `up_abort`.

### U5. Server → host (host link v6)

- **Ops:**
  - `uploadStart {id, name, size, type}` creates the staging file, or opens an existing one, and returns `{received}`.
  - `uploadAbort {id}` deletes the staging file.
  - `uploadAttach` is described in U3.
- **Down:** binary frames `[n][id][payload]`, the format the daemon already sends up for large results, sent by the hub as `{id, blob}` units of its `LinkSender` under key `up:<id>`. The hub's `flush` learns blob units: a blob unit is sent with the same Bun `send` → `-1` → `drain` handling and is not counted in the line window. The browser's window (U4) bounds it.
- **Up:** `upload_ack {seq, id, received, done}`, a sequenced line. The daemon queues one after each write, coalesced to at most one per `flushMs` per upload, plus a final one with `done`. The hub relays it to the browser link (or the HTTP waiter) that owns the upload.
- **Daemon writes** at the staged file's current length. A frame for an unknown or finished upload is dropped, and the next `uploadStart` reports the real offset. Bytes beyond `size` fail the upload.
- **Version:**
  - `LINK_PROTOCOL_VERSION` goes to 6 (new down frames, new up type, new ops). `MIN_LINK_PROTOCOL_VERSION` stays 4.
  - Main uploads only to links with `hostVersion >= 6`. For any other link it answers `up_error` 426 `host_upgrade_required` ("Update ompweb on <host> to attach files").
  - A v5 main closes a v6 daemon with 4426, so the web app is upgraded first, as for every link version (remote-hosts spec, "Protocol versions and compatibility").
- **Daemon errors:** `upload_ack` may carry `error {status, code, message}` (bytes beyond `size`, 507 `upload_write_failed` on a full disk); the hub turns it into `up_error`.
- **Attach** uses a hard link plus unlink (never overwrites an existing name), falling back to an exclusive copy on `EXDEV`/`EPERM`/`ENOTSUP`/`ENOSYS`. Upload ids stay registered until the prompt reaches omp, so a retried send reuses the earlier attach.
- **Registry on main** (in memory): id → `{hostId, owner, size, received, browser link or HTTP waiter}`.
  - The owner is the browser link's owner (B5); for HTTP it is the same cookie-derived owner.
  - `uploadAttach` requires the same owner and the session's host.
  - A main restart forgets the registry. A finished staged upload then cannot be attached ("attach the file again"); an unfinished one resumes through `up_start`, which re-registers it.

## Limitations

- The upload rate is bounded by `UPLOAD_WINDOW / RTT`: about 40 MB/s at 50 ms and 10 MB/s at 200 ms.
- Upload chunks share the host link with session traffic. A Stop can wait for up to one window per active upload to drain on a slow link.
- In-flight uploads do not survive a page reload, and finished ones do not survive a main restart (U2, U5).
- Images sent inline are still resized by omp. Only As file keeps the original bytes.

## Acceptance

1. `npm run typecheck && npm run lint && npm test` and `npm run build` pass.
2. Tests:
   - A chunked upload over a slow browser link does not delay a command reply on the same link by more than a window.
   - A socket dropped mid-upload resumes from the host's offset, and the file matches its SHA-256.
   - An upload to a v5 daemon fails with 426.
   - `uploadAttach` with another owner's id fails with 404.
   - A taken name gets ` (1)`.
   - A path-traversal name stays inside `uploads/`.
   - Bytes beyond `size` fail the upload.
   - The SSE-mode HTTP path produces the same file.
3. Real smoke (headless Chromium, real omp, local daemon): attach a 300 MB `.zip` and a 12 MB PNG set to As file and send; the agent lists both with `ls` on the absolute path, and the SHA-256 matches. Repeat in SSE mode.
