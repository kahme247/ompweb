import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-types.ts");
}

test("detects image, audio, and document preview paths", async () => {
  const {
    getAudioMime,
    getDocumentMime,
    getImageMime,
    isAudioPath,
    isDocumentPreviewPath,
    isImagePath,
  } = await loadSubject();

  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(getDocumentMime("/tmp/report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(isImagePath("/tmp/screenshot.PNG"), true);
  assert.equal(isAudioPath("C:\\Users\\me\\voice.OPUS"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.pdf"), true);
  assert.equal(isDocumentPreviewPath("/tmp/report.txt"), false);
});

test("extracts extensions from mixed path styles", async () => {
  const { documentPreviewKind, getFileExt } = await loadSubject();

  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
  assert.equal(documentPreviewKind("/tmp/manual.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/manual.md"), null);
});

test("streamed SVG documents carry a script-blocking security policy", async () => {
  const { getStreamSecurityHeaders, IMAGE_EXT_TO_MIME } = await loadSubject();

  const headers = getStreamSecurityHeaders(IMAGE_EXT_TO_MIME.svg);
  const csp = headers["Content-Security-Policy"];
  assert.ok(csp, "SVG responses must set a Content-Security-Policy");
  // No script-src fallback hole: default-src 'none' governs script loading.
  assert.match(csp, /(^|; )default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  // Legit SVGs keep inline styles and data-URI images.
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /img-src data:/);
  // Same-origin framing stays possible; only script execution is blocked.
  assert.match(csp, /frame-ancestors 'self'/);
});

test("non-SVG streamed types keep their default headers", async () => {
  const { getStreamSecurityHeaders } = await loadSubject();

  // <img>/<audio>/document embedding must not change for other MIME types.
  assert.deepEqual(getStreamSecurityHeaders("image/png"), {});
  assert.deepEqual(getStreamSecurityHeaders("audio/mpeg"), {});
  assert.deepEqual(getStreamSecurityHeaders("application/pdf"), {});
});
