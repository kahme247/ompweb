# ompweb for Android 1.0.17

The native Android client for ompweb: sessions, the live chat, the composer,
files, Git and worktrees, notifications with inline replies, and the settings
screens, backed by your own ompweb server.

## What changed

- **"Running" now means a run, not a child** — the app reads the server's two
  separate answers: `running` says a turn is in flight, `alive` says the omp
  process for the session exists. Opening a session whose omp child is idle
  (or still loading a large transcript) paints an idle chat instead of
  "working", and keeps the transcript from disk on screen.
- **An idle child behind a slow 503 settles instead of spinning** — when
  `GET /api/agent/{id}` answers `503 session_slow` and the body reports
  `running: false` (omp is alive, its event loop is blocked by a large session,
  but no turn is running), the chat settles silently. No error notice, no
  "working" that would outlive the run by hours.
- **Ownership follows the child, not the run** — the "another omp process owns
  this session" banner is shown only when the session reports that no child
  answers here (`alive: false`) and no local run is proven. An idle wrapper that
  merely loads a big session therefore does not block sending.
- **The unknown window is bounded by polls, not by trigger bursts** — a server
  that does not report the run state in its 503 leaves the client guessing.
  The app keeps the run marked, and after three consecutive reconcile polls it
  asks `/api/sessions` — the server's own run registry. Only a readable list
  that does not name the session ends the run; an unreadable list keeps it
  marked, because it proves nothing. Only the 15-second reconcile loop counts:
  the reads that opening a chat fires (the open itself, the connection becoming
  live, the first history page) are not polls, and neither is the one-shot
  settlement read after a send — the window measures the polling cadence, not
  how many triggers happened to fire.
- **Tests** — `openingASlowSessionKeepsTheTranscriptAndShowsItRunning`,
  `aSlowAnswerThatReportsNoRunSettlesTheTurn`,
  `aSlowAnswerThatReportsARunKeepsItMarked`,
  `anUnknownSlowAnswerIsBoundedByTheRunningList`,
  `theSlowAnswerBoundKeepsARunTheRunningListStillNames` (view model),
  `anIdleLiveChildBacksSlowWithTheServerValue` (composer controls) and
  `503 session_slow carries the server run state` (`ApiClientTest`, the 503
  body's `running` field) plus the foreign-run tests (`ChatForeignRunTest`)
  cover the run/child split and the bounded window.
- **Version 1.0.17** (`versionCode` 10017).

Older servers keep working: a 503 without the run state falls back to the
bounded window plus the run registry.

## Updating

Open **Settings → System & Updates → Android app update**, keep or set the
source, and tap **Check for updates**; the app downloads the file, verifies its
SHA-256, package name, `versionCode` and signing certificate, and hands it to
Android's installer. The app data stays. Android still asks once for the
*install unknown apps* permission if it was never granted.

## Requirements

- ompweb with `GET /api/app-info` (`"api": 1`) — the server the app was built
  against.
- The `running`/`alive` fields on `GET /api/agent/{id}` and
  `GET /api/sessions/{id}/state` (fallback for older servers included).
- omp installed on the server for agent features.
- Android 8.0 (API 26) or newer.

## Release artifact

- `ompweb-1.0.17.apk`
- `ompweb-1.0.17.apk.sha256` accompanies the file; the release also publishes
  the APK's size and signing certificate.

## Install

1. Download `ompweb-1.0.17.apk` and the companion `ompweb-1.0.17.apk.sha256`
   from the release.
2. Allow your file manager or browser to install unknown apps.
3. Install the APK. Signed updates install over an older version and keep the
   app data.

Full instructions: [`docs/android/README.md`](README.md).
