// Host end of the maintenance API (maintenance-protocol.ts): dials the server's /api/hosts/maintenance with the host's
// bearer token and answers its requests through `deps.handleRequest`. Independent of the application link
// (daemon-link.ts): its own socket and redial loop, and nothing it meets (a server without this API, another API version,
// a refused token) ever stops the daemon or its omp children. Node-only, relative imports.
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "../type-guards";
import {
  decodeFrame,
  encodeFrame,
  failure,
  MAINTENANCE_API_VERSION,
  MAINTENANCE_CLOSE,
  MAINTENANCE_LIMITS,
  MAINTENANCE_PATH,
  MaintenanceError,
  maintenanceTimings,
  PONG,
  type MaintenanceHello,
  type MaintenanceOp,
} from "./maintenance-protocol";

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Each wait varies ±20% so many hosts do not redial in step.
const withJitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface MaintenanceDeps {
  /** The host's hello, built on every dial; its apiVersion is overridden with this API's. */
  hello(): MaintenanceHello;
  /** Runs one request. Throw an error with a `status` or `httpStatus` (400..599) and a lowercase `code` (HostOpError, HostUpdateError) to answer with them. */
  handleRequest(op: MaintenanceOp, args: Record<string, unknown>): Promise<unknown>;
  log(text: string): void;
  /** Called before each redial, like the application link's reload. */
  reload?(): void;
  /** The link came up (welcomed) or went down. */
  onState?(up: boolean): void;
}

/** How a dial ended. `linked`: the server welcomed it. `code`: the server's close code, 0 when this side ended it. */
interface Closed {
  linked: boolean;
  code: number;
  reason: string;
}

export class DaemonMaintenance {
  private token: string;
  private stopped = false;
  private loop: Promise<void> | null = null;
  /** Ends the dial in progress (its probe or its socket). */
  private cancel: (() => void) | null = null;
  private readonly abort = new AbortController();
  private lastLog = "";

  constructor(private readonly login: { url: string; token: string }, private readonly deps: MaintenanceDeps) {
    this.token = login.token;
  }

  start(): void {
    if (!this.loop && !this.stopped) this.loop = this.run();
  }

  /** Ends the redial wait, the dial and the socket; replies of requests still running are dropped. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.cancel?.();
    await this.loop;
  }

  /** The token changed: redial with it. */
  rekey(token: string): void {
    this.token = token;
    this.cancel?.();
  }

  private say(text: string): void {
    if (text === this.lastLog) return;
    this.lastLog = text;
    this.deps.log(text);
  }

  private async run(): Promise<void> {
    let delay = maintenanceTimings.retryMs;
    while (!this.stopped) {
      try {
        const closed = await this.connect();
        if (this.stopped) return;
        if (closed.linked) delay = maintenanceTimings.retryMs;
        // Another API, another host holding the token: dialing again soon changes nothing.
        if (closed.code === MAINTENANCE_CLOSE.apiMismatch || closed.code === MAINTENANCE_CLOSE.replaced) delay = maintenanceTimings.retryMaxMs;
        this.say(`maintenance link ${closed.linked ? "lost" : "unavailable"} (${closed.reason || `code ${closed.code}`}); redialing`);
        this.deps.reload?.();
      } catch (error) {
        if (this.stopped) return;
        this.say(`maintenance link lost (${reason(error)}); redialing`);
      }
      if (this.stopped) return;
      await sleep(withJitter(delay), undefined, { signal: this.abort.signal }).catch(() => {});
      delay = Math.min(delay * 2, maintenanceTimings.retryMaxMs);
    }
  }

  /** One dial: discovery, then the socket until it closes. */
  private async connect(): Promise<Closed> {
    const serverUrl = this.login.url.replace(/\/+$/, "") + MAINTENANCE_PATH;
    const authorization = `Bearer ${this.token}`;
    const attempt = new AbortController();
    this.cancel = () => attempt.abort();
    const unavailable = await this.discover(serverUrl, authorization, attempt.signal);
    // Stopped or rekeyed meanwhile: not the server's answer.
    if (attempt.signal.aborted) return { linked: false, code: 0, reason: "cancelled" };
    if (unavailable) return unavailable;
    return this.dial(serverUrl.replace(/^http/, "ws"), authorization);
  }

  /**
   * GET the endpoint first: only a server that answers 200 `{apiVersion: 1}` (to this token) is sent a hello. A missing
   * endpoint, a page, a 426 or another version is not this API, and an old server may accept any WebSocket URL and
   * mistake the hello for application traffic. Null when the server speaks API 1.
   */
  private async discover(url: string, authorization: string, signal: AbortSignal): Promise<Closed | null> {
    let response: Response;
    try {
      response = await fetch(url, { headers: { authorization }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(maintenanceTimings.helloMs)]) });
    } catch (error) {
      return { linked: false, code: 0, reason: reason(error) };
    }
    let body: unknown = null;
    if (response.status === 200) {
      try {
        body = JSON.parse(await response.text());
      } catch {
        // A page, or the read was cut: not this API.
      }
    } else void response.body?.cancel().catch(() => {});
    if (isRecord(body) && body.apiVersion === MAINTENANCE_API_VERSION) return null;
    // A refused token or an unavailable server may be fixed by the next dial; anything else is not API 1.
    const transient = response.status === 401 || response.status >= 500;
    const why = response.status === 401 ? "the server refused this host's token" : `the server has no maintenance API ${MAINTENANCE_API_VERSION}`;
    return { linked: false, code: transient ? 0 : MAINTENANCE_CLOSE.apiMismatch, reason: `${why} (HTTP ${response.status})` };
  }

  /** One socket from dial to close. */
  private dial(url: string, authorization: string): Promise<Closed> {
    const { promise, resolve } = Promise.withResolvers<Closed>();
    const hello = this.deps.hello();
    const advertised = new Set<string>(hello.capabilities);
    const helloLine = encodeFrame({ ...hello, type: "hello", apiVersion: MAINTENANCE_API_VERSION });
    // This repo's DOM typing has no init argument; Node's and Bun's WebSocket take `{ headers }`.
    const ws = new WebSocket(url, { headers: { authorization } } as unknown as string[]);
    const active = new Set<string>();
    let linked = false;
    let done = false;
    let watchdog: NodeJS.Timeout | undefined;
    // Once ended, a socket stays inert: every handler below ignores it.
    const end = (code: number, why: string) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      this.cancel = null;
      if (linked) this.deps.onState?.(false);
      resolve({ linked, code, reason: why });
    };
    const giveUp = (why: string) => {
      end(0, why);
      ws.close();
    };
    this.cancel = () => giveUp("cancelled");
    // The server pings every pingMs: silence for offlineMs is a dead link.
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => giveUp("no traffic from the server"), maintenanceTimings.offlineMs);
      watchdog.unref?.();
    };
    alive();

    const reply = (id: string, body: object) => {
      if (done) return;
      try {
        ws.send(encodeFrame({ type: "res", id, ...body }));
      } catch (error) {
        // An oversized or unserializable result: say so. A closed socket: the server saw the link drop.
        try {
          ws.send(encodeFrame({ type: "res", id, ok: false, ...failure(error) }));
        } catch {
          // Closed.
        }
      }
    };
    const request = (frame: Record<string, unknown>) => {
      const { id, op, args } = frame;
      if (typeof id !== "string" || !REQUEST_ID.test(id)) return giveUp("invalid request id");
      const answer = async (): Promise<object> => {
        if (typeof op !== "string" || !advertised.has(op)) throw new MaintenanceError(501, "unsupported_op", "Unsupported maintenance operation");
        if (!isRecord(args)) throw new MaintenanceError(400, "bad_request", "A request's args must be an object");
        if (active.has(id)) throw new MaintenanceError(409, "duplicate_request", "A request with this id is running");
        if (active.size >= MAINTENANCE_LIMITS.inFlight) throw new MaintenanceError(429, "busy", "Too many maintenance requests are running");
        active.add(id);
        try {
          return { ok: true, result: (await this.deps.handleRequest(op as MaintenanceOp, args)) ?? null };
        } finally {
          active.delete(id);
        }
      };
      void answer().catch((error: unknown) => ({ ok: false, ...failure(error) })).then((body) => reply(id, body));
    };
    const onFrame = (data: unknown) => {
      const frame = decodeFrame(data);
      if (frame.type === "ping") ws.send(PONG);
      else if (frame.type === "welcome") {
        if (frame.apiVersion !== MAINTENANCE_API_VERSION) return giveUp(`the server's maintenance API is ${String(frame.apiVersion)}`);
        linked = true;
        this.lastLog = "";
        this.deps.onState?.(true);
      } else if (frame.type === "req") {
        if (linked) request(frame);
        else giveUp("request before welcome");
      }
    };

    ws.onopen = () => {
      if (!done) ws.send(helloLine);
    };
    ws.onmessage = ({ data }: MessageEvent) => {
      if (done) return;
      alive();
      try {
        onFrame(data);
      } catch (error) {
        giveUp(reason(error));
      }
    };
    ws.onclose = (event) => end(event.code, event.reason);
    return promise;
  }
}
