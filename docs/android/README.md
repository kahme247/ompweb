# ompweb for Android

The native Android app for [ompweb](https://github.com/kahme247/ompweb): a full
client for the web UI's feature set, written in Kotlin and Jetpack Compose. It
connects to the ompweb server running on your own computer (or on any machine
you can reach) and gives you the same workspace on a phone, foldable or tablet:
sessions (pin the ones you use most to the top of the list), the live chat, the
composer with slash commands and dictation, files, Git and worktrees,
notifications with inline replies, and all settings.

The `applicationId` is `io.github.kahme247.ompweb`. The app is distributed as an
APK on GitHub Releases; there is no Play Store listing. The newest release
there names the current version, its `versionCode`, the APK and its SHA-256.

---

## Requirements

- **ompweb on the server**, new enough to serve `GET /api/app-info` with
  `"api": 1` — the server build that accompanies this app (0.6.0 with our
  additions). **Stock ompweb 0.6.0 from npm and 0.5.2 do not have this
  endpoint**; such a server answers the password screen but cannot serve the
  native app, and the app says **Server too old** with the update command.
- **omp** installed on the server (`omp` on `PATH`, or `OMP_WEB_OMP_BIN`) for
  everything that starts an agent. Browsing and reading existing sessions
  works without it.
- **Android 8.0 (API 26) or newer.**
- A network path from the phone to the server. **Tailscale is recommended**,
  because it works from anywhere and encrypts the traffic before it leaves the
  device. A LAN address (`192.168.…`) works only at home.

Plain HTTP is accepted only for addresses that resolve into your own private
network (loopback, RFC 1918, `100.64.0.0/10` for Tailscale, link-local,
`.local`, `*.ts.net`, or a single-label host name). For any other host use
`https://`.

## Install the APK

1. Open the release page:
   <https://github.com/kahme247/ompweb/releases> and pick the newest
   `android-v*` release.
2. Download `ompweb-<version>.apk` and, to verify it, its companion
   `ompweb-<version>.apk.sha256`.
3. Open the file on the phone. Android asks once whether the app that opens it
   (Files, Chrome, …) may install unknown apps: allow it.
4. Confirm the install. Signed updates install over the previous version; the
   app data (server address, theme, drafts) stays.

The app is signed with the project's own release key. See
[Verify the download](#verify-the-download) before installing an APK you did
not build yourself.

## First connection

1. **On the PC**, open ompweb → **Settings → System & Updates → Mobile app**.
   The card shows whether the server listens on the network, whether a password
   is set, and the exact addresses you can type into the phone. If it reports
   `127.0.0.1` only, use the copyable command for the way you start ompweb
   (CLI, Windows tray, systemd or launchd) to expose it.
2. **On the phone**, connect Tailscale (or join the same Wi-Fi network).
3. Open **ompweb** and enter the address, for example `100.64.0.10`,
   `my-pc.tailnet.ts.net`, or `192.168.…:30177`. Without a port, `30177`
   is used. A copied trailing `/` is fine.
4. Tap **Connect**. The app checks that something ompweb-like answers and that
   `/api/app-info` is new enough, then asks for the web password. The password is
   never stored; the session cookie is stored encrypted (see
   [Privacy and security](#privacy-and-security)).

The app remembers the address and the theme. **Sign out** forgets the cookie
and returns to the password screen; **Change server** forgets the address too.

## Notifications

ompweb keeps one connection to the server while the app is open, so it can
notify you when an agent finishes, waits for an answer, fails, or switches
model. The first start asks for the notification permission.

For reliable delivery:

- Allow notifications for ompweb.
- Allow ompweb to run without battery restrictions. **Settings → Notifications**
  shows **Battery optimization** and offers **Fix** when Android restricts the
  app. On many phones the same switch is under *Settings → Apps → ompweb →
  Battery → Unrestricted*.
- A **connection status** notification stays visible while the app is connected.
  It is a foreground service notification, not a message.
- Notifications offer **answer buttons** for confirm/select dialogs and a reply
  field for questions and completed runs. Answering from the notification does
  not require opening the app.
- **Settings → Notifications** controls which event types notify this device,
  keeps the history, and has **Send test notification**.
- **Vibrate** (on by default) makes a finished task pulse once, a waiting agent
  pulse twice, and an error pulse once for long. Sending or answering never
  vibrates. Silent mode and Do Not Disturb still win.
- Notifications of sessions from the same project are grouped under one
  summary such as *3 sessions in ompwebandroid*.

## Updating the app

The app updates itself from **Settings → System & Updates → Android app
update**, and offers the update in a banner on the main screen. It checks its
source when the main screen opens after signing in and every six hours;
**Check for updates** forces a request. **Dismiss** hides the banner for that
version; a newer release shows again.

An install is verified before Android sees the file:

1. The APK is downloaded into the app cache (at most 200 MiB) with progress and
   a working **Cancel**. A canceled or failed download is deleted.
2. Its SHA-256 must match the digest the source announced.
3. Its package name must be `io.github.kahme247.ompweb`, its `versionCode` must
   match the announcement and be strictly higher than the installed one.
4. Its signing certificate must be identical to the installed app's (SHA-256 of
   the certificate, read with `GET_SIGNING_CERTIFICATES`). An APK signed with a
   different key is refused.
5. Only then does a `PackageInstaller` session start. The first install asks for
   the Android *install unknown apps* permission; **Open settings** takes you
   there.

Your data (server address, theme, drafts, notification settings) stays. A
successful self-update replaces the running process; open the app again to see
the new version.

### Update sources

- **GitHub Releases** (default). The newest `android-v*` release; the app uses
  `ompweb-<version>.apk` and `ompweb-<version>.apk.sha256` from its assets. The
  check is a plain unauthenticated request to `api.github.com`; no server
  address, password or session data is sent.
- **Custom feed URL.** For a self-hosted or internal build. The app fetches the
  URL and expects JSON:

  ```json
  {
    "versionName": "1.0.1",
    "versionCode": 10001,
    "apkUrl": "https://downloads.example.com/ompweb/ompweb-1.0.1.apk",
    "sha256": "228c4c1aa12056ed31ab59d7b318b7d12da9466dc145fc0befad27d7116ac982",
    "size": 5610321,
    "notes": "Optional; shown in the settings card."
  }
  ```

  `apkUrl` may be absolute or relative to the feed URL. `sha256` is 64 hex
  characters (upper or lower case), `size` the exact byte count (at most
  200 MiB), `versionCode` a positive integer that Android compares with the
  installed one. Plain HTTP is accepted for the same private-network hosts as
  the server address (loopback, RFC 1918, `100.64.0.0/10`, link-local, `.local`,
  `*.ts.net`); use `https://` everywhere else. The answer is cached for six
  hours and survives being offline; switching the source drops the old answer.

## Verify the download

Every release publishes the SHA-256 of the APK as
`ompweb-<version>.apk.sha256` and the signing certificate fingerprint. Compare
them before installing:

```sh
# V is the version of the release you downloaded (the android-v* tag without
# its "android-v" prefix)
V=<version>

# With the published checksum file (Linux / macOS; both files in one folder)
sha256sum -c ompweb-$V.apk.sha256

# Or compute and compare manually
sha256sum ompweb-$V.apk
shasum -a 256 ompweb-$V.apk        # macOS alternative

# Windows PowerShell
Get-FileHash .\ompweb-$V.apk -Algorithm SHA256
```

- **Signing certificate SHA-256:**
  `d73354b52dc7c3f0c74623c439ddb7b52e252811c6e6b5f851c9d04b7015fc87`
- **Signing certificate SHA-1:** `06d9d698c6a43f643a27643618fd4f7d431d26d4`
- **Signer:** `CN=ompweb, OU=Android, O=ompweb, C=DE` (APK Signature Scheme v2)

With Android SDK build-tools installed:

```sh
apksigner verify --print-certs ompweb-<version>.apk
```

An APK whose certificate differs was not built by this project: do not install
it.

## Troubleshooting

The app names the cause instead of showing a generic error. The messages and
their usual fix:

| Message | Meaning and fix |
|---|---|
| **Cannot reach the server** | Tailscale is disconnected, the phone is on another network, the server listens on `127.0.0.1` only, or the port is wrong. Check the address shown in **Settings → Mobile app**. |
| **Request blocked** | A proxy (for example Cloudflare Access or a reverse proxy with WAF rules) refused the native client. Allow it, or bypass the proxy on the tailnet. |
| **Not an ompweb server** | Something answered at that address, but it is not ompweb. Check the address and the port. |
| **Secure connection failed** | The certificate does not match the host, or plain HTTP was used for a public address. Use the exact certificate name or `https://`. |
| **Server misconfigured** | ompweb runs, but the password hash is invalid. On the PC set a valid `OMP_WEB_PASSWORD_HASH` and restart. |
| **Incorrect password** | The web password does not match. It is the same password the browser uses. |
| **Server too old** | The server lacks `/api/app-info` (API 1). On the PC run `npm install -g @kahme247/ompweb@latest`, restart ompweb, then **Check again**. |
| **Reconnecting to the server… / Not connected** | The event stream dropped (sleep, network change, server restart). It reconnects automatically; **Retry** forces it. |
| Notifications arrive late | Battery optimization is restricting the app. See [Notifications](#notifications). |
| The app cannot open an old session | Only sessions that the server can still read appear. An empty new session is shown as empty; a deleted one is an error. |

Diagnostics for a connection problem: the app itself never logs the password,
the cookie or the session content. On the PC, ompweb's own diagnostics live in
`<agent dir>/omp-web/diagnostics.log`; on the phone, a bug report shows the
app's logcat.

## Privacy and security

- **The password is never stored or logged.** Only the session cookie is kept,
  encrypted with an AES-256-GCM key in the Android Keystore
  (`filesDir/session-cookies.bin`).
- **The cookie belongs to one origin.** It is sent only to the exact scheme,
  host and port that set it, so changing servers cannot leak it to the new one.
- **No cloud backup.** `allowBackup="false"` and the backup/data-extraction rules
  exclude app data from Google backup and device transfer.
- **No telemetry.** The app talks to your ompweb server, and for updates to the
  source you selected (`api.github.com` or your custom feed), and downloads the
  APK from that source. No analytics, crash reporting or third-party SDK is
  included.
- **Origin headers are never sent.** The app sends no `Origin`/`Sec-Fetch-Site`
  headers, so ompweb's origin gate cannot be tripped by the client.
- **Links** open in a Custom Tab and only for `http(s)`/`mailto`. Clipboard reads
  requested by an agent are default-deny and need an in-app consent per chat.
- **Signing key.** The release key is not in the repository. Release builds are
  signed only when `OMPWEB_SIGNING_PROPERTIES` points at a properties file
  outside the checkout; CI uses repository secrets.

## Known limits

- **Install confirmation.** The app asks Android to install a verified
  self-update without a second dialog (`USER_ACTION_NOT_REQUIRED`, Android 12+).
  Where Android does not grant that, its own confirmation appears. The first
  install needs the *install unknown apps* permission.
- **Foreground-only connection.** The event stream stops shortly after the app
  goes to the background (battery), so notifications depend on the foreground
  service staying alive. If the system kills it, delivery resumes when the app
  or the service restarts.
- **No FCM.** Notifications do not come from Google; they come from your own
  server connection.
- **English UI only.**
- **Plain HTTP only inside private networks.** A public host needs `https://`.
- **Old omp runtimes** lack some features (`get_skill_diagnostics`, queue
  editing, `promote_queued_message`); the app reports the server/omp response
  instead of failing silently.

## Building from source

The app lives in [`android/`](../../android). With JDK 21 and the Android SDK:

```sh
cd android
./gradlew assembleDebug        # debug APK, applicationId …ompweb.debug
./gradlew testDebugUnitTest    # JVM tests and screenshot goldens
./gradlew lintDebug
OMPWEB_SIGNING_PROPERTIES=/path/to/signing.properties ./gradlew assembleRelease
```

Never commit `signing.properties` or the keystore. See the repository's
`AGENTS.md` (Android app) for the signing and CI rules.

### Releasing

Pushing an `android-v<version>` tag runs
[`android-release.yml`](../../.github/workflows/android-release.yml). Before
tagging:

- Set `versionName` in [`android/app/build.gradle.kts`](../../android/app/build.gradle.kts)
  to exactly `<version>`. The workflow compares the tag with
  `aapt2 dump badging` and fails instead of publishing a mislabelled APK
  (which would make the in-app updater offer the same release forever).
- Add `docs/android/RELEASE_NOTES_<version>.md`. A missing file fails the
  build; the workflow never publishes another version's notes.
- The READMEs carry no version, APK file name, size or checksum: the version,
  the assets and their digests live in the release body that the workflow
  builds from the release notes. A release therefore needs no README edit —
  keep it that way (the stable signing-certificate fingerprint above is the
  one deliberate exception).
- Repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- The `android-release` environment (Settings → Environments) must exist with
  **required reviewers**. Both the signing job and the publishing job use it,
  so a stray tag cannot sign or publish an APK without approval. Add a tag
  ruleset that restricts who may create `android-v*` tags.
- Actions are pinned to commit SHAs (like `publish.yml`). When bumping one,
  pin the new commit, not the moving tag.
- The decoded key exists only in `$RUNNER_TEMP/ompweb-signing`; an
  `if: always()` step deletes it, and the publishing job only receives the
  staged APK, checksum and notes.
- The release body appends the asset name, size, SHA-256 and certificate
  SHA-256 — unless the notes already carry the built APK's SHA-256, so the
  verification block appears once; notes naming a different SHA-256 fail the
  build. The workflow also refuses an APK signed by an unexpected certificate.

## More documentation

- [`protocol.md`](protocol.md) — the RPC/frame contract the chat implements.
- Release notes live next to this file as `RELEASE_NOTES_<version>.md` (and in
  the GitHub release body of the matching `android-v<version>` tag). This page
  names no version, so it needs no edit per release.
