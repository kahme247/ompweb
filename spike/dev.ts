// Probe 9b: Bun's HTML-import dev server (on-demand bundling + HMR) for the SPA. API calls proxy to the spike server.
import index from "./index.html";

const api = `http://127.0.0.1:${process.env.SPIKE_PORT ?? 30311}`;
const server = Bun.serve({
  port: Number(process.env.SPIKE_DEV_PORT ?? 30313),
  hostname: "127.0.0.1",
  development: { hmr: true, console: true },
  routes: { "/": index },
  fetch: (req) => {
    const url = new URL(req.url);
    return fetch(api + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
  },
});
console.log(`spike dev server on ${server.url}`);
