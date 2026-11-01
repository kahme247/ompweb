import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

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

// public/icon-192.png scaled to any size: a real PNG without a native image dependency.
const sourceIcon = await Bun.file("public/icon-192.png").bytes();
const png = async (width, height) => Buffer.from(await new Bun.Image(sourceIcon).resize(width, height, { fit: "fill" }).png().bytes());
const dimensions = async (bytes) => {
  const { width, height } = await new Bun.Image(bytes).metadata();
  return [width, height];
};

const screenshot = await png(1600, 1000);
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
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF");
  assert.deepEqual(await dimensions(bytes), [480, 300]);
  assert.ok(bytes.length < screenshot.length);
  assert.ok(existsSync(join(media, `${screenshotHash}.thumb.webp`)), "preview is generated once and kept");
});

/** `jpeg` with an EXIF APP1 segment (big-endian TIFF, one Orientation entry) right after SOI. */
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), header, body, jpeg.subarray(2)]);
}

test("previews are never enlarged and keep the aspect ratio", async () => {
  const wide = await png(800, 400);
  writeFileSync(join(blobs, sha(wide)), wide);
  assert.deepEqual(await dimensions(Buffer.from(await (await get(sha(wide), "?thumb=1")).arrayBuffer())), [480, 240]);
});

test("previews are reused and follow EXIF orientation", async () => {
  // Cached: served even after the source is gone.
  const plain = Buffer.from(await new Bun.Image(sourceIcon).resize(40, 20, { fit: "fill" }).jpeg().bytes());
  const portrait = withExifOrientation(plain, 6);
  const hash = sha(portrait);
  writeFileSync(join(blobs, hash), portrait);
  const first = Buffer.from(await (await get(hash, "?thumb=1")).arrayBuffer());
  assert.deepEqual(await dimensions(first), [20, 40], "a phone photo stays upright in the preview");
  rmSync(join(blobs, hash));
  const again = await get(hash, "?thumb=1");
  assert.equal(again.status, 200);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), first);
});

test("a source that is not an image gets no preview", async () => {
  const { createThumbnail } = await import("./media-cache.ts");
  assert.equal(await createThumbnail(sha(Buffer.from("x")), Buffer.from("not an image")), null);
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
  const live = await png(64, 64);
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
  const live = await png(48, 48);
  const hash = sha(live);
  writeFileSync(join(blobs, hash), live.subarray(0, 30));
  eventWithToolResultImageUrls({ type: "tool_execution_end", result: { content: [{ type: "image", data: live.toString("base64") }] } });
  assert.deepEqual(Buffer.from(await (await get(hash)).arrayBuffer()), live);
});

test("an image seen again after its copy was swept is stored again", async () => {
  const live = await png(40, 40);
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
