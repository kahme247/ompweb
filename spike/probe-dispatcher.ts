// Probe 6: lib/http-dispatcher.ts (undici EnvHttpProxyAgent + undici.install) under Bun,
// and whether Bun's own fetch honors HTTP_PROXY. Mode = argv[2]: "dispatcher" | "native".
const mode = process.argv[2] ?? "dispatcher";
const upstream = `http://127.0.0.1:${process.env.SPIKE_PORT ?? 30311}/spike-upstream`;
const proxyHits: string[] = [];
// Minimal forward proxy: answers absolute-form requests itself and records them.
const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { proxyHits.push(req.url); return new Response(`via-proxy ${req.url}`); } });
const bunFetch = globalThis.fetch;
if (mode === "dispatcher") {
  const { configureHttpDispatcher } = await import("../lib/http-dispatcher");
  configureHttpDispatcher();
  console.log(`globalThis.fetch replaced by undici: ${globalThis.fetch !== bunFetch}`);
}
const direct = await fetch(upstream);
console.log(`[${mode}] direct fetch ${upstream}: ${direct.status} ${await direct.text()}`);
process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
process.env.NO_PROXY = "";
if (mode === "dispatcher") {
  // EnvHttpProxyAgent reads env at construction: rebuild it with the proxy env set.
  (globalThis as { __ompWebHttpDispatcherConfigured?: boolean }).__ompWebHttpDispatcherConfigured = false;
  const { configureHttpDispatcher } = await import("../lib/http-dispatcher");
  configureHttpDispatcher();
}
try {
  const viaEnv = await fetch("http://spike.invalid/x");
  console.log(`[${mode}] fetch http://spike.invalid/x with HTTP_PROXY set: ${viaEnv.status} ${await viaEnv.text()}`);
} catch (e) {
  console.log(`[${mode}] fetch with HTTP_PROXY set: FAIL ${e instanceof Error ? e.message : e}`);
}
console.log(`[${mode}] proxy saw: ${JSON.stringify(proxyHits)}`);
proxy.stop(true);
