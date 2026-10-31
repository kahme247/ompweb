import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MessageView } = await import("./MessageView.tsx");
const { MarkdownBody } = await import("./MarkdownBody.tsx");
const { ClickableImage, fitZoom, stepZoom } = await import("./ImageLightbox.tsx");

test("user image blocks render as click-to-preview thumbnails", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    },
  }));

  assert.match(html, /<button[^>]*class="image-clickable"/);
  assert.match(html, /src="data:image\/png;base64,QUJD"/);
});

test("markdown images render as click-to-preview thumbnails", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "![diagram](https://example.com/a.png)"));

  assert.match(html, /<button[^>]*class="image-clickable"/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /alt="diagram"/);
});

test("custom message images render as click-to-preview thumbnails", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "advisor",
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    },
  }));

  assert.match(html, /<button[^>]*class="image-clickable"/);
  assert.match(html, /src="data:image\/png;base64,QUJD"/);
});

test("click-to-preview keeps image attributes and starts closed", () => {
  const html = renderToStaticMarkup(React.createElement(ClickableImage, {
    src: "data:image/gif;base64,R0lGOD",
    alt: "x",
    className: "markdown-inline-img",
    // Override the hard-coded loading="lazy" to prove rest props reach the img.
    loading: "eager",
  }));

  assert.match(html, /<button[^>]*class="image-clickable"/);
  assert.match(html, /src="data:image\/gif;base64,R0lGOD"/);
  assert.match(html, /alt="x"/);
  assert.match(html, /class="markdown-inline-img"/);
  assert.match(html, /loading="eager"/);
  // The trigger's accessible name carries the meaningful alt text.
  assert.match(html, /aria-label="Open image preview: x"/);
  assert.doesNotMatch(html, /image-lightbox-dialog/);
});

test("pure image links render the preview directly without an anchor wrapper", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[![diagram](https://example.com/a.png)](https://example.com/page)"));

  // The preview supersedes the link: no anchor, no invalid <a><button> nesting.
  assert.doesNotMatch(html, /<a[^>]*>/);
  assert.match(html, /<button[^>]*class="image-clickable"/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
});

test("mixed links keep the caption linked and render the image preview beside it", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[open ![diagram](https://example.com/a.png)](https://example.com/page)"));

  // Caption stays a link; the image preview is NOT nested inside the anchor.
  assert.match(html, /<a[^>]*>open[^<]*<\/a><button[^>]*class="image-clickable"/);
  assert.doesNotMatch(html, /<button[^>]*class="image-clickable"[\s\S]*?<\/a>/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
});

test("formatted image links unwrap the anchor and keep the formatting", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[**![diagram](https://example.com/a.png)**](https://example.com/page)"));

  // Image-only link wrapped in formatting: no anchor; the button may live
  // inside <strong> (valid) but never inside <a>.
  assert.doesNotMatch(html, /<a[^>]*>/);
  assert.match(html, /<strong><button[^>]*class="image-clickable"/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
});

test("formatted mixed links keep text formatted and linked, preview beside", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[**open ![diagram](https://example.com/a.png)**](https://example.com/page)"));

  assert.match(html, /<a[^>]*><strong>open[^<]*<\/strong><\/a><button[^>]*class="image-clickable"/);
  assert.doesNotMatch(html, /<button[^>]*class="image-clickable"[\s\S]*?<\/a>/);
});

test("whitespace-only text around an image link still unwraps the anchor", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, "[ ![diagram](https://example.com/a.png) ](https://example.com/page)"));

  // Surrounding spaces are not link content — the preview supersedes the link.
  assert.doesNotMatch(html, /<a[^>]*>/);
  assert.match(html, /<button[^>]*class="image-clickable"/);
});

test("missing image sources render nothing", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ClickableImage, { src: "" })), "");
});

test("fitZoom fits big images to the viewport and keeps small ones at real size", () => {
  // 6000×4000 in a 366×700 phone viewport: limited by width.
  assert.equal(fitZoom({ width: 6000, height: 4000 }, { width: 366, height: 700 }), 0.061);
  // Limited by height on a wide desktop.
  assert.equal(fitZoom({ width: 1000, height: 2000 }, { width: 1800, height: 1000 }), 0.5);
  assert.equal(fitZoom({ width: 200, height: 100 }, { width: 1800, height: 1000 }), 1);
  // Not yet laid out or no intrinsic size: real size rather than 0 or Infinity.
  assert.equal(fitZoom({ width: 6000, height: 4000 }, { width: 0, height: 0 }), 1);
  assert.equal(fitZoom({ width: 0, height: 0 }, { width: 366, height: 700 }), 1);
});

test("stepZoom moves by ×1.25 down to min(fit, 10%) and up to 800%", () => {
  assert.equal(stepZoom(1, 1, 1), 1.25);
  assert.equal(stepZoom(1, -1, 1), 0.8);
  assert.equal(stepZoom(0.061 * 1.25, -1, 0.061), 0.061);
  assert.equal(stepZoom(0.061, -1, 0.061), 0.061, "cannot zoom out past the fitted size of a huge image");
  assert.equal(stepZoom(0.11, -1, 0.5), 0.1);
  assert.equal(stepZoom(7, 1, 0.5), 8);
});
