import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, tsconfigPaths: true });
const { formatExitedSessionNotice, setLocale } = await jiti.import("./i18n/index.tsx");

// getLocale() falls back to "en" during SSR; a minimal document lets the test
// switch locales the same way the settings dialog does in the browser.
globalThis.document = { documentElement: {} };

const exit = (detail) => ({ id: "s1", cwd: "/tmp", at: 0, code: null, signal: null, detail });

test("a stalled exit gets its own localized sentence instead of the sentinel", () => {
  try {
    setLocale("en");
    assert.equal(
      formatExitedSessionNotice(exit("stalled")),
      "The agent stopped responding and was stopped.",
    );
    assert.doesNotMatch(formatExitedSessionNotice(exit("stalled")), /stalled/);

    // Every other detail keeps the normal exit explanation.
    assert.equal(
      formatExitedSessionNotice(exit("signal 9")),
      "Agent process exited unexpectedly (code unknown: signal 9)",
    );

    setLocale("ja");
    assert.equal(
      formatExitedSessionNotice(exit("stalled")),
      "エージェントが応答しなくなったため停止しました。",
    );

    setLocale("zh-CN");
    assert.equal(
      formatExitedSessionNotice(exit("stalled")),
      "智能体停止响应，已被停止。",
    );
  } finally {
    setLocale("en");
    delete globalThis.document;
  }
});
