import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./image-attachments.ts");
}

const image = { type: "image", mimeType: "image/png", data: "YWJj" };

/** Base64 payload decoding to exactly `bytes`. */
function imageOfBytes(bytes) {
  const wholeTriplets = Math.floor(bytes / 3);
  const remainder = bytes % 3;
  const suffix = remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "";
  return { type: "image", mimeType: "image/png", data: `${"AAAA".repeat(wholeTriplets)}${suffix}` };
}

test("calculates padded base64 byte lengths and rejects invalid data", async () => {
  const { getBase64DecodedByteLength } = await loadSubject();

  assert.equal(getBase64DecodedByteLength("YQ=="), 1);
  assert.equal(getBase64DecodedByteLength("YWI="), 2);
  assert.equal(getBase64DecodedByteLength("YWJj"), 3);
  assert.equal(getBase64DecodedByteLength("not base64!"), null);
});

test("rejects invalid, oversized, and too many image attachments", async () => {
  const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, validateAgentImages } = await loadSubject();
  const oversizedData = "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3));

  assert.equal(validateAgentImages([image]), null);
  assert.match(validateAgentImages([{ ...image, mimeType: "text/plain" }]), /valid base64 image/);
  assert.match(validateAgentImages([{ ...image, data: oversizedData }]), /5MB or smaller/);
  assert.match(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image)), /at most/);
});

test("accepts several screenshots that stay inside the aggregate budget", async () => {
  const { MAX_TOTAL_ATTACHED_IMAGE_BYTES, validateAgentImages, validateOutgoingPrompt } = await loadSubject();
  const images = Array.from({ length: 4 }, () => imageOfBytes(MAX_TOTAL_ATTACHED_IMAGE_BYTES / 8));

  assert.equal(validateAgentImages(images), null);
  assert.equal(validateOutgoingPrompt("Compare these screenshots", images), null);
});

test("rejects images that individually fit but together exceed the aggregate budget", async () => {
  const { MAX_ATTACHED_IMAGE_BYTES, MAX_TOTAL_ATTACHED_IMAGE_BYTES, validateAgentImages, validateOutgoingPrompt } = await loadSubject();
  const half = imageOfBytes(MAX_ATTACHED_IMAGE_BYTES * 0.6);
  const images = [half, half];

  assert.equal(validateAgentImages([half]), null, "each image alone is within the per-image cap");
  assert.match(validateAgentImages(images), /total 5MB or less/);
  assert.match(validateOutgoingPrompt("two big shots", images), /total 5MB or less/);
  assert.ok(MAX_ATTACHED_IMAGE_BYTES <= MAX_TOTAL_ATTACHED_IMAGE_BYTES);
});

test("rejects a prompt whose JSON body would exceed the agent request cap", async () => {
  const { MAX_AGENT_COMMAND_REQUEST_BYTES, MAX_TOTAL_ATTACHED_IMAGE_BYTES, getAgentRequestByteLength, validateOutgoingPrompt } = await loadSubject();
  const images = [imageOfBytes(MAX_TOTAL_ATTACHED_IMAGE_BYTES)];
  // Base64 inflates the aggregate image budget to ~6.7 MiB, so the remaining
  // headroom for text is well under the request cap.
  const withinBudget = "x".repeat(1024);
  const overBudget = "x".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES);

  assert.ok(getAgentRequestByteLength(withinBudget, images) > MAX_TOTAL_ATTACHED_IMAGE_BYTES);
  assert.equal(validateOutgoingPrompt(withinBudget, images), null);
  assert.match(validateOutgoingPrompt(overBudget, images), /too large to send/);
  assert.match(validateOutgoingPrompt(overBudget), /too large to send/);
});

test("validates the expanded web slash prompt rather than its shorter command text", async () => {
  const { MAX_AGENT_COMMAND_REQUEST_BYTES, validateOutgoingPrompt } = await loadSubject();
  const { expandWebSlashCommand } = await import("./web-slash-commands.ts");
  const commandPrefix = "/goal ";
  const raw = `${commandPrefix}${"x".repeat(MAX_AGENT_COMMAND_REQUEST_BYTES - 256 - 2 - commandPrefix.length - 50)}`;
  const expansion = expandWebSlashCommand(raw);

  assert.equal(validateOutgoingPrompt(raw), null, "the raw slash command fits");
  assert.equal(expansion.kind, "expand");
  assert.match(validateOutgoingPrompt(expansion.prompt), /too large to send/);
});
