import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import sharp from "sharp";

// Real GET /api/media/[hash] against a throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-media-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const route = await import("../app/api/media/[hash]/route.ts");
const { eventWithToolResultImageUrls } = await import("./media-cache.ts");

const blobs = join(agentDir, "blobs");
const media = join(agentDir, "omp-web", "media");
mkdirSync(blobs, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const get = (hash, query = "") => route.GET(new Request(`http://localhost/api/media/${hash}${query}`), { params: Promise.resolve({ hash }) });

const screenshot = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#336699" } }).png().toBuffer();
const screenshotHash = sha(screenshot);
writeFileSync(join(blobs, screenshotHash), screenshot);

test("serves the full image with its real type, and a small cached WebP preview", async () => {
  const full = await get(screenshotHash);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), screenshot);

  const thumb = await get(screenshotHash, "?thumb=1");
  assert.equal(thumb.headers.get("content-type"), "image/webp");
  const bytes = Buffer.from(await thumb.arrayBuffer());
  const { width, height } = await sharp(bytes).metadata();
  assert.deepEqual([width, height], [480, 300]);
  assert.ok(bytes.length < screenshot.length);
  assert.ok(existsSync(join(media, `${screenshotHash}.thumb.webp`)), "preview is generated once and kept");
});

test("previews are reused and follow EXIF orientation", async () => {
  // Cached: served even after the source is gone.
  const portrait = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#123456" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const hash = sha(portrait);
  writeFileSync(join(blobs, hash), portrait);
  const first = Buffer.from(await (await get(hash, "?thumb=1")).arrayBuffer());
  const { width, height } = await sharp(first).metadata();
  assert.deepEqual([width, height], [240, 480], "a phone photo stays upright in the preview");
  rmSync(join(blobs, hash));
  const again = await get(hash, "?thumb=1");
  assert.equal(again.status, 200);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), first);
});

test("never serves non-images or files outside the store", async () => {
  const text = Buffer.from("data:text/html,<script>alert(1)</script>");
  writeFileSync(join(blobs, sha(text)), text);
  assert.equal((await get(sha(text))).status, 415);
  assert.equal((await get(sha(text), "?thumb=1")).status, 415);
  // A real image one level up must stay unreachable however the name is spelled.
  writeFileSync(join(agentDir, "secret.png"), screenshot);
  for (const name of ["../secret.png", "..%2Fsecret.png", `../blobs/${screenshotHash}`, `${screenshotHash}.png`, screenshotHash.toUpperCase()]) {
    assert.equal((await get(name)).status, 404, name);
  }
});

test("live tool output is served from omp-web's copy until omp has written the whole blob", async () => {
  const live = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const hash = sha(live);
  const event = {
    type: "tool_execution_end",
    toolCallId: "t1",
    result: { content: [{ type: "text", text: "Screenshot captured" }, { type: "image", data: live.toString("base64"), mimeType: "image/png" }] },
  };
  const rewritten = eventWithToolResultImageUrls(event);
  assert.deepEqual(rewritten.result.content[1], { type: "image", mimeType: "image/png", url: `/api/media/${hash}` });
  assert.equal(event.result.content[1].data, live.toString("base64"), "omp's frame is not mutated");
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);

  // omp writes blobs in place: a half-written blob must not be served (as immutable).
  writeFileSync(join(blobs, hash), live.subarray(0, 40));
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);

  writeFileSync(join(blobs, hash), live);
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);
  // The daily sweep drops the copy omp now holds; it runs on the next write.
  globalThis.__ompWebMediaSweptAt = 0;
  eventWithToolResultImageUrls({ type: "tool_execution_end", result: { content: [{ type: "image", data: Buffer.from("other").toString("base64") }] } });
  assert.equal(existsSync(join(media, hash)), false);
});

test("a live image arriving while omp is still writing its blob is kept and served whole", async () => {
  const live = await sharp({ create: { width: 48, height: 48, channels: 3, background: "#00ff00" } }).png().toBuffer();
  const hash = sha(live);
  writeFileSync(join(blobs, hash), live.subarray(0, 30));
  eventWithToolResultImageUrls({ type: "tool_execution_end", result: { content: [{ type: "image", data: live.toString("base64") }] } });
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);
});

test("an image seen again after its copy was swept is stored again", async () => {
  const live = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#0000ff" } }).png().toBuffer();
  const hash = sha(live);
  const frame = () => eventWithToolResultImageUrls({ type: "tool_execution_end", result: { content: [{ type: "image", data: live.toString("base64") }] } });
  frame();
  rmSync(join(media, hash));
  frame();
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);
});

test("tool-result images become URLs in every event that carries them, and only there", () => {
  const image = { type: "image", data: Buffer.from("event image").toString("base64"), mimeType: "image/png" };
  const url = `/api/media/${sha(Buffer.from("event image"))}`;
  const toolResult = { role: "toolResult", toolCallId: "t", content: [image] };
  const user = { role: "user", content: [image] };
  const asUrl = [{ type: "image", mimeType: "image/png", url }];

  assert.deepEqual(eventWithToolResultImageUrls({ type: "message_start", message: toolResult }).message.content, asUrl);
  assert.deepEqual(eventWithToolResultImageUrls({ type: "message_end", message: user }).message, user, "user images stay inline");
  const turn = eventWithToolResultImageUrls({ type: "turn_end", message: user, toolResults: [toolResult] });
  assert.deepEqual(turn.toolResults[0].content, asUrl);
  assert.equal(turn.message, user);
  const end = eventWithToolResultImageUrls({ type: "agent_end", messages: [user, toolResult] });
  assert.equal(end.messages[0], user);
  assert.deepEqual(end.messages[1].content, asUrl);
  const sub = eventWithToolResultImageUrls({ type: "subagent_event", payload: { id: "Child", event: { type: "tool_execution_end", result: { content: [image] } } } });
  assert.equal(sub.payload.id, "Child");
  assert.deepEqual(sub.payload.event.result.content, asUrl, "a subagent's screenshot is not streamed as base64 either");
  const plain = { type: "agent_end", messages: [user] };
  assert.equal(eventWithToolResultImageUrls(plain), plain, "events without tool images are passed through as-is");
});
