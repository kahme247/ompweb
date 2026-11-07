import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
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

// Deliberate exact-parity requirement: zh-TW.json is maintained in 1:1 key and
// {placeholder} parity with en.json. When adding or renaming English keys in
// en.json, update zh-TW.json in the same change rather than weakening this check.
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

test("app/index.html inline boot script resolves omp-lang according to locale logic", async () => {
  const indexHtml = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  const scriptMatches = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const langScriptMatch = scriptMatches.find((m) => m[1].includes("omp-lang"));
  assert.ok(langScriptMatch, "found inline omp-lang boot script in app/index.html");
  const scriptCode = langScriptMatch[1];

  function runScript(storedLang, navLang) {
    const storage = new Map();
    if (storedLang !== null) storage.set("omp-lang", storedLang);
    const context = {
      localStorage: {
        getItem(key) {
          return storage.get(key) ?? null;
        },
      },
      navigator: {
        language: navLang,
      },
      document: {
        documentElement: {
          lang: "en",
        },
      },
    };
    vm.runInNewContext(scriptCode, context);
    return context.document.documentElement.lang;
  }

  for (const stored of [null, "invalid"]) {
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) {
      assert.equal(runScript(stored, tag), "zh-TW", `failed stored=${stored} tag=${tag}`);
    }
    for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans"]) {
      assert.equal(runScript(stored, tag), "zh-CN", `failed stored=${stored} tag=${tag}`);
    }
    for (const tag of ["ja", "ja-JP"]) {
      assert.equal(runScript(stored, tag), "ja", `failed stored=${stored} tag=${tag}`);
    }
    for (const tag of ["en-US", "fr-FR", ""]) {
      assert.equal(runScript(stored, tag), "en", `failed stored=${stored} tag=${tag}`);
    }
  }

  assert.equal(runScript("zh-TW", "en-US"), "zh-TW", "stored zh-TW should override navigator language");
});

test("zh-TW notification registration renders push notifications in Traditional Chinese", async (t) => {
  const hub = await import("./notification-hub.ts");
  const store = await import("./notification-store.ts");
  const { DEFAULT_NOTIFICATION_PREFS } = await import("./notification-events.ts");
  const webpush = (await import("web-push")).default;
  const zhTW = JSON.parse(await readFile(new URL("./i18n/locales/zh-TW.json", import.meta.url), "utf8"));

  const dir = mkdtempSync(join(tmpdir(), "omp-notify-zhtw-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = webpush.sendNotification;
  const previousHub = globalThis.__ompNotificationHub;

  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__ompNotificationHub = undefined;
  store.closeNotificationStore();

  t.after(() => {
    webpush.sendNotification = previousSend;
    globalThis.__ompNotificationHub = previousHub;
    store.closeNotificationStore();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const sent = [];
  webpush.sendNotification = async (_subscription, payload, options) => {
    sent.push({ payload: JSON.parse(payload), options });
  };

  const deviceId = "tw-device";
  const subscription = {
    endpoint: "https://push.example/tw",
    keys: { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) },
  };

  store.saveDevice(
    deviceId,
    {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      locale: "zh-TW",
    },
    subscription,
  );

  hub.publishNotification({ type: "completed", sessionId: "s1", sessionName: "Session" });
  await new Promise((resolve) => setImmediate(resolve));

  const testPushResult = await hub.sendTestPush(deviceId);
  assert.deepEqual(testPushResult, { ok: true });

  assert.equal(sent.length, 2, "expected two sent notifications");
  assert.equal(sent[0].payload.body, zhTW["notifications.completedBody"]);
  assert.equal(sent[1].payload.body, zhTW["notifications.testBody"]);
});
