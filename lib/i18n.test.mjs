import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveNavigatorLocale, LOCALES } = await jiti.import("./i18n/index.tsx");

test("resolveNavigatorLocale identifies Traditional Chinese locales", () => {
  const traditionalCases = [
    "zh-TW",
    "zh-tw",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
  ];
  for (const tag of traditionalCases) {
    assert.equal(resolveNavigatorLocale(tag), "zh-TW", `failed for ${tag}`);
  }
});

test("resolveNavigatorLocale identifies Simplified Chinese locales", () => {
  const simplifiedCases = [
    "zh",
    "zh-CN",
    "zh-SG",
    "zh-Hans",
    "zh-Hans-CN",
  ];
  for (const tag of simplifiedCases) {
    assert.equal(resolveNavigatorLocale(tag), "zh-CN", `failed for ${tag}`);
  }
});

test("resolveNavigatorLocale identifies Japanese locales", () => {
  assert.equal(resolveNavigatorLocale("ja"), "ja");
  assert.equal(resolveNavigatorLocale("ja-JP"), "ja");
});

test("resolveNavigatorLocale falls back to en for English, empty, and unsupported locales", () => {
  assert.equal(resolveNavigatorLocale("en"), "en");
  assert.equal(resolveNavigatorLocale("en-US"), "en");
  assert.equal(resolveNavigatorLocale("fr-FR"), "en");
  assert.equal(resolveNavigatorLocale(""), "en");
  assert.equal(resolveNavigatorLocale(undefined), "en");
  assert.equal(resolveNavigatorLocale(null), "en");
});

test("LOCALES includes en, zh-CN, zh-TW, ja", () => {
  const values = LOCALES.map((item) => item.value);
  assert.deepEqual(values, ["en", "zh-CN", "zh-TW", "ja"]);
});

test("zh-TW.json has exact same keys, non-empty values, and identical placeholders as en.json", async () => {
  const enUrl = new URL("./i18n/locales/en.json", import.meta.url);
  const zhTwUrl = new URL("./i18n/locales/zh-TW.json", import.meta.url);

  const en = JSON.parse(await readFile(enUrl, "utf8"));
  const zhTW = JSON.parse(await readFile(zhTwUrl, "utf8"));

  const enKeys = Object.keys(en).sort();
  const zhTwKeys = Object.keys(zhTW).sort();

  assert.deepEqual(zhTwKeys, enKeys, "keys in zh-TW.json must match en.json exactly");

  const extractPlaceholders = (text) => {
    const matches = text.match(/\{[a-zA-Z0-9_]+\}/g) || [];
    return matches.sort();
  };

  for (const key of enKeys) {
    const zhTwVal = zhTW[key];
    assert.equal(typeof zhTwVal, "string", `zh-TW value for key "${key}" must be a string`);
    assert.ok(zhTwVal.trim().length > 0, `zh-TW value for key "${key}" must not be empty`);

    const enPlaceholders = extractPlaceholders(en[key]);
    const zhTwPlaceholders = extractPlaceholders(zhTwVal);
    assert.deepEqual(
      zhTwPlaceholders,
      enPlaceholders,
      `placeholder mismatch for key "${key}": expected ${JSON.stringify(enPlaceholders)}, got ${JSON.stringify(zhTwPlaceholders)}`,
    );
  }
});
