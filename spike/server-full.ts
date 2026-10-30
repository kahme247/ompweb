// Probe 11b: same server, plus the SPA as a Bun HTML import so `bun build --compile` embeds the UI.
import index from "./index.html";

(globalThis as { __spikeIndex?: Bun.HTMLBundle }).__spikeIndex = index;
// Dynamic: server.ts reads the global at top level, so it must evaluate after the assignment above.
await import("./server");
