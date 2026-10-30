// Probes 3-5: node:sqlite notification store, sharp thumbnails, web-push signing — under Bun.
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import webpush from "web-push";
import { getVapidKeys, listHistory, recordHistory, saveDevice, listDevices } from "../lib/notification-store";
import { createThumbnail } from "../lib/media-cache";

const step = async (name: string, fn: () => unknown) => {
  try {
    console.log(`${name}: OK ${JSON.stringify(await fn())}`);
  } catch (e) {
    console.log(`${name}: FAIL ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
  }
};

await step("3 node:sqlite store", () => {
  const vapid = getVapidKeys(webpush.generateVAPIDKeys);
  saveDevice("spike-device-1", { enabled: true } as never);
  recordHistory({ type: "test", sessionId: "s1", sessionName: "spike" });
  return { vapidPublicLen: vapid.publicKey.length, devices: listDevices().length, history: listHistory().map((h) => h.id) };
});

await step("4 sharp thumbnail", async () => {
  const png = readFileSync(new URL("../public/icon-192.png", import.meta.url));
  const thumb = await createThumbnail("spikehash0000000000000000000000000000000000000000000000000000000", png);
  return { inputBytes: png.length, webpBytes: thumb?.length ?? null, riff: thumb?.subarray(0, 4).toString() ?? null };
});

await step("5 web-push signed request", () => {
  const keys = webpush.generateVAPIDKeys();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const subscription = {
    endpoint: "https://push.example.invalid/send/abc",
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
  const req = webpush.generateRequestDetails(subscription, JSON.stringify({ title: "spike" }), {
    vapidDetails: { subject: "mailto:spike@example.invalid", publicKey: keys.publicKey, privateKey: keys.privateKey },
  });
  return { method: req.method, auth: String(req.headers.Authorization).slice(0, 12), encoding: req.headers["Content-Encoding"], bodyBytes: (req.body as Buffer).length };
});
