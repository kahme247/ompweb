import assert from "node:assert/strict";
import test from "node:test";

const { sanitizeTextForSpeech } = await import("./speech-sanitizer.ts");

test("sanitizeTextForSpeech handles empty or falsy inputs", () => {
  assert.equal(sanitizeTextForSpeech(""), "");
  assert.equal(sanitizeTextForSpeech(null), "");
  assert.equal(sanitizeTextForSpeech(undefined), "");
});

test("sanitizeTextForSpeech strips fenced code blocks", () => {
  const input = "Here is the code:\n```typescript\nconst x = 10;\nconsole.log(x);\n```\nLet me know what you think.";
  const expected = "Here is the code: Let me know what you think.";
  assert.equal(sanitizeTextForSpeech(input), expected);
});

test("sanitizeTextForSpeech preserves inline code text without backticks", () => {
  const input = "Run `npm run dev` to start.";
  const expected = "Run npm run dev to start.";
  assert.equal(sanitizeTextForSpeech(input), expected);
});

test("sanitizeTextForSpeech unwraps markdown links", () => {
  const input = "Check out the [documentation](https://example.com/docs) for details.";
  const expected = "Check out the documentation for details.";
  assert.equal(sanitizeTextForSpeech(input), expected);
});

test("sanitizeTextForSpeech strips images and bare URLs", () => {
  const input = "Look at this ![diagram](https://example.com/img.png) and visit https://example.com directly.";
  const expected = "Look at this and visit directly.";
  assert.equal(sanitizeTextForSpeech(input), expected);
});

test("sanitizeTextForSpeech strips html tags but keeps comparison operators", () => {
  assert.equal(
    sanitizeTextForSpeech("<div class='x'>Wrapped</div> text"),
    "Wrapped text",
  );
  assert.equal(
    sanitizeTextForSpeech("Use x < y and z > 0 to guard."),
    "Use x < y and z > 0 to guard.",
  );
});

test("sanitizeTextForSpeech strips markdown formatting headers, bold, italics, lists, and blockquotes", () => {
  const input = `
# Title
> Important note:

- First **bold** point
- Second *italic* point
- Third ~~strike~~ point

1. Numbered step
`;
  const result = sanitizeTextForSpeech(input);
  assert.equal(result, "Title Important note: First bold point Second italic point Third strike point Numbered step");
});
