import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { POST, MAX_STT_AUDIO_BYTES } = await jiti.import("../app/api/stt/route.ts");

test("stt route returns 501 when OMP_WEB_STT_ENDPOINT is not configured", async () => {
  const originalEndpoint = process.env.OMP_WEB_STT_ENDPOINT;
  delete process.env.OMP_WEB_STT_ENDPOINT;

  try {
    const formData = new FormData();
    formData.append("file", new Blob(["fake-audio"], { type: "audio/webm" }), "audio.webm");

    const req = new Request("http://localhost/api/stt", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.match(body.error, /STT not configured/i);
  } finally {
    if (originalEndpoint !== undefined) process.env.OMP_WEB_STT_ENDPOINT = originalEndpoint;
  }
});

test("stt route forwards audio to configured endpoint and returns text", async () => {
  const originalEnv = { ...process.env };
  let receivedAuth = "";

  const server = createServer((req, res) => {
    receivedAuth = req.headers.authorization || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "git status and commit" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  process.env.OMP_WEB_STT_ENDPOINT = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
  process.env.OMP_WEB_STT_KEY = "test-secret-key";

  try {
    const formData = new FormData();
    formData.append("file", new Blob(["test-audio-bytes"], { type: "audio/webm" }), "audio.webm");

    const req = new Request("http://localhost/api/stt", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.text, "git status and commit");
    assert.equal(receivedAuth, "Bearer test-secret-key");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env = originalEnv;
  }
});

test("stt route normalizes upstream { error: { message } } to { error: string }", async () => {
  const originalEnv = { ...process.env };

  const server = createServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  process.env.OMP_WEB_STT_ENDPOINT = `http://127.0.0.1:${port}/v1/audio/transcriptions`;
  process.env.OMP_WEB_STT_KEY = "bad-key";

  try {
    const formData = new FormData();
    formData.append("file", new Blob(["test-audio-bytes"], { type: "audio/webm" }), "audio.webm");

    const req = new Request("http://localhost/api/stt", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid API key");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env = originalEnv;
  }
});

test("stt route strips newlines and carriage returns from env vars", async () => {
  const originalEnv = { ...process.env };
  let receivedAuth = "";

  const server = createServer((req, res) => {
    receivedAuth = req.headers.authorization ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "sanitized test" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  process.env.OMP_WEB_STT_ENDPOINT = `  http://127.0.0.1:${port}/v1/audio/transcriptions\n\n  `;
  process.env.OMP_WEB_STT_KEY = "  secret-key-123\r\n\\n  ";

  try {
    const formData = new FormData();
    formData.append("file", new Blob(["test-audio-bytes"], { type: "audio/webm" }), "audio.webm");

    const req = new Request("http://localhost/api/stt", {
      method: "POST",
      body: formData,
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    assert.equal(receivedAuth, "Bearer secret-key-123");
    const body = await res.json();
    assert.equal(body.text, "sanitized test");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env = originalEnv;
  }
});

test("stt route rejects request with missing or empty audio file with 400", async () => {
  const originalEndpoint = process.env.OMP_WEB_STT_ENDPOINT;
  process.env.OMP_WEB_STT_ENDPOINT = "http://127.0.0.1:9999/v1/audio/transcriptions";

  try {
    // Missing file
    const emptyForm = new FormData();
    const reqMissing = new Request("http://localhost/api/stt", {
      method: "POST",
      body: emptyForm,
    });
    const resMissing = await POST(reqMissing);
    assert.equal(resMissing.status, 400);
    const bodyMissing = await resMissing.json();
    assert.equal(bodyMissing.code, "missing_audio_file");

    // Empty file
    const zeroForm = new FormData();
    zeroForm.append("file", new Blob([], { type: "audio/webm" }), "empty.webm");
    const reqZero = new Request("http://localhost/api/stt", {
      method: "POST",
      body: zeroForm,
    });
    const resZero = await POST(reqZero);
    assert.equal(resZero.status, 400);
    const bodyZero = await resZero.json();
    assert.equal(bodyZero.code, "missing_audio_file");
  } finally {
    if (originalEndpoint !== undefined) process.env.OMP_WEB_STT_ENDPOINT = originalEndpoint;
    else delete process.env.OMP_WEB_STT_ENDPOINT;
  }
});

test("stt route rejects oversized audio with 413", async () => {
  const originalEndpoint = process.env.OMP_WEB_STT_ENDPOINT;
  process.env.OMP_WEB_STT_ENDPOINT = "http://127.0.0.1:9999/v1/audio/transcriptions";

  try {
    // 1. Declared Content-Length exceeds maxBytes
    const reqDeclared = new Request("http://localhost/api/stt", {
      method: "POST",
      headers: {
        "content-length": String(MAX_STT_AUDIO_BYTES + 1024 * 1024 + 1),
        "content-type": "multipart/form-data; boundary=---boundary",
      },
      body: "---boundary--\r\n",
    });
    const resDeclared = await POST(reqDeclared);
    assert.equal(resDeclared.status, 413);
    const bodyDeclared = await resDeclared.json();
    assert.equal(bodyDeclared.code, "audio_too_large");

    // 2. Streamed chunks exceed maxBytes
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_STT_AUDIO_BYTES + 1024 * 1024 + 100));
        controller.close();
      },
    });
    const reqStream = new Request("http://localhost/api/stt", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=---boundary",
      },
      body: stream,
      duplex: "half",
    });
    const resStream = await POST(reqStream);
    assert.equal(resStream.status, 413);
    const bodyStream = await resStream.json();
    assert.equal(bodyStream.code, "audio_too_large");
  } finally {
    if (originalEndpoint !== undefined) process.env.OMP_WEB_STT_ENDPOINT = originalEndpoint;
    else delete process.env.OMP_WEB_STT_ENDPOINT;
  }
});
