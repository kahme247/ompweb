# ompweb wire protocol

Stand: 2026-10-20 · Gilt für den Dev-Server `ompweb` 0.5.2, API-Version 1.
Dieses Dokument ist die verbindliche Schnittstellenbeschreibung für den nativen
Android-Client. Jede Aussage ist mit `datei:zeile` gegen den Web-Code belegt;
die Zeilen beziehen sich auf den Arbeitsstand vom Aufnahmetag. Feldnamen sind
exakt so geschrieben, wie sie über die Leitung gehen.

> Der Client darf unbekannte Frame-Typen und unbekannte JSON-Felder ignorieren,
> aber nie als Fehler behandeln. Der Server fügt Frames hinzu (z. B.
> `advisor_yielded` in omp 18.12.4), ohne die API-Version zu erhöhen.

---

## 1. HTTP-Grundlagen

### 1.1 Auth-Gate

Jede Anfrage läuft durch `proxy.ts`:

| Fall | Antwort | Quelle |
|---|---|---|
| `Origin`/`Sec-Fetch-Site` vorhanden und nicht same-origin | `403` `{"error":"Cross-origin API requests are not allowed"}` | `proxy.ts:12-15`, `lib/request-security.ts:16-44` |
| Passwort konfiguriert, aber unbrauchbar (Klartext/abgeschnittener Hash) | `503` `text/plain` mit Reparaturhinweis | `proxy.ts:16-26`, `lib/web-auth.ts:58-91` |
| Kein gültiges Session-Cookie und `/api/*` | `401` `{"error":"Password required","code":"password_required"}` | `proxy.ts:33-43` |
| Kein Cookie, HTML-Route | `302` nach `/login`; ein Session-Deeplink wird als `next` mitgenommen | `proxy.ts:44-47` |
| `/login` mit gültiger Session | `302` nach `/` | `proxy.ts:36-37` |
| `/api/web-auth/session` | immer durchgelassen (Login selbst) | `proxy.ts:39` |

Der Origin-Check greift nur, wenn der Request `Origin` oder `Sec-Fetch-Site`
trägt (`lib/request-security.ts:43-44`); native Clients senden beides nicht.
Der Vergleich normalisiert Schema/Host/Port und toleriert Proxys, die den Port
aus `Origin` entfernen (`lib/request-security.ts:21-39`).

Auth gilt alternativ über einen vertrauenswürdigen Reverse-Proxy-Header
`x-omp-web-auth`, dessen Wert per `OMP_WEB_TRUSTED_HEADER_SHA256` geprüft wird
(`lib/web-auth.ts:7-8,39-55`). Der native Client benutzt ihn nicht.

### 1.2 Login und Cookie

`POST /api/web-auth/session`

```json
{ "password": "…" }
```

| Ergebnis | Status | Body |
|---|---|---|
| Passwortschutz deaktiviert | `404` | `{"error":"Password protection is disabled"}` |
| Body > 8 KiB | `413` | `{"error":"Invalid password request"}` |
| kein JSON | `400` | `{"error":"Invalid password request"}` |
| falsches Passwort | `401` | `{"error":"Incorrect password"}` |
| richtig | `200` | `{"ok":true}` + `Set-Cookie` |

Quelle: `app/api/web-auth/session/route.ts:11-40`.

Cookie `omp_web_session`:

- `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` wenn HTTPS bzw.
  `X-Forwarded-Proto: https`, `Max-Age = 60*60*24*30` (30 Tage)
  (`app/api/web-auth/session/route.ts:30-39`, `lib/web-auth.ts:5-6`).
- Wertformat `v1.<expiresAt>.<nonce>.<HMAC-SHA256>`; der Schlüssel mischt den
  Passwort-Hash mit einem Installationsgeheimnis (`lib/web-auth.ts:104-115`).
- Der Client speichert das Cookie verschlüsselt und sendet es nur an den
  konfigurierten Origin. Passwort wird nie gespeichert.

Ein späteres `401` bedeutet: Cookie abgelaufen/ungültig → zurück zum
Passwort-Screen, Origin behalten.

### 1.3 `GET /api/app-info`

Capability-Handshake, hinter dem normalen Auth-Gate
(`app/api/app-info/route.ts:10-25`):

```json
{
  "name": "ompweb",
  "version": "0.6.0",
  "api": 1,
  "capabilities": {
    "notificationDialogs": true,
    "notificationAnswer": true,
    "notificationDismiss": true,
    "heartbeatParam": true,
    "messageSearch": true
  }
}
```

Ältere Server ohne diese Route liefern `404`; der Client zeigt dann
„Server zu alt“. `api` ist die Vertragsversion, `version` nur Anzeige.
`capabilities.messageSearch` sagt, ob `GET /api/sessions/messages/search`
existiert (§3.6): Fehlt der Schlüssel (älterer Server), bietet der Client den
Modus „Search in messages“ gar nicht erst an; ein `404` der Suchroute wird als
„Server zu alt für die Nachrichtensuche“ erklärt, nie als rohes `HTTP 404`.

`GET /api/sessions/search` ist **nicht** diese Route: Server ab 0.6.0 nutzen
sie für das Sidebar-Ranking und antworten mit NDJSON-Zeilen `{scores}`. Der
Client ruft sie nie auf; die Nachrichtensuche liegt ausschließlich unter
`/api/sessions/messages/search`.

### 1.4 Request-Größen und Fehlercodes

| Endpoint | Grenze | Verhalten |
|---|---|---|
| `POST /api/web-auth/session` | 8 KiB | `413` |
| `POST /api/events` | 16 KiB | `413` `invalid_event_stream_request` |
| `POST /api/agent/[id]` | 8 MiB | `413` `request_too_large` |
| `POST /api/agent/new` | 8 MiB | `413` `request_too_large` |
| `PATCH /api/notifications/history` | 32 KiB | `413` `request_too_large` |
| `POST /api/notifications/answer` | 64 KiB | `413` `request_too_large` |
| `GET /api/sessions/[id]/context` | Session-Datei-Limit | `413` `session_file_too_large` |
| `POST /api/files/[...path]?type=upload` | 25 MiB pro Datei (eine Datei pro Request), 100 MiB pro Auswahl, 26 MiB Proxy-Deckel | `413` `upload_file_too_large` / `upload_total_too_large` |

Quellen: `app/api/events/route.ts:8,28-36`,
`lib/image-attachments.ts:14-15`, `app/api/agent/[id]/route.ts:30-35`,
`app/api/agent/new/route.ts:10-23`,
`app/api/notifications/history/route.ts:8-29`,
`app/api/notifications/answer/route.ts:9-65`,
`app/api/sessions/[id]/context/route.ts:10-18`.

Uploads: Der Next-Proxy puffert jeden Request-Body **vor** der Auth bis zu
seinem 26-MiB-Deckel, deshalb sendet der Client höchstens eine Datei (≤ 25 MiB)
pro Request; eine 100-MiB-Auswahl erreicht den Server als mehrere Requests.
Serverseitig bleibt die Grenze 25 MiB pro Datei (Dateibytes pro Request), die
100 MiB sind das Budget pro Auswahl. Der Konfliktdialog (`upload-check` bzw.
`409` mit `conflicts`/`nonReplaceable`) ist davon unberührt.

Fehlerkörper sind einheitlich `{"error": "...", "code": "..."}`. Codes, die der
Client typisiert behandeln muss:

`password_required` (401), `invalid_json` (400), `request_too_large` (413),
`session_not_found` (404), `session_not_managed` (409),
`skill_diagnostics_unavailable` (409), `session_slow` (503 auf den
State-Polls und beim Rename eines beschäftigten omp-Kindes, 400 auf
`POST /api/agent/[id]` — optional mit `maybeStarted`
bzw. `abortUnconfirmed`), `session_state_timeout` (derselbe Vertrag wie
`session_slow`: das omp-Kind bleibt am Leben, „später erneut fragen“; die
Route-Schicht normalisiert ihn auf `503 session_slow`, der Client behandelt
beide Codes gleich),
`invalid_sync` / `invalid_sync_cursor` / `invalid_sync_limit` /
`invalid_boundary` / `invalid_boundary_options` (400),
`session_file_too_large` (413), `file_not_found` (404),
`access_denied` (403), `not_a_file` (400), `unknown_connection` (404),
`query_required` / `query_too_long` / `invalid_limit` / `invalid_cursor` /
`cursor_query_mismatch` (400 auf `GET /api/sessions/messages/search`, §3.6),
`search_busy` (429 ebenda, mit `Retry-After`).

---

## 2. Event-Mux `/api/events`

### 2.1 Verbindung

`GET /api/events` öffnet einen SSE-Strom
(`app/api/events/route.ts:10-25`):

- `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`.
- `?heartbeat=<sekunden>`: erlaubt sind 15–110; alles andere (auch Unsinn)
  fällt auf 30 s zurück (`lib/event-stream-hub.ts:22-32`,
  `app/api/events/route.ts:13-14`). Der Web-Client lässt den Parameter weg; die
  native App sendet `?heartbeat=110` (`app/src/main/java/io/github/kahme247/ompweb/events/HttpEventTransport.kt`).
- Der Server schreibt alle 30 s (bzw. `heartbeat`) einen SSE-Kommentar `:`.
  Clients müssen Kommentarzeilen verwerfen (`lib/event-stream-hub.ts:99-101`).
- Direkt nach dem Öffnen kommt der Control-Frame
  `event: mux` + `data: {"type":"hello","connectionId":"<uuid>"}`
  (`lib/event-stream-hub.ts:97-101`).

Es gibt genau zwei SSE-Eventnamen (`lib/event-stream-protocol.ts:9-23`):

| `event:` | `data:` | Bedeutung |
|---|---|---|
| `mux` | `MuxControlFrame` | Verbindungs-/Subscription-Steuerung |
| `s<zahl>` | Channel-Payload | Daten genau dieser Subscription |

Subscription-IDs müssen `^s[0-9]{1,15}$` erfüllen; sie sind zugleich der
SSE-Eventname (`lib/event-stream-protocol.ts:21-23`).

`MuxControlFrame` (`lib/event-stream-protocol.ts:34-37`):

```json
{"type":"hello","connectionId":"…"}
{"type":"open","sub":"s1"}
{"type":"end","sub":"s1"}
```

- `open` wird **vor** den ersten Datenframes der Subscription geschrieben.
- `end` bedeutet: Der Server hat diese Subscription beendet (Watcher tot,
  nicht serialisierbarer Frame). Nur diese Subscription ist betroffen; der
  Client abonniert sie nach kurzer Verzögerung neu. Ein explizites
  `unsubscribe` erzeugt **kein** `end`.

### 2.2 POST subscribe / unsubscribe

`POST /api/events` (`app/api/events/route.ts:26-50`):

```json
{"connectionId":"…","subscribe":{"id":"s1","channel":{"kind":"running"}}}
{"connectionId":"…","unsubscribe":"s1"}
```

- Body > 16 KiB → `413`; sonst `400` mit `invalid_event_stream_request`.
- Unbekannte `connectionId` → `404` `unknown_connection` (Client verbindet neu).
- Erfolg → `200 {"ok":true}`.
- Eine bereits benutzte ID wird zuerst abgemeldet und ersetzt
  (`lib/event-stream-hub.ts:135-137`).
- Scheitert der Channel-Open, wird die Subscription sofort wieder entfernt und
  der Fehler als `{"error","code"}` mit dem Status des Channels geliefert
  (`lib/event-stream-hub.ts:150-159`).
- `unsubscribe` ist idempotent und liefert `{"ok":true}`.

### 2.3 Channels

`EventStreamChannel` (`lib/event-stream-protocol.ts:25-33`):

#### `running`

Parameter: keine.

Beim Öffnen: `open`, dann sofort ein vollständiger Snapshot
(`lib/event-stream-hub.ts:255-282`):

```json
{"type":"running","runningSessionIds":["…"],"runningSessions":[…],"exitedSessions":[…],"elsewhereSessions":[…]}
```

`elsewhereSessions` (§3.7) ist immer vorhanden (leer = `[]`) und bleibt getrennt
von `runningSessionIds`: ein fremder Lauf erzeugt kein Unread-Badge und keine
Benachrichtigung. Ein Frame mit dem Feld ersetzt die Menge vollständig, damit
ein beendeter Besitzer sein Badge verliert.

Danach bei jeder Änderung ein neuer `running`-Frame; zusätzlich
`{"type":"sessions-changed","sessionIds":["…"],"refreshSessionList":true}`
bei Session-Dateiänderungen. Der Snapshot wird **nach** dem Abonnieren der
Live-Quellen erzeugt (`:257-274` vor `:275-282`), damit kein Wechsel in der
Lücke dazwischen verloren geht und ein Live-Frame nie älter ist als der
Snapshot. `refreshSessionList` steht nur an Live-Frames, nicht am initialen
Snapshot.

#### `notifications`

Parameter: `clientId` (ID dieses Tabs, 8–64 Zeichen `[A-Za-z0-9_-]`).

Frames (`lib/event-stream-hub.ts:287-300`):

```json
{"type":"notification","kind":"toast"|"os","event":{…NotificationEvent…}}
{"type":"notification-dismiss","sessionId":"…","tag":"<sessionId>:input","requestId":"…"}
```

Das Öffnen dieses Channels macht den Tab „reachable“ für Toasts/In-Page-
Benachrichtigungen. Schließt der letzte Stream eines Clients, wird er entfernt.

#### `session`

Parameter: `sessionId`.

Ablauf (`lib/event-stream-hub.ts:308-323`):

1. Existiert kein **lebender** Wrapper für die ID → Subscribe-POST
   `409 {"error":"Session is not managed by omp-web","code":"session_not_managed"}`.
   Der Channel wird nicht geöffnet; der Client darf die Subscription als
   fatal behandeln (kein Retry auf derselben ID), bis er einen Wrapper startet.
2. Sonst `open`, dann wird der Wrapper-Eventlistener registriert, dann
   `{"type":"connected","sessionId":"…","web":{"streamId":"…","sequence":N}}`
   mit dem aktuellen Cursor.
3. Der Wrapper replayt beim Attach noch offene `extension_ui_request`-Frames
   (frisch sequenziert, siehe §4.8) und sendet danach alle Agent-Events.
4. Jedes Event trägt `web: {streamId, sequence}`.

Der Channel ist rein beobachtend: Er startet **nie** einen omp-Prozess.
Explizite Kommandos gehen über `POST /api/agent/[id]` (§3).

#### `file`

Parameter: `path` (max. 8192 Zeichen), `sessionId` (string oder `null`).

Berechtigung über `authorizeFileAccess` (`lib/file-authorization.ts:56-90`):
erlaubte Projekt-/Config-Roots oder eine von der Session referenzierte Datei;
Credential-Dateien unter dem Config-Root sind immer gesperrt. Fehler:
`403 access_denied`, `404 file_not_found`, danach `400 not_a_file`, wenn kein
reguläres File (`lib/event-stream-hub.ts:325-330`).

Frames (`lib/event-stream-hub.ts:332-359`):

```json
{"type":"connected","filePath":"…"}
{"type":"change","mtime":"2026-10-20T…Z","size":1234}
{"type":"error","message":"Failed to watch file"}
```

`change` wird nur bei echter Änderung von `mtime`/`size` gesendet. Bei
Watcher-Fehler folgt `error` + `end`.

#### `host-tools`

Parameter: keine.

Liefert Host-Tool-Aufrufe (`open_url`, `notify`, `open_file`, …) aus Sessions,
die kein Tab beobachtet, damit diese Sessions nicht blockieren
(`lib/event-stream-hub.ts:301-304`):

```json
{"type":"host_tool_call","sessionId":"…","id":"…","toolName":"…","arguments":{…}}
```

Geantwortet wird per RPC `host_tool_result` (§3.3).

### 2.4 Reconnect-Pflichten des Clients

Der Browser-Worker (`public/event-stream-worker.js`) ist die Referenz:

1. `hello` → `connectionId` merken und **alle** Subscriptions erneut per POST
   anmelden (`:111-116`).
2. Verbindungsabbruch: eigener Reconnect mit Backoff 1 s → 30 s
   (`:26-28,71-79`); `hello` setzt den Backoff auf 1 s zurück.
3. `end` einer Subscription: nach 3 s neu abonnieren (`:122-128`).
4. Subscribe-POST scheitert mit `unknown_connection`: Verbindung neu aufbauen.
   Mit `409`/`403`/`404`: Subscription ist fatal, Flow mit Fehler beenden;
   der Client entscheidet über einen Retry (`:140-160`).
5. Nach jedem Reconnect ist der neue `connected`-Cursor (bzw. `hello` +
   Session-`connected`) eine **neue Epoche**: persistenten Verlauf neu laden,
   Live-Zustand verwerfen (§4.5). Der Client darf nicht annehmen, dass
   Frames aus der Offline-Zeit nachgeliefert werden; der Server hält keinen
   Replay-Puffer für Agent-Events.

---

## 3. RPC über HTTP

### 3.1 `POST /api/agent/[id]`

Body: ein JSON-Objekt mit `type` (String). Alles andere wird an omp
weitergereicht (`app/api/agent/[id]/route.ts:47-96`).

Antwort bei Erfolg:

```json
{"success":true,"data":<result>}
```

`data` ist bei vielen Kommandos `null` (Feuern-und-Vergessen). Fehler:

| Fall | Status | Code |
|---|---|---|
| Body > 8 MiB | `413` | `request_too_large` |
| kein JSON | `400` | `invalid_json` |
| `type` fehlt/leer | `400` | `command_type_required` |
| `WebRpcError` | `400` | `error.code` |
| `RpcCommandError` | `400` | `error.code ?? rpc_command_failed` |
| omp-Timeout beim `get_state`/`prompt`/`/mcp list` | `400` | `session_slow` (Kind lebt weiter, Run läuft weiter; Felder `maybeStarted`, `abortUnconfirmed`) |
| Session gehört einem anderen omp-Prozess | `409` | `session_running_elsewhere` (Body zusätzlich `elsewhere`, s. §3.7) |
| anderer Fehler | `500` | `text` |

Quelle: `app/api/agent/[id]/route.ts` (`commandErrorResponse`, `POST`/`GET`).
Timeout: `lib/rpc-manager.ts` (`dispatchCommand`, `destroyIfStalled`) — ein
Timeout beendet das Kind nie. `maybeStarted: true` heißt: der Prompt-Frame
kann schon in omp stecken, die Nachricht läuft evtl. noch; erneutes Senden
bleibt gesperrt, bis ein Frame oder ein erfolgreiches `get_state` eintrifft.
`abortUnconfirmed: true` heißt: der Abbruch ist nicht bestätigt. Ein Kind ohne
jedes Lebenszeichen (kein Frame, keine Antwort) für fünf Minuten
(`OMP_WEB_STALL_DESTROY_MS`, `0` = aus) wird beim nächsten Timeout verworfen;
der `exited`-Eintrag mit `detail: "stalled"` steht danach nur in
`GET /api/sessions/[id]/state` (§3.2), `GET /api/agent/[id]` meldet
`{"running":false,"alive":false}`.

Ablauf:

1. Läuft bereits ein Wrapper und `type` ist kein Sonderfall → `send`.
2. Kein Wrapper:
   - `NO_SPAWN_REPLIES` → Antwort ohne Spawn.
   - `LIVE_SESSION_ONLY` → `409 skill_diagnostics_unavailable`.
   - sonst Session-Datei auflösen (`404 session_not_found`) und Wrapper
     starten (`app/api/agent/[id]/route.ts:64-96`).
3. `?advisor=1` ist ein **Spawn-Flag** und steht nie im Body. Weicht es vom
   laufenden Kind ab, wird nur ein **idles** Kind ersetzt; ein beschäftigtes
   läuft weiter und übernimmt das Flag beim nächsten natürlichen Respawn
   (`app/api/agent/[id]/route.ts:59-83`, `lib/agent-client.ts:12-27`).

`NO_SPAWN_REPLIES` (`app/api/agent/[id]/route.ts:14-19`):

| `type` | Antwort ohne lebenden Wrapper |
|---|---|
| `predict_word` | `{"suffix":null}` |
| `predict_word_feedback` | `null` |
| `get_btw_history` | `{"records":[]}` |
| `btw_cancel` | `{"cancelled":false}` |

`LIVE_SESSION_ONLY` (`app/api/agent/[id]/route.ts:25-26`):
`get_skill_diagnostics`, `set_skill_startup_diagnostics` → ohne lebenden
Wrapper `409`, nie Spawn nur zum Lesen/Schalten.

### 3.2 `GET /api/agent/[id]`

Zustand für Reconciliation (`app/api/agent/[id]/route.ts`, `GET`). Zwei
getrennte Felder, beide **nach** dem `get_state`-Aufruf ausgewertet und damit
autoritativ (`isRunning()`: streaming, kompaktierend, laufende Shell, Queue
bzw. versandter Prompt, Dialog oder Host-Tool, das auf einen Menschen wartet):

- `running`: ein Turn ist in Flug — **nicht** „ein Kind antwortet“.
- `alive`: der omp-Prozess für die Session existiert.

Antworten:

- kein lebender Wrapper: `{"running":false,"alive":false,"elsewhere":{…}|null}`
- lebend: `{"running":<bool>,"alive":true,"state":<WebSessionState>,"elsewhere":null}`
  — ein lediglich untätiges Kind (frisch gespawnt, zwischen zwei Turns,
  große Session am Laden) antwortet `running:false, alive:true, state:{…}`.
  Clients dürfen `alive`-Werte (Slow-Mode, Besitz) nicht aus `running`
  ableiten.
- `get_state`-Timeout:
  `503 {"error":"…","code":"session_slow","running":<bool>,"alive":true,"silentForMs":<ms>}`
  — omp ist beschäftigt, nicht beendet: Kind und Run bleiben, der Client pollt
  erneut. `running:false` ist die Aussage des Servers „kein Turn in Flug“;
  der Client beendet den von ihm noch angezeigten Lauf sofort — auch wenn
  sein eigener State-Read am selben blockierten Kind scheitert, denn das
  beweist nur einen unbekannten Transkript, nicht einen laufenden Turn.
  `running:true` heißt umgekehrt: der Run besteht weiter, der Client merkt
  ihn sich (kein Settle). Fehlt `running` (älterer Server), ist der Zustand
  unbekannt; der Client begrenzt das Fenster selbst und befragt danach
  `GET /api/sessions` (`runningSessionIds`). `silentForMs` ist die Zeit seit
  dem letzten **Frame** des Kindes (Poll-Antworten bewegen die Uhr nicht).
  Kein Recyclen (`lib/rpc-manager.ts`, `slowSessionError`).
- Ein Kind ohne Lebenszeichen für fünf Minuten wird beim nächsten Timeout
  verworfen; `GET /api/agent/[id]` antwortet danach nur
  `{"running":false,"alive":false}`. Den Exit-Grund tragen ausschließlich
  `GET /api/sessions/[id]/state` bzw. die serverseitige Exit-Map
  (`exited:{…,"detail":"stalled"}`, `destroyIfStalled`).

`GET /api/sessions/[id]/state` antwortet mit **demselben** Rumpf
(`running`, `alive`, `state`, `elsewhere`, derselbe 503-Body); `exited` kommt
dort zusätzlich statt `state`. `GET /api/sessions/[id]?includeState=1` bettet
ihn als `agent` ein (bei `get_state`-Timeout entfällt `agent` ganz).

`WebSessionState` (`lib/pi-types.ts`, `buildWebState` in `lib/rpc-manager.ts`)
enthält u. a.:

```
sessionId, sessionFile, sessionName?, isStreaming, isPromptRunning,
isBashRunning, isCompacting, responseObserved?,
autoCompactionEnabled, interruptMode, steeringMode, followUpMode,
model?, messageCount, queuedMessageCount, queuedMessages,
contextUsage, systemPrompt, thinkingLevel,
fastModeEnabled, fastModeActive?, slowModeSupported, slowModeEnabled,
slowModeScope?, usageLimit?, autoRetryEnabled?, tokensPerSecond?,
skillDiagnostics?, todoPhases, extensionStatuses, extensionWidgets
```

`queuedMessages` ist `{"steering":string[],"followUp":string[]}`
(`lib/pi-types.ts:61-64`). Der Wrapper liefert zusätzlich den Wrapper-eigenen
`responseObserved` und `isPromptRunning`, die nicht aus der Datei stammen.

### 3.3 Kommandos, die der Web-Client sendet

Alle Typen sind in `lib/pi-types.ts` gespiegelt; die Dispatch-Stelle ist
`dispatchCommand` in `lib/rpc-manager.ts`. `PASSTHROUGH_COMMANDS` werden
unverändert an omp geschickt, alle anderen baut der Wrapper.

| Gruppe | `type` | Wirkung / `data` |
|---|---|---|
| Run | `prompt` | `{message, images?, streamingBehavior?:"steer" / "followUp"}` → `null`; `agent_start`/`agent_end` kommen als Frames. Bei `bashRunning` stattdessen Follow-up-Queue (§4.11). |
| Run | `steer`, `follow_up` | `{message, images?}` → `null`; hängt Nutzertext an den laufenden Turn bzw. die Queue. |
| Run | `abort` | → `null`; beendet den Turn. |
| Run | `abort_and_restore_queue` | → `{steering:[{text,images?}],followUp:[…]}` (omp gibt entzogene Nachrichten zurück); Client stellt sie in den Draft zurück (§4.10). |
| Run | `abort_and_prompt` | omp-Antwort; atomar abbrechen und neuen Prompt starten. |
| Run | `get_state` | → `WebSessionState` (§3.2). |
| Run | `bash` | `{command}` → `BashResultInfo {output, exitCode?, cancelled, timedOut?, truncated, …}`; `excludeFromContext:true` wird mit `bash_exclude_unsupported` abgelehnt (`case "bash"` in `dispatchCommand`, `lib/pi-types.ts`). |
| Queue | `remove_queued_message`, `promote_queued_message` | `{message, queue:"steering" / "followUp"}` → omp-Ergebnis, i. d. R. `{removed:true}` bzw. `null`. |
| Session | `set_session_name` | `{name}` → `null`; leerer Name ist ein Fehler. |
| Session | `new_session`, `switch_session` | → `{cancelled:true}` oder `{cancelled:false,newSessionId}` (Wrapper liest die neue Identität). |
| Session | `fork` | `{entryId}` → `{cancelled:true}` oder `{cancelled:false,newSessionId,text}`; nutzt omp `branch`. |
| Session | `compact` | `{customInstructions?}` → Compaction-Ergebnis; `abort_compaction` → `null` (schickt `abort`). |
| Session | `reload` | startet das Kind neu → `{success:true}`. |
| Session | `get_session_stats` | → `SessionStatsInfo` + `sessionName`. |
| Session | `get_last_assistant_text` | → `{text}` (leer statt `null`). |
| Session | `get_commands` | → `{commands:[…]}` (omp `get_available_commands`). |
| Historie | `get_messages`, `get_messages_page`, `get_branch_messages` | omp-Passthrough; `data` ist die jeweilige omp-Antwort. |
| Historie | `export_html`, `handoff` | omp-Passthrough. |
| Modell | `set_model` | `{provider,modelId}` → `{id,provider}`. |
| Modell | `set_thinking_level`, `cycle_thinking_level`, `cycle_model`, `get_available_models` | Passthrough. |
| Modell | `set_fast_mode` | `{enabled}` → `{enabled,active}`. |
| Modell | `set_slow_mode` | `{enabled}` → `{enabled}`. |
| Modell | `set_auto_compaction`, `set_auto_retry`, `abort_retry` | Passthrough. |
| Modell | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` | Passthrough. |
| Modell | `set_todos` | Passthrough. |
| Side question | `btw` | `{question, recordId?}` → `{record:BtwRecord}`; Antwort streamt als `btw_record`/`btw_delta` (§4.7). |
| Side question | `btw_cancel` | `{recordId}` → `{cancelled:boolean}`; ohne Wrapper `{cancelled:false}`. |
| Side question | `get_btw_history` | → `{records:BtwRecord[]}`; ohne Wrapper `{records:[]}`. |
| Subagents | `get_subagents`, `get_subagent_messages`, `set_subagent_subscription` | Passthrough bzw. omp-Antwort. |
| Extension-UI | `extension_ui_response` | `{id, value|confirmed|cancelled|answers}` → `null`; beendet den Dialog und emittiert lokal `cancel` (§4.8). |
| Host | `set_host_tools`, `set_host_uri_schemes` | registriert Fähigkeiten → `null`. |
| Host | `host_tool_result`, `host_uri_result` | Antwort-Frame an omp → `null`. |
| Diagnose | `get_skill_diagnostics`, `set_skill_startup_diagnostics` | → Snapshot; nur mit lebendem Wrapper (§3.1). |
| Prediction | `predict_word`, `predict_word_feedback` | `{suffix}` bzw. `null`; Timeout `PREDICT_WORD_TIMEOUT_MS` (125 s). |
| Auth | `get_login_providers`, `login` | Passthrough; der Browser nutzt dafür zusätzlich die Auth-Routen. |

Nicht unterstützt und bewusst abgelehnt (`UNSUPPORTED_COMMANDS`):
`navigate_tree`, `clear_queue`, `get_tools`, `set_tools`, `extension_ui_input`.
Unbekannte Typen ohne Passthrough → `Unsupported command: <type>`.
`ensure_session` ist **kein** Kommando an `[id]`; es gehört zu
`POST /api/agent/new` (§3.4).

Bildträger (`IMAGE_BEARING_COMMANDS`) werden vor dem
Versand serverseitig auf Anzahl/Größe/Format geprüft
(`lib/image-attachments.ts`).

**Timeouts.** Jedes Kommando außer den explizit ungebundenen
(`UNBOUNDED_PASSTHROUGH_COMMANDS`) und den vier expliziten Langläufern
(`bash`, `compact`, `branch`, `fork` — eigene Switch-Zweige ohne Timeout,
weil ihre Antwort legitim Minuten dauern kann) ist serverseitig begrenzt
(`sendControl`):
Antwortet omp nicht rechtzeitig, antwortet die Route mit
`400 {"error":"…","code":"session_slow",…}` — keine 5xx, kein Recycle, Kind und
Run laufen weiter. Grenzen: 30 s für `prompt`, `steer`, `follow_up`,
`abort_and_prompt`, `new_session`, `switch_session`, `abort`,
`abort_and_restore_queue`, `abort_compaction`; 5 s für die übrigen Steuer- und
Abfragekommandos (`get_state`, `set_model`, `set_*_mode`, Queue-Mutationen,
`get_commands`, Namen, Statistiken, Host-Fähigkeiten …). Der Body trägt bei
Timeout zusätzlich:

(Polls antworten `503` mit demselben Code.)

- `maybeStarted: true` bei `prompt`, `steer`, `follow_up`, `abort_and_prompt`
  und beim `follow_up` des Shell-Degrades: der Frame war schon in omps stdin,
  der Text darf nicht als „nicht gesendet“ zurückgelegt werden (§4.11).
- `abortUnconfirmed: true` bei `abort` und `abort_and_restore_queue`: weder der
  Stop noch der Queue-Zustand ist bekannt; der Client darf weder den Run lokal
  beenden noch den Draft aus einer Vermutung füllen.

Ein Prompt-Frame (`prompt`, `steer`, `follow_up`, `abort_and_prompt`) ohne
`details` im `session_slow` heißt: das Kind wurde in diesem Moment verworfen
(`destroyIfStalled`, §3.2) — dann ist der Frame definitiv **nicht** gestartet
und der Client rollt zurück und holt den Text zurück. Abfrage-Kommandos tragen
nie `details`.

### 3.4 `POST /api/agent/new`

Body (`app/api/agent/new/route.ts:34-84`):

```json
{
  "cwd": "C:\\…",
  "type": "prompt" | "ensure_session",
  "message": "…",
  "provider": "…", "modelId": "…",
  "toolNames": ["…"], "thinkingLevel": "high",
  "advisor": true
}
```

- `cwd` fehlt → `400 cwd_required`; Verzeichnis fehlt → `400 directory_not_found`.
- `type` fehlt → `400 command_type_required`.
- `ensure_session` startet nur den Wrapper und antwortet
  `{"success":true,"sessionId":"…","data":null}`.
- Sonst wird der Prompt nach `set_model`/`set_thinking_level` gesendet; Antwort
  `{"success":true,"sessionId":"…","data":<prompt result>}`.
- Ein Fehler nach dem Spawn zerstört das Kind wieder — **außer**
  `session_slow`: dieser Timeout kommt erst, nachdem das Kind den Frame
  bekommen hat (Set-Model/Thinking oder Prompt können bereits laufen), deshalb
  bleibt es am Leben und der Body trägt `maybeStarted`/`abortUnconfirmed` wie
  auf `POST /api/agent/[id]` **und** die echte `sessionId`. Ein solcher Run
  zählt nur bis `AWAITING_AGENT_START_TIMEOUT_MS` (10 s) nach dem Prompt-Ack
  (bzw. nach dem abgelaufenen Ack-Timeout) als laufend: Kommen danach keine
  Frames, greifen Idle-/Disconnect-Reaper wieder
  (dieselbe Deadline wertet `isRunning()` aus, ohne auf einen `get_state` zu
  warten).
- `sessionId` ist immer omp's echte ID, nie die Request-ID.

Wichtig: omp legt die Session-Datei erst beim ersten **committeten**
Assistant-/Tool-Ergebnis an. `ensure_session` und ein reines `get_state`
erzeugen keine Datei; `GET /api/sessions/[id]/context` fängt diesen Fall für
einen lebenden Wrapper ab (`app/api/sessions/[id]/context/route.ts:80-103`),
`DELETE /api/sessions/[id]` antwortet dagegen `404 session_not_found`.

### 3.5 Sessions-Liste und Löschen

`GET /api/sessions` → `{sessions, runningSessionIds, runningSessions}`;
`ETag` + `304` bei unverändertem Body, immer `Cache-Control: no-store`
(`app/api/sessions/route.ts:6-31`). `SessionInfo`:
`{path,id,cwd,name?,created,modified,messageCount}` (`lib/types.ts:437-445`).

`DELETE /api/sessions/[id]` wartet auf das Ende des Wrappers, löscht Datei und
Artefakte und antwortet `{ok:true}` (plus `skippedChildren` bei nicht
umschreibbaren Kindern); ohne Datei `404 session_not_found`
(`app/api/sessions/[id]/route.ts:304-432`, `lib/api-utils.ts:5-16`).

`PATCH /api/sessions/[id]` mit `{name}` benennt die Session um. Ein lebender
Wrapper bekommt den Namen über omp (`set_session_name`), damit der
In-Memory-Titel den nächsten Flush überlebt; antwortet omp nicht innerhalb von
5 s, antwortet die Route `503 {"code":"session_slow"}` und schreibt **nicht**
in die Datei neben dem Kind. Der Datei-Fallback (`setSessionTitle`) gilt nur,
wenn kein Wrapper lebt, omp das Kommando sofort ablehnt (`RpcCommandError`,
nichts wurde angewandt) oder das Kind vor der Antwort stirbt. Clients zeigen
„busy, erneut versuchen“ und behalten den alten Titel — kein Erfolgstoast,
keine Listen-Aktualisierung, die einen Rename vortäuscht
(`app/api/sessions/[id]/route.ts`, `lib/rpc-manager.ts`).

### 3.6 `GET /api/sessions/messages/search`

Volltextsuche über die Session-Dateien; nur vorhanden, wenn
`capabilities.messageSearch` aus §1.3 gesetzt ist. Die Route liegt unter
`/api/` und läuft damit durch das Auth-Gate aus §1.1 (Cookie
`omp_web_session`, sonst `401 password_required`); native Clients senden wie
überall keinen `Origin`-Header. Antworten tragen immer
`Cache-Control: no-store`
(`app/api/sessions/messages/search/route.ts:16,18,32-92`).

Parameter (GET-Query, `app/api/sessions/messages/search/route.ts:33-49`):

| Name | Pflicht | Bedeutung |
|---|---|---|
| `q` | ja | Suchtext, vor der Suche getrimmt; 1–200 Zeichen. Case-insensitive Teilstring-Suche (kein Regex, kein Wortstamm). |
| `limit` | nein | Treffer pro Seite, ganze Zahl 1–100, Default 20 (`lib/session-message-search.ts:24-25`). |
| `cursor` | nein | Opaker Token aus der vorigen Antwort (base64url, `lib/session-message-search.ts:150-174`). Er ist an `q` gebunden (`searchQueryKey`: SHA-1 über `chat\0<q kleingeschrieben>`, `:143-148`); ein Cursor einer anderen Query wird abgelehnt. |

Erfolg `200` (`app/api/sessions/messages/search/route.ts:60-74`):

```json
{
  "query": "needle",
  "results": [
    {
      "sessionId": "…",
      "title": "…",
      "cwd": "/home/user/project",
      "entryId": "…",
      "role": "user",
      "timestamp": "2026-10-25T18:00:00.000Z",
      "snippet": "…up to 80 characters before and after…",
      "matchStart": 12,
      "matchEnd": 18
    }
  ],
  "partial": true,
  "cursor": "eyJ2IjoxLCJxIjoi…",
  "scannedFiles": 3,
  "scannedBytes": 1048576,
  "skippedFiles": 0
}
```

- `results` ist **neueste zuerst**: Sessions nach `modified` absteigend (bei
  Gleichstand Pfad), innerhalb einer Datei von der letzten Zeile rückwärts.
- `snippet` ist einzeilig (Whitespace zusammengefasst) mit `…` an
  abgeschnittenen Rändern; `matchStart`/`matchEnd` sind Offsets **im Snippet**
  in UTF-16-Code-Units (wie Kotlin-Strings), `matchEnd` exklusiv
  (`lib/session-message-search.ts:570-585`).
- `partial:true` + nicht-null `cursor` heißen „mehr Sessions/Zeilen übrig“;
  `partial:false` + `cursor:null` heißt „Korpus vollständig durchsucht“. Der
  Scan stoppt an der ersten erreichten Grenze: Trefferzahl, 16 MiB pro Datei,
  64 MiB gesamt oder 5 s Wanduhr — die Uhr startet **nach** dem
  Verzeichnis-Listing (`lib/session-message-search.ts:23,29-30,220-229`).
- `role` ist ausschließlich `user` oder `assistant`. Thinking-Blöcke,
  Tool-Aufrufe und Tool-Ergebnisse sind nicht durchsuchbar — genau der Text,
  den der Web-Transkript anzeigt (`lib/session-message-search.ts:555-558,591-602`).
- Dateien über 64 MiB werden übersprungen und in `skippedFiles` gezählt;
  `scannedFiles`/`scannedBytes` beschreiben den tatsächlichen Lauf
  (`lib/session-message-search.ts:28-30`).

Fehler (Körper wie §1.4, `app/api/sessions/messages/search/route.ts:16-18,33-51,75-91`):

| Status | Code | Ursache |
|---|---|---|
| `400` | `query_required` | `q` fehlt oder ist nach dem Trimmen leer |
| `400` | `query_too_long` | `q` länger als 200 Zeichen |
| `400` | `invalid_limit` | `limit` keine ganze Zahl oder außerhalb 1–100 (auch `limit=abc`) |
| `400` | `invalid_cursor` | `cursor` ist kein gültiger Token dieses Servers |
| `400` | `cursor_query_mismatch` | `cursor` gehört zu einer anderen Query |
| `429` | `search_busy` | mehr als 2 Suchläufe gleichzeitig im Prozess; Header `Retry-After: 1` (Sekunden), Body `{"error":"Too many searches in flight, retry shortly","code":"search_busy"}` |
| `500` | `internal_error` | Dateisystem-/Parse-Fehler; Details bleiben im Server-Log (`console.error`), der Body nennt keine Pfade |

Der Client muss `429` als „später erneut“ behandeln (kein Fehlerbanner) und
darf bei `partial:true` nur mit **unverändertem** `q` weiterblättern; bei
neuer Query wird der Cursor verworfen. `404` auf diese Route bedeutet
„Server-Version ohne Nachrichtensuche“ und wird als „Server zu alt“ erklärt
(§1.3).

### 3.7 Fremdbesitz einer Session (`elsewhere`)

omp ≥ 18.5 lässt nur **einen** Prozess pro Session schreiben (OS-Lease je
Session-Id). Ein Prompt aus einem zweiten Client verschiebt die Session beim
ersten Schreiben in eine Kopie mit neuer Id (`Session moved to a new file`,
`reason: open-elsewhere`) — das ist der „plötzlich neuer Chat“. Der Server
erkennt fremden Besitz über drei Quellen und meldet ihn als `SessionElsewhere`:

```json
{"kind":"omp-web"|"terminal","source":"instance-list"|"process"|"transcript",
 "running":true,"active":true,"lastActivityAt":1800000000000}
```

- `instance-list` (stärkster): Id steht in der laufenden Session-Liste einer
  anderen lebenden omp-web-Instanz.
- `process`: ein fremder omp-Prozess hat `--resume` mit dieser Datei/Id.
- `transcript` (schwächster): Datei kürzlich geschrieben und ohne
  `session_exit` — ein abgestürzter Schreiber hinterlässt dasselbe Muster.
- `active`: ein Besitzer ist **bekannt** — Prozess (`process`) oder andere
  Instanz (`instance-list`), auch wenn die Datei seit Stunden nicht mehr
  geschrieben wurde; ebenso bei einem Transkript-Signal innerhalb des
  Aktivitätsfensters. Kein Zeitkriterium für die Besitzer-Signale.
  `running`: der Besitzer ist mitten im Turn.

Pflichtfelder sind nur `kind`, `source`, `running` und `active`.
`lastActivityAt` ist **nur** vorhanden, wenn der Server die Datei gelesen hat
(ein leerlaufend offener Besitzer mit alter Datei liefert es nicht); `id`
tragen nur die Einträge in `elsewhereSessions`. Die PID und das `cwd` des
Besitzers werden **nie** ausgeliefert — kein Client braucht sie, und sie
verraten den fremden Prozess bzw. die andere Instanz.

Vorkommen:

- `GET /api/sessions` → `elsewhereSessions: [{id, …elsewhere}]` (leer =
  `[]`). Getrennt von `runningSessionIds`: Unread-Badges und Benachrichtigungen
  hängen nur an den lokal laufenden Läufen.
- `GET /api/agent/[id]` → Top-Level `elsewhere: {…}|null` (auch im 200-Body).
- `GET /api/sessions/[id]?includeState=1` → `agent: {running, alive, state?, elsewhere}`:
  `{running:false, alive:false, elsewhere:{…}}` ohne Kind, sonst
  `{running:<bool>, alive:true, state, elsewhere:null}`.
- `running`-Frame (§2.3): `elsewhereSessions` in Initial- und Update-Frame.
- `409 session_running_elsewhere` beim `POST /api/agent/[id]`, Body mit
  `elsewhere`; `?force=1` schaltet **nur** dieses Gate ab (kombinierbar mit
  `?advisor=1`) und ist ausschließlich nach ausdrücklicher Nutzerbestätigung
  erlaubt. Ein Client, der bereits weiß, dass die Session fremd besessen ist,
  sendet gar nicht erst.

**Form beachten:** Nur die Einträge in `elsewhereSessions` tragen `id`. Die
Meldung zu **einer** Session (`GET /api/agent/[id]`, der `409`-Body,
`agent.elsewhere` im Detail) ist das nackte `SessionElsewhere` **ohne**
`id`/`cwd`/`pid` — die Anfrage hat die Id ja schon genannt, und
Prozessdetails des Besitzers bleiben serverseitig. Ein Client, der `id` beim
Dekodieren erzwingt, verwirft damit jede Live-Meldung (die App zeigte dann den
Listen-Badge, aber nie das Chat-Banner).

Client-Regeln: Badge in der Liste („Elsewhere“), Banner im Chat mit dem
Besitzer, Draft bleibt im Feld, read-only weiterlesen (der Client pollt die
Session-Datei, solange `active`), und nur der explizite Dialog
„Send anyway (copy)“ sendet mit `?force=1`. Kommt trotzdem ein `409` (Race),
wird der optimistische Turn verworfen, der Text zurückgegeben und derselbe
Dialog geöffnet — kein Fehler-Toast. Auto-Naming fällt bei fremdem Besitz
still auf den gespeicherten Titel zurück (kein Spawn).

Im Chat ist die eigene `GET /api/agent/[id]`-Antwort die Autorität; solange
sie aussteht (oder mit `session_slow` abgelehnt wird) füllt der bereits
bekannte Listen-Eintrag `elsewhereSessions[id]` Banner und Sende-Gate. Solange
`elsewhere.active` gilt, fragt der Client beides im Takt von 2 s neu ab —
Datei (weiterlesen) **und** Besitzer-Meldung; ohne die zweite Abfrage bliebe
das Banner nach dem Ende des fremden Prozesses stehen, weil der Channel einer
fremden Session mit `409 session_not_managed` verweigert wird (§2.3 `session`).

**Contention-Kopie (Race trotz `?force=1`):** Schreibt der fremde Besitzer
parallel, verschiebt omp den Chat beim ersten Schreiben in eine Kopie mit
neuer Id. Der Server meldet das auf dem Session-Channel als
`{"type":"session_contention_fork","fromId":"…","toId":"…"}`.
`fromId` ist das Original (bleibt beim anderen Prozess), `toId` die Kopie; der
Frame trägt keine Besitzerdetails. Der Client setzt `foreignRun` auf `null`
(die Kopie gehört ihm), hält den Nutzertext in der Kopie und bietet Links auf
Original (`fromId`) und Kopie (`toId`) an; ohne `fromId` wird der Frame
ignoriert. Android zeigt dafür ein persistentes Banner im Composer-Bereich
(`ContentionForkBanner`), Web einen Toast mit beiden Links.

`GET /api/mcp` spawnt bei fremdem Besitz **kein** Kind (kein zweiter
Schreiber): Die Antwort lässt `liveServers` weg (`null`) und erklärt es in
`liveError` („This session is being run by another omp process."). Clients
fallen deshalb auf `inventory` zurück (`liveServers ?: inventory`) und zeigen
`liveError` als Hinweis; ein leeres Array ist **kein** „keine MCP-Server“.

---

## 4. Session-Frames und Client-Regeln

### 4.1 Envelope und Ordnung

Der Wrapper hängt an **jedes** interne Event
`web: {streamId, sequence}` (`handleFrame` in `lib/rpc-manager.ts`). `streamId` ist
eine UUID pro Wrapper-Lebensdauer, `sequence` monoton steigend. Auch
State-Änderungen ohne natives Event (Snapshot, Clear, Compact) erhöhen die
Sequenz, damit ein später gelesener Snapshot ältere Frames nicht überschreibt
(`buildWebState`, `clearLiveSnapshots`, `getStreamSnapshot`).

Der Client nutzt die Sequenz als Ordnungs-/Verwerf-Wasserzeichen, nicht als
persistenten Cursor. Persistenz-Cursor sind §5.

### 4.2 Behandelte Frame-Typen

`hooks/useAgentSession.ts` behandelt (Switch ab `:1942`):

| Typ | Wirkung |
|---|---|
| `skill_diagnostics_update` | Diagnose-Snapshot ersetzen (`:1942`) |
| `queue_update` | Queue-Snapshot (steering/followUp) setzen (`:1947-1955`, §4.3) |
| `agent_start` | Run aktiv, Catch-up invalidieren, Response-Version erhöhen (`:1955-1969`) |
| `agent_end` | Run beenden; `isTerminal === false` ignorieren; Late-Frame nach Reconcile ignorieren (`:1970-2076`) |
| `prompt_result` | Nur `agentInvoked:false` ist ein lokales Slash-Kommando; Run sauber abschließen (`:2077-2091`) |
| `prompt_error` | terminaler Prompt-Fehler; Run abschließen bzw. Notice (`:2092-2107`) |
| `error`, `agent_error`, `turn_error`, `model_error`, `server_error`, `internal_error`, `rpc_frame_error` | Fehlertext merken/anzeigen (`:2108-2119`) |
| `notice` | Notice/Toast, Quota-Erkennung (`:2120-2144`) |
| `command_output` | Text als Notice (`:2145-2156`) |
| `thinking_level_changed` | Thinking-Level setzen (`:2157-2160`) |
| `model_changed` | Modell/Config per `GET /api/agent/[id]` nachziehen (`:2161-2189`) |
| `config_update` | Modell + Thinking-Level aus Payload (`:2190-2198`) |
| `available_commands_update` | Slash-Kommandoliste (`:2199-2204`) |
| `message_start`, `message_update` | Streaming-Bubble; Late-Frames nach Run-Ende verwerfen (`:2205-2231`) |
| `message_end` | committete Nachricht übernehmen, Catch-up anfordern (`:2232-2282`) |
| `turn_end` | terminalen Fehler aus dem Turn übernehmen (`:2283-2287`) |
| `tool_execution_start` / `_update` / `_end` | Live-Tool-Zeile (§4.9, `:2288-2347`) |
| `todo_reminder`, `todo_auto_clear` | Reconcile anstoßen (`:2348-2351`) |
| `auto_retry_start` / `_end` | Retry-Banner (`:2352-2360`) |
| `auto_compaction_start` / `_end` | Compact-Banner, ggf. Session neu laden (`:2361-2375`) |
| `subagent_lifecycle` | Roster ergänzen (`:2376-2384`) |
| `host_tool_call` | registriertes Host-Tool ausführen (`:2385-2393`) |
| `host_uri_request` | registriertes URI-Schema lesen/schreiben (`:2394-2402`) |
| `subagent_progress` | Live-Progress, gefenced gegen Roster/Run/Session (`:2403-2473`) |
| `subagent_event` | Kind-Event, gebatcht pro Frame (`:2474-2524`) |
| `extension_ui_request` | Dialog/Notice/Status (`:2525-2526`, §4.8) |
| `session_contention_fork` | Kopie nach fremdem Schreiber: `foreignRun` löschen, Original (`fromId`) verlinken (§3.7) |

Vor dem Switch und **vor** `catchUp.observe` werden
`btw_record`/`btw_delta` an `useBtw` geleitet (`:1166-1173`, §4.7).
`connected` ist ein Channel-Frame: Er bestätigt die Subscription, startet die
Catch-up-Anfrage und darf eine neue Epoche einleiten (`:1186-1191`).

Nicht behandelt und damit bewusst ignoriert: `turn_start`,
`session_settled`, `advisor_yielded`, `retry_fallback_applied`,
`session_info_update`, `extension_ui_*`-Antworten. Der Server nutzt
`session_settled` für Benachrichtigungen (§6). Ein Client darf weitere Typen
hinzufügen, ohne bestehende zu brechen.

### 4.3 Queue-Reihenfolge

`queue_update` ist ein vollständiger Snapshot, kein Delta
(`hooks/useAgentSession-queue.ts:8-16`). Da `get_state`, SSE und
RPC-Antworten in beliebiger Reihenfolge eintreffen, vergibt der Client jedem
gesendeten `get_state` eine Sequenz (`queueSeqRef`). Jeder eintreffende
`queue_update` setzt das Wasserzeichen auf eine neue Sequenz; eine
`get_state`-Antwort wird nur angewendet, wenn ihre Sequenz größer ist
(`queueAppliedSeqRef` in `applyQueueStateSnapshot`). So kann eine
verspätete HTTP-Antwort keinen neueren SSE-Stand überschreiben.
Die Queue gehört omp: Auch ein anderer Tab oder die TUI sieht dieselben
Einträge; der Client hält keine eigene Queue-Wahrheit.

`remove_queued_message`/`promote_queued_message` antworten unmittelbar; der
nächste `queue_update` bestätigt den Zustand.

### 4.4 `message_update`-Koaleszierung

`message_update` kommt pro Token-Batch und trägt **immer die vollständige
akkumulierte** Teilnachricht. Der Client puffert daher nur die neueste und
gibt sie mit Bildwiederholrate aus (`requestAnimationFrame`, in versteckten
Tabs 50 ms Timer) (`lib/message-update-coalescer.ts:1-58,80-128`).

Regeln:

- Jeder andere Frame-Typ flusht zuerst den Puffer und wird danach
  dispatched — keine Out-of-order-Anwendung.
- `message_end` verwirft einen gepufferten `message_update` (die vollständige
  Nachricht ersetzt ihn), lässt aber gepufferte Tool-Updates stehen.
- `tool_execution_update` wird pro `toolCallId` koalesziert; ohne ID wird er
  sofort dispatched.
- `eventCoalescer.reset()` bei Run-Neustart/Epochenwechsel verwirft alles.

### 4.5 `catchUp.observe`, Epochen und Live-Snapshot

`createSessionCatchUp` (`hooks/useAgentSession-sync.ts:30-230`) hält den
persistenten Verlauf und den Live-Zustand getrennt.

`observe(event)` (`:183-224`):

- Ohne `event.web` → `null`.
- `streamId` wechselt → `"epoch"`: Verlauf, Tools und Cursor zurücksetzen und
  neu laden. Das passiert bei Wrapper-Neustart/Server-Restart.
- Wasserzeichen je Kategorie: Lifecycle (`agent_start`, `agent_end`,
  `prompt_result`, `prompt_error`, `auto_compaction_*`), Message
  (`message_start/update/end`, nicht User) und Tool (`tool_execution_*` pro
  `toolCallId`). Ein Frame unter dem jeweiligen Floor → `"stale"`, wird
  verworfen.
- Sonst Sequenz fortschreiben, `null`.

Der Hook reagiert in `connectEvents` (`es.onmessage`) auf `"epoch"` mit Reset
von Bubble, Tools, Fehlern und einer neuen Catch-up-Anfrage
(`catchUp.request`). Ein von `catchUp.observe` als `"stale"` klassifizierter
Frame wird vor jeder weiteren Verarbeitung verworfen.

`request()` paginiert §5, wendet den Live-Snapshot aber nur feldweise und nur
für neuere Sequenzen an (`hooks/useAgentSession-sync.ts:138-170`). Die
`live`-Anwendung im Hook (`syncActionsRef.current.live`) prüft
`message`/`lifecycle`/`tools` getrennt, damit ein neuerer Tool-Frame nicht von
einem älteren Snapshot gelöscht wird.

### 4.6 Run-ID-Fencing

`promptRunIdRef` wird bei jedem neuen Prompt (`handleSend`) und bei einem
Interrupt-Reply (`handleInterruptAndReply`) erhöht; ein Abort fenced
zusätzlich über `runsEndedRef` (`withdrawAndAbort`). Asynchrone Abschlüsse
(`loadSession`, Reconcile, Catch-up, Abbau des optimistischen Bubbles) merken
sich `sessionId` + `runId` (+ `contextRequestSeq`/`responseVersion`) und
verwerfen ihr Ergebnis, wenn sich einer davon geändert hat
(Fences in `loadSession`, `finishPromptWithoutStream`, `reconcileAgentState`
und `handleInterruptAndReply`). `agent_end` wird ignoriert,
wenn der Run bereits durch Reconcile beendet wurde (Guard `agentRunningRef`
im `agent_end`-Zweig von `handleAgentEvent`).

Der Sinn: Ein verspäteter Reload des alten Runs darf nie die Nachrichten oder
den Spinner eines inzwischen gestarteten neuen Runs überschreiben.

### 4.7 `/btw` vor `observe`

`btw_record`/`btw_delta` werden **vor** `catchUp.observe` abgefangen
(`connectEvents`' `es.onmessage`, vor `catchUp.observe`). Grund: `observe` klassifiziert Frames
über `streamId`/`sequence`; ein Btw-Frame darf nie die Epochen-/Reset-Logik
des Haupttranskripts auslösen. `useBtw` batcht selbst.

Formate (`lib/btw.ts:6-25`, `hooks/useBtw.ts:74-132`):

```json
{"type":"btw_record","record":{
  "id":"…","question":"…","answer":"…","status":"running",
  "createdAt":1792526277904,"updatedAt":1792526277904,
  "leafId":"…","followUps":[…]}}
{"type":"btw_delta","recordId":"…","delta":"Teiltext"}
```

`status`: `running | complete | cancelled | error | interrupted`.
Der `btw_record`-Frame kommt **vor** der HTTP-Antwort auf `btw`; HTTP und SSE
werden über `lib/btw.ts` gemerged, sodass ein älterer Snapshot keinen bereits
gestreamten Text zurücksetzt (`lib/btw.ts:47-138`). `btw_cancel` sendet
`{recordId}`; ein Fehler „Unknown command“ bedeutet: omp ist zu alt, und der
Client zeigt „requires a newer omp“ (`hooks/useBtw.ts:9-21`).

### 4.8 `extension_ui_request`: Replay, Auto-Approve, Cancel

Der Wrapper (`lib/rpc-manager.ts`, `handleFrame`/`extension_ui_request`):

- Nur blockierende Methoden werden gehalten: `select`, `confirm`, `input`,
  `editor`, `ask`, `open_url` (`lib/notification-events.ts:154`).
- Ein `confirm` mit Titel `/^allow tool\s*:/i` wird **nur** automatisch
  bestätigt, wenn die native Einstellung `tools.approval.extension = "allow"`
  aktiv ist (`trackExtensionUiRequest`). Andere Dialoge bleiben interaktiv.
- Ein Timeout aus dem Frame wird in `expiresAt` + Timer übersetzt; Ablauf
  entfernt den Dialog und widerruft die Benachrichtigung
  (`settlePendingUiRequest`).
- Beim Attach eines neuen SSE-Listeners werden alle offenen Requests mit
  **frischer** `web.sequence` erneut gesendet (`onEvent`).
  Damit überlebt ein Dialog einen Reconnect.
- Antwort per RPC `extension_ui_response` oder `POST /api/notifications/answer`
  (`answerExtensionUiRequest`, §6.4): Request wird vergessen, Frame an omp
  gesendet und lokal `{"type":"extension_ui_request","id":"cancel:<id>",
  "method":"cancel","targetId":"<id>"}` emittiert, damit andere Tabs den
  Dialog schließen.

Client (`handleExtensionUiRequest`, `respondToExtensionUi`,
`sendExtensionCustomInput`): `select/confirm/input/editor/ask`
öffnen den Dialog, `cancel` schließt nur, wenn dieser Tab den Request nicht
selbst gerade beantwortet (`locallyAnsweredDialogRef`), `open_url` öffnet nur
sichere Schemata und zeigt die URL als Notice, `notify`/`setStatus`/`setWidget`/
`setTitle`/`set_editor_text`/`custom` wirken auf die UI. Nach einer Antwort
bleibt das Panel 250 ms stehen, damit die nächste Frage nicht flackert.

Die Android-App weicht hier bewusst ab: `ExtensionUiController.respond` nimmt
den Dialog **im selben Tap** aus der UI (und markiert die id als beantwortet,
damit ein Replay ihn nicht wieder öffnet), sendet genau **eine**
`extension_ui_response` und stellt den Dialog nur bei einem fehlgeschlagenen
RPC wieder her (mit Fehler-Notice). Der Grund ist die Latenz: die Route
bestätigt die Antwort nicht — `extension_ui_response` ist fire-and-forget
(`lib/rpc-manager.ts` gibt den Frame nur an die Write-Queue von `sendFrame` und
liefert `null` zurück) — der Client wartet aber trotzdem eine volle Rundreise:
gemessen 1,1 s im LAN und mehrere Sekunden über Mobilfunk/Tunnel, bis zu
~120 s, wenn die Session dafür erst gestartet werden muss. Solange das Panel
stand, sah es unberührt aus und verschluckte jeden weiteren Done/Cancel-Tap
(nur `submittingId` blockte ihn), also drückte der Nutzer wiederholt. Die
Wiederherstellung bleibt in der Session, die gefragt hat (nach einem
Chat-Wechsel landet das alte Panel nicht im neuen Chat; ohne gebundene Session
wird gar nicht erst geclaimt) und unterbleibt nach `expiresAt`; ein
wiederhergestelltes Panel armiert den Expiry-Timer erneut.

Das Replay beim Attach ist für die App nur der zweite Weg: der Chat behält
seine Session-Subscription, während die Oberfläche die Bühne verlässt (Liste,
Rotation, Notification-Tap), deshalb replayt der Server in diesem Fall
**nichts** — ein `extension_ui_request`, der in der Zwischenzeit eintrifft, ist
die einzige Kopie im Client. `ExtensionUiController.bind(null)` trennt daher
nur die Oberfläche (Host-Consent, Clipboard-Scope), nicht die Panels:
Dialog/Status/Widgets/Terminal bleiben samt eigener Deadline im Controller und
sind beim Zurückkehren in dieselbe Session wieder da; ein `open_url`-Prompt,
der in der Zwischenzeit eintrifft, bleibt ebenfalls liegen und öffnet nie von
selbst. Erst `bind(<andere Session>)` wirft Dialoge **und** den Prompt weg, und
`reset()` (Logout, Serverwechsel, 401 sowie `ChatViewModel.onCleared`, wenn die
Activity stirbt) wipe't alles inklusive der beantworteten ids. Bis zu dieser
Änderung verwarf `bind(null)` die Panels; ein Ask, der während der Liste
eintraf, war beim Öffnen aus der Liste oder per Notification verloren (der
Tool-Aufruf lief weiter, das Panel fehlte).

`host_uri_request` wird auch ohne sichtbaren Chat beantwortet: der Controller
kennt die Session, deren Stream den Frame gebracht hat (`panelSession`), und
sendet `host_uri_result` dorthin — ein Clipboard-Read mit
`CLIPBOARD_READ_DENIED`, ein Write mit `CLIPBOARD_UNAVAILABLE_WRITE`, jede
andere Ressource mit `unknownHostUriResult`. Ein sichtbarer Chat fragt
stattdessen wie gewohnt nach der Lese-Erlaubnis. Ohne beides (kein Chat hat je
gebunden) wird der Frame nicht beantwortet — dann fehlt die Session, an die die
Antwort gehen könnte.

### 4.9 Live-Tool-Ergebnisse

Der Wrapper hält eine Live-Map pro `toolCallId` (`liveToolEvents` in
`handleFrame`):
`tool_execution_start/update` setzen/überschreiben den letzten Stand,
`tool_execution_end` löscht ihn; `message_end` eines `toolResult` löscht ihn
ebenfalls. `getStreamSnapshot().toolEvents` liefert die aktuelle Map
(`getStreamSnapshot`).

Client (`handleAgentEvent`, `tool_execution_*`):

1. `tool_execution_start` legt sofort eine laufende Zeile mit leerem Content an.
2. `_update` **ersetzt** den Partial-Content (omp sendet den vollständigen
   akkumulierten Stand, kein Delta).
3. `_end` hält das finale Ergebnis als nicht-`partial`, bis die committete
   `toolResult`-Nachricht eintrifft; die Zeile darf nicht leer aufblitzen.
4. Erst der gespeicherte `toolResult` entfernt den Live-Eintrag
   (`catchUp.history`). Ein Catch-up-Snapshot darf neuere
   Tool-Stände nicht löschen (`syncActionsRef.current.live`, Feld `tools`).

### 4.10 Session-Moves und Alias-IDs

omp kann eine Session beim ersten Schreiben auf eine neue Datei/ID verschieben
(omp ≥ 18.5 Ownership). Der Wrapper erkennt die `session-persistence`-Notice,
setzt `sessionMovePending` und fragt `get_state`; `applyIdentity` vollzieht den
Move. Danach:

- `_sessionId`/`_sessionFile` werden aktualisiert, die alte ID bleibt über
  `keepOldId: true` im Registry routbar (`applyIdentity`, Registry der
  `startRpcSession`-Einträge).
- `movedFromIds` wird als `aliases` an Benachrichtigungen gehängt, damit ein
  Tab, der noch die alte ID zeigt, nicht doppelt benachrichtigt wird
  (`publishNotifications` mit `movedFromIds`).
- Der Client folgt der Identität (`onIdentityChange`) und behält die alte ID
  als Alias, bis die neue überall angekommen ist.

Für HTTP-Aufrufe gilt: Solange der Wrapper lebt, funktionieren Kommandos unter
der alten ID weiter. `DELETE /api/sessions/<alte-id>` kann dagegen 404 liefern,
weil die Datei unter der neuen ID liegt; der Client muss die Session-Liste
nachziehen.

### 4.11 Abbrechen mit Queue-Restore, Shell-Degrade

**Abort** (`withdrawAndAbort`, aufgerufen von `handleAbort`):

1. `abort_and_restore_queue` wird bis zu zweimal versucht (ein Retry ist
   sicher, weil omp nur noch Vorhandenes zurückgibt).
2. Antwort `{steering:[{text,images?}],followUp:[…]}` → Texte/Bilder in den
   Draft zurücklegen; ein Teilverlust wird als Warnung gemeldet.
3. Meldet omp „Unknown command“ (älteres omp), Fallback:
   `remove_queued_message` für beide Queues parallel, maximal
   `WITHDRAW_BEFORE_ABORT_MS = 1500 ms` warten, dann `abort`.
   Ein bereits vom Modell übernommener Eintrag (`removed:false`) landet im
   Transkript und wird nicht zurückgeholt.
4. Alles ist an `runId` + `runsEnded` gefenced: Ein Stop darf nie einen
   inzwischen gestarteten Run treffen.
5. Läuft ein `!!`-Shell-Kommando, wird stattdessen `abort_bash` gesendet.
6. Ein `session_slow` mit `abortUnconfirmed` (Timeout = weder Stop noch Queue
   bekannt) beendet den Versuch: der Client zeigt eine Warnung, beendet den
   Run **nicht** lokal, legt keinen Draft aus einer Vermutung an, wiederholt
   den atomaren Versuch nicht (ein beschäftigtes Kind gewinnt keine zweite
   Wartezeit) und geht **nicht** auf den per-Eintrag-Fallback.

**`bashRunning`-Degrade** (`dispatchCommand`, `queueWhileShellRunning`):
Ein `prompt` oder `steer`, während omp-web ein `bash`-Kommando besitzt, wird
als `follow_up` an omp geschickt. Antwort:
`{"queued":true,"queue":"followUp","reason":"shellRunning"}`.
Der Client erkennt das (`hooks/useAgentSession-queue.ts:18-28`), entfernt die
optimistische Bubble und zeigt die Queue-Chips aus omp's `queue_update`; die
Nachricht läuft nach Ende des Shell-Kommandos. `excludeFromContext`
(`!!`) wird für das RPC-`bash` abgelehnt (`bash_exclude_unsupported`), damit
private Shell-Ausgaben nie in den Modellkontext gelangen.

### 4.12 Reconciliation und Settlement

- Während `agentRunning` pollt der Client `GET /api/agent/[id]` alle
  `AGENT_STATE_RECONCILE_MS = 15_000`, zusätzlich bei `visibilitychange`
  (sichtbar) und `online` (`reconcileAgentState`-`useEffect` im Hook,
  `hooks/useAgentSession-stream.ts:264`). Ein laufender Request wird
  über `reconcileGuardRef` koalesziert; nach Abschluss wird bei Bedarf
  nachgeholt (`reconcileAgentState`).
- Nach dem Senden wartet der Client auf den Run: erster Check nach 800 ms,
  dann alle 600 ms, maximal 20 s (`PROMPT_SETTLE_*`,
  `hooks/useAgentSession-stream.ts:261-263`).
- Nach `bash` pollt er den Bash-Zustand alle 1 s, bis er beendet ist
  (`BASH_STATE_RECONCILE_MS`, `waitForBashSettlement`).
- Ein terminales `message_end` plant genau einen Reconcile, damit ein
  verspäteter Abschluss nicht bis zum 15-s-Poll wartet
  (`terminalReconcileTimerRef` im `message_end`-Zweig von `handleAgentEvent`).
- `AGENT_STATE` ist authoritativ für Modell, Queue, Modi und Bash-Flags; ein
  älterer Snapshot wird über `authoritativeModelSeq`/`responseRunVersion`
  verworfen.

---

## 5. Context-Sync `/api/sessions/[id]/context`

### 5.1 Parameter

`GET /api/sessions/<id>/context` (`app/api/sessions/[id]/context/route.ts:26-71`):

| Parameter | Bedeutung |
|---|---|
| `sync=1` | aktiviert Paging; anderer Wert → `400 invalid_sync` |
| `cursor` | JSON `{"firstEntryId":string|null,"lastEntryId":string|null}`; max. 2048 Zeichen, IDs max. 256; ungültig → `400 invalid_sync_cursor` |
| `limit` | 1…200, Default 200; ungültig → `400 invalid_sync_limit` |
| `leafId` | Verlauf an diesem Ast-Knoten (Read-only-Ansicht) |
| `includePreCompaction` | Einträge vor der letzten Compaction mitlesen |
| `deferThinking` | Thinking-Blöcke weglassen |
| `deferMedia` | Tool-Result-Bilder als Medien-URLs/Platzhalter statt Base64 |
| `boundary=1` | nur die aktuellen Entry-IDs des aktiven Kontexts; kombinierte Optionen → `400 invalid_boundary_options` |

Quellen: `app/api/sessions/[id]/context/route.ts:26-71`,
`lib/session-sync.ts:52-74`.

### 5.2 Antwort

`SessionSyncResponse` (`lib/session-sync.ts:21-50`):

```json
{
  "mode": "append" | "replace",
  "baseEntryId": "…" | null,
  "context": { "messages": [...], "entryIds": [...], ... },
  "cursor": {"firstEntryId":"…","lastEntryId":"…"},
  "hasMore": false,
  "sessionId": "…",
  "leafId": "…" | null,
  "live": {
    "cursor": {"streamId":"…","sequence":42},
    "isStreaming": true,
    "isPromptRunning": true,
    "isCompacting": false,
    "streamingMessage": {...} | null,
    "toolEvents": [...],
    "responseObserved": true
  } | null
}
```

`live` wird **nach** dem Datei-Lesen abgetastet und nur für den aktuellen
`leafId` geliefert (`app/api/sessions/[id]/context/route.ts:100-113`).

### 5.3 Append/Replace-Regeln

`selectHistoryRange` (`lib/session-sync.ts:90-113`):

- `append` nur, wenn `cursor != null`, `cursor.firstEntryId === entryIds[0]`
  und `cursor.lastEntryId` noch vorhanden ist (oder beide leer).
- Sonst `replace` (Branches/Compaction haben den Verlauf invalidiert).
- `hasMore`, solange `end < entryIds.length`; `MAX_SYNC_MESSAGES = 200`.
- Client: Seiten sammeln, `append` nur anwenden, wenn
  `baseEntryId === letzter eigener Cursor`, sonst verwerfen und neu lesen;
  eine unvollständige Seite ersetzt nie den sichtbaren Verlauf
  (`hooks/useAgentSession-sync.ts:88-155`).

### 5.4 Fehlende Datei

Ist die Datei noch nicht geschrieben (nur `ensure_session` oder erster Prompt
läuft), aber der Wrapper lebt, liefert `sync=1` ohne Cursor einen leeren
Kontext + Live-Snapshot; `boundary=1` liefert `{"entryIds":[]}`. Ohne lebenden
Wrapper bleibt es bei `404 session_not_found`
(`app/api/sessions/[id]/context/route.ts:80-103`). Eine zu große Datei ist
`413 session_file_too_large` (`:10-18,87-96`).

### 5.5 Live-Snapshot anwenden

Der Client nimmt den Snapshot nur feldweise, wenn seine Sequenz mindestens so
hoch ist wie der jeweilige lokale Floor (`hooks/useAgentSession-sync.ts:138-170`).
Ist die `live.cursor.streamId` eine andere als die beobachtete, hat der
Wrapper neu gestartet → `subscribe(true)` (neue Epoche), nicht blind anwenden
(`:109-113`). Deferred Thinking/Media betrifft nur die Darstellung; die
persistente Datei bleibt vollständig.

---

## 6. Benachrichtigungen

### 6.1 Erkennung

`createNotificationDetector` (`lib/notification-events.ts:300-383`) läuft
serverseitig auf jedem Session-Frame:

| Auslöser | Ereignis |
|---|---|
| `session_settled` | `completed`, außer der letzte `prompt_result` war `error`/`aborted` |
| `prompt_error`, `process_exit` | `error` (einmal pro Run) |
| `prompt_result` mit `status:"error"` | `error`, sofern nicht schon gemeldet |
| `retry_fallback_applied` / `notice` aus `prewalk`/`plan-yolo` | `modelSwitch` |
| `extension_ui_request` mit blockierender Methode | `input` inkl. `requestId` und ggf. `dialog` |

`session_settled` ist der verlässliche „alles fertig“-Punkt (Run + gestartete
Hintergrundarbeit); `agent_end` allein genügt nicht.

`NotificationEvent` (`lib/notification-events.ts:39-61`):
`type: completed|input|error|modelSwitch|test`, `sessionId`, `sessionName`,
`detail?`, `from?`, `to?`, `aliases?`, `requestId?`, `dialog?`.
`NotificationDialog` trägt `requestId`, `method`, `title?`, `message?`,
`options?`, `questions?`, `placeholder?`, `expiresAt?`
(`lib/notification-events.ts:11-36`).

### 6.2 SSE-Frames

Über den `notifications`-Channel (§2.3):

```json
{"type":"notification","kind":"toast","event":{...}}
{"type":"notification","kind":"os","event":{...}}
{"type":"notification-dismiss","sessionId":"…","tag":"…:input","requestId":"…"}
```

`toast` = In-App-Toast im aktiven Tab, `os` = System-Notification im Tab,
`dismiss` = Widerruf einer Input-Benachrichtigung
(`lib/event-stream-hub.ts:290-303`).

### 6.3 REST

| Route | Methode | Body / Query | Antwort |
|---|---|---|---|
| `/api/notifications/devices` | `GET` | `?deviceId=` | `{publicKey, subscribed}` |
| `/api/notifications/devices` | `PUT` | `{deviceId, prefs, subscription?}` | `{subscribed}`; `400 invalid_device`/`invalid_subscription` |
| `/api/notifications/presence` | `POST` | `{clientId, deviceId, visible, sessionId, seq}` | `204`; `400 invalid_presence` |
| `/api/notifications/history` | `GET` | – | `{entries:[…]}` (neueste zuerst) |
| `/api/notifications/history` | `PATCH` | `{ids:[…]}` (max. 100) | `{ok:true}`; `400/413` |
| `/api/notifications/history` | `DELETE` | `?id=` oder `?all=1` | `{ok:true}` |
| `/api/notifications/answer` | `POST` | `{sessionId, requestId, response}` | `{status:"answered"\|"alreadySettled"\|"sessionGone"}`; `400/413` |
| `/api/notifications/test` | `POST` | `{deviceId}` | `204` oder `502 push_failed` |

Quellen: `app/api/notifications/devices/route.ts:9-26`,
`app/api/notifications/presence/route.ts:8-19`,
`app/api/notifications/history/route.ts:8-38`,
`app/api/notifications/answer/route.ts:9-75`,
`app/api/notifications/test/route.ts:11-15`.

`response` ist genau eines von:
`{value:string}`, `{confirmed:boolean}`, `{cancelled:true}`,
`{answers:RpcAskDialogAnswer[]}` (`app/api/notifications/answer/route.ts:19-38`).
`sessionGone` heißt: kein lebender Wrapper (auch nicht über Move-Aliase),
also nie einen Prozess nur zum Antworten starten.

### 6.4 Zustellung, Payload und Aufräumen

Vorlieben (`lib/notification-events.ts:64-78`):

```json
{"enabled":false,
 "types":{"completed":true,"input":true,"error":true,"modelSwitch":false},
 "whenActive":"toast",
 "locale":"en"}
```

Routing (`lib/notification-hub.ts:99-128`):

1. Ein sichtbarer Tab zeigt die Session (auch unter Alias) → **nichts**.
2. Ein aktiver, erreichbarer Tab vorhanden und Gerät will Toast → Toast nur
   an die aktiven Tabs dieses Geräts.
3. Sonst Push, wenn eine Subscription existiert; ohne Subscription In-Page-
   `os` an alle erreichbaren Tabs des Geräts.

Jedes Gerät wird vorher über `prefs.enabled` und `prefs.types[event.type]`
gefiltert; ein Gerät ohne Subscription und ohne erreichbaren Tab bekommt
nichts. Punkt 1 gilt geräteübergreifend und unabhängig von den Prefs.

Presence gilt 60 s nach dem letzten Report (`PRESENCE_TTL_MS`,
`lib/notification-hub.ts:18-19`). Der Stream selbst ist „reachable“.

Push-Payload (`lib/notification-hub.ts:170-182`, `lib/notification-events.ts:96-134`):

```json
{
  "title":"Sessionname",
  "body":"…",
  "url":"/?session=<id>",
  "tag":"<sessionId>:<type>",
  "sessionId":"…",
  "type":"completed|input|error|modelSwitch|test",
  "requestId":"…",
  "dialog":{...}
}
```

`title` max. 100 Zeichen, `body` max. 180, `tag` ersetzt eine ältere
Benachrichtigung derselben Session/Art. `urgency` ist `high` für `input` und
`error`, sonst `normal` (`lib/notification-hub.ts:172-182`).

Dismiss (`publishNotificationDismiss`, `lib/notification-hub.ts:245-279`):
markiert den History-Eintrag als gelesen, sendet `notification-dismiss` an
erreichbare Tabs von Geräten mit `types.input` und einen Push
`{type:"dismiss",tag,sessionId,requestId}` — **außer** an Apple-Endpoints
(`web.push.apple.com`), weil iOS die
Push-Erlaubnis entzieht, wenn ein Push nichts anzeigt
(`lib/notification-hub.ts:184-197`). Der Tag ist immer `<sessionId>:input`.

Speichergrenzen: max. 50 Geräte, 100 History-Einträge; Subscriptions nur
HTTPS, `p256dh`/`auth` werden formal geprüft
(`lib/notification-store.ts:22-23,38-49`). Test-Push geht nur an ein Gerät
mit Subscription (`lib/notification-hub.ts:281-286`).

---

## 7. Aufgezeichnete Fixtures

### 7.1 Aufnahme

Aufgenommen wurde gegen einen laufenden Dev-Server mit einem lokalen,
nicht versionierten Rekorder. Der Rekorder meldet sich mit dem Web-Passwort
an, legt pro Szenario eine Session unter `~/omp-cwd-android-fixtures` an,
abonniert den `session`-Channel und fährt die RPC-Aufrufe. Die Session- und
Message-IDs in den Fixtures sind synthetisch.

Format je Datei: eine Header-Zeile, danach pro Zeile ein rohes SSE-`data`-
Payload; RPC-Aufrufe stehen als
`{"_rpc":{"method","path","body"},"_response":{...}}` dazwischen. Cookies und
Session-Header werden nicht geschrieben; alle Varianten des Home-Verzeichnisses
werden durch `~` ersetzt. Jede Zeile ist eigenständiges JSON (NDJSON).

Die Aufnahme lief mit **omp 18.12.4** (Binary auf der Maschine aktualisiert;
der Dev-Server selbst wurde nicht neu gestartet, neue Kinder nutzen das neue
Binary). Deshalb enthalten die Btw-Fixtures die 18.12.4-Frames
`btw_record`/`btw_delta` (und zusätzlich `advisor_yielded`, das der Client
ignoriert).

### 7.2 Dateien

`android/app/src/test/resources/protocol/`:

| Datei | Zeilen | Szenario | Kern-Frames |
|---|---:|---|---|
| `plain-text.ndjson` | 22 | Prompt → Textantwort | `agent_start`, `message_*`, `agent_end`, `session_settled` |
| `tool-call.ndjson` | 56 | `bash` mit `echo fixture` | `tool_execution_start/update/end`, committeter `toolResult`, `turn_end` |
| `abort-mid-run.ndjson` | 24 | Abort während des Streams | 4× `message_update`, `abort`-RPC, `agent_end`, `prompt_result status=aborted` |
| `queued-follow-up-removed.ndjson` | 24 | Follow-up während des Runs, dann entfernt | 2× `queue_update`, `remove_queued_message`, `abort`, `prompt_result` |
| `btw-side-question.ndjson` | 27 | `/btw` nach einem Turn | `btw_record` (running) → `btw_delta` → `btw_record` (complete) |
| `get-state.ndjson` | 23 | `get_state` nach einem Turn | `_rpc` mit vollständigem `WebSessionState` |
| `reconnect-resubscribe.ndjson` | 26 | Stream schließen, neu verbinden, resubscriben | zwei `hello`/`open`/`connected`, gleiche `streamId`, Cursor 3 → 23 |

Die sechs vom Auftrag geforderten Szenarien sind enthalten; die siebte Datei
dokumentiert zusätzlich das Reconnect-Verhalten.

### 7.3 Was die Fixtures nicht enthalten

- Keine Cookies, Session-Header, Passwörter oder absoluten Home-Pfade.
- Kein interner Agent-System-Prompt: `systemPrompt` in
  `get-state.ndjson` ist durch den Marker `"<redacted system prompt>"`
  ersetzt; das Feld bleibt erhalten, damit der Client fehlende oder
  redigierte Prompts toleriert.
- Keine Binärdaten/Bilder; Bildpfade sind nicht Teil der Szenarien.
- Keine Server-internen IDs; Session- und Message-IDs sind synthetisch.
