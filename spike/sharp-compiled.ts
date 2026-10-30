// Probe 11c: does sharp's native addon load inside a `bun build --compile` binary?
import { readFileSync } from "node:fs";
import { createThumbnail } from "../lib/media-cache";

const png = readFileSync(process.argv[2]!);
const thumb = await createThumbnail("spikehash1111111111111111111111111111111111111111111111111111111", png);
console.log(`thumbnail: ${thumb ? `${thumb.length}B ${thumb.subarray(0, 4).toString()}` : "null (sharp unavailable)"}`);
