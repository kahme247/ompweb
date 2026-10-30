// Probe 2: bearer-gated WebSocket on /spike-link. Runs unchanged under Bun and Node.
//   bun spike/ws-probe.mjs | node spike/ws-probe.mjs | node spike/ws-probe.mjs undici
const url = `ws://127.0.0.1:${process.env.SPIKE_PORT ?? 30311}/spike-link`;
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;
const WS = process.argv[2] === "undici" ? (await import("undici")).WebSocket : globalThis.WebSocket;
const label = `${runtime}${process.argv[2] === "undici" ? " (undici WebSocket)" : " (global WebSocket)"}`;

function open(init) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url, init);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`error: ${e.message ?? e.type}`));
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
}
const nextMessage = (ws) => new Promise((resolve) => { ws.onmessage = (e) => resolve(e.data); });

// 1. No token: must be refused before the upgrade.
try {
  (await open(undefined)).close();
  console.log(`${label}: UNAUTHENTICATED CONNECT SUCCEEDED (bad)`);
} catch (e) {
  console.log(`${label}: no-token connect refused (${e.message})`);
}

// 2. Token in the Authorization header (non-standard WebSocket init).
let ws;
try {
  ws = await open({ headers: { Authorization: "Bearer x" } });
} catch (e) {
  console.log(`${label}: header-auth connect FAILED (${e.message}) — this WebSocket cannot send headers`);
  process.exit(0);
}
ws.onclose = null;
ws.onerror = null;
console.log(`${label}: header-auth connect ok`);

ws.send("hello");
const text = await nextMessage(ws);
ws.send(new Uint8Array([1, 2, 3]));
const bin = await nextMessage(ws);
console.log(`${label}: text echo ${JSON.stringify(text)} (${typeof text}), binary echo ${bin instanceof ArrayBuffer ? `ArrayBuffer[${new Uint8Array(bin)}]` : typeof bin}`);

const N = 1000;
let t = performance.now();
for (let i = 0; i < N; i++) {
  const p = nextMessage(ws);
  ws.send(`{"seq":${i}}`);
  await p;
}
const rtt = (performance.now() - t) / N;
console.log(`${label}: ${N} sequential round-trips, mean RTT ${(rtt * 1000).toFixed(0)}µs`);

const big = new Uint8Array(20 * 1024 * 1024);
for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
t = performance.now();
const p = nextMessage(ws);
ws.send(big);
const back = new Uint8Array(await p);
const ms = performance.now() - t;
const ok = back.length === big.length && back[4096 * 7] === big[4096 * 7];
console.log(`${label}: 20 MiB binary echo ${ok ? "intact" : "CORRUPT"} in ${ms.toFixed(0)}ms (${((2 * 20) / (ms / 1000)).toFixed(0)} MiB/s both directions)`);
ws.close();
