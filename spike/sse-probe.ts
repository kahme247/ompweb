// Probe 1d: /api/events SSE on Bun — hello, subscribe, live delivery, heartbeat past
// Bun's 10s idle default, and server-side cleanup when the client aborts.
const B = `http://127.0.0.1:${process.env.SPIKE_PORT ?? 30311}`;
const ac = new AbortController();
const res = await fetch(`${B}/api/events`, { signal: ac.signal });
console.log("GET /api/events", res.status, res.headers.get("content-type"));
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = "";
const t0 = Date.now();
async function next(match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!match.test(buf)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${match}; got ${JSON.stringify(buf.slice(-300))}`);
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value);
  }
  const m = buf.match(match)!;
  buf = buf.slice(m.index! + m[0].length);
  return m[0];
}
const hello = await next(/event: mux\ndata: (.*)\n\n/, 5000);
const connectionId = JSON.parse(hello.split("data: ")[1]).connectionId;
console.log(`hello after ${Date.now() - t0}ms connectionId=${connectionId}`);
const post = (body: unknown) => fetch(`${B}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sub = await post({ connectionId, subscribe: { id: "s1", channel: { kind: "hosts" } } });
console.log("POST subscribe", sub.status, await sub.text());
console.log("first s1 frame:", (await next(/event: s1\ndata: .*\n\n/, 5000)).slice(0, 120).replace(/\n/g, "\\n"));
const created = await fetch(`${B}/api/hosts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "spike-host" }) });
const t1 = Date.now();
console.log("POST /api/hosts", created.status);
const live = await next(/event: s1\ndata: .*spike-host.*\n\n/, 5000);
console.log(`live hosts frame after ${Date.now() - t1}ms (${live.length}B)`);
if (process.env.SPIKE_HEARTBEAT) {
  await next(/^:\n\n|\n:\n\n/, 40_000);
  console.log(`heartbeat received, stream still open at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
ac.abort();
await Bun.sleep(300);
const after = await post({ connectionId, subscribe: { id: "s2", channel: { kind: "hosts" } } });
console.log("POST subscribe after client abort", after.status, await after.text());
