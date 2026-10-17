import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const en = JSON.parse(fs.readFileSync(new URL("./i18n/locales/en.json", import.meta.url), "utf8"));
const ko = JSON.parse(fs.readFileSync(new URL("./i18n/locales/ko.json", import.meta.url), "utf8"));
const { translate, translatePlural, setLocale, useI18n, LOCALES } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./i18n/index.tsx");
afterEach(cleanup);

test("Korean covers English UI keys and preserves interpolation and code literals", () => {
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(ko[key].trim(), key);
    assert.deepEqual(ko[key].match(/\{\w+\}/g)?.sort() ?? [], value.match(/\{\w+\}/g)?.sort() ?? [], key);
    assert.deepEqual(ko[key].match(/`[^`]+`/g)?.sort() ?? [], value.match(/`[^`]+`/g)?.sort() ?? [], key);
  }
});

test("adding Korean retains English hydration and an existing language preference", () => {
  assert.equal(translate("chatInput.send"), "Send");
  localStorage.setItem("omp-lang", "en");
  const { result } = renderHook(() => useI18n());
  assert.equal(result.current.locale, "en");
  act(() => setLocale("ko"));
  assert.equal(result.current.locale, "ko");
  assert.equal(translate("modelsConfig.roleThinkingAria", { role: "task" }), "task 역할의 추론 수준");
  assert.equal(translatePlural("chatWindow.messageCount", 3), "메시지 3개");
  assert.equal(localStorage.getItem("omp-lang"), "ko");
  assert.equal(document.documentElement.lang, "ko");
  assert.ok(LOCALES.some(entry => entry.value === "ko" && entry.label === "한국어"));
  act(() => setLocale("en"));
});

test("native parameter values retain their exact spelling", () => {
  for (const key of ["settingsConfig.verbosityLow", "settingsConfig.verbosityMedium", "settingsConfig.verbosityHigh", "settingsConfig.personalityDefault", "settingsConfig.personalityFriendly", "settingsConfig.personalityPragmatic", "settingsConfig.personalityNone"]) assert.equal(ko[key], en[key]);
});
