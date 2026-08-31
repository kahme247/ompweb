import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppUpdateDialog.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  getAppUpdateStepIndex,
  getAppUpdateVersionTransition,
  getMonotonicAppUpdateStage,
  getNextAppUpdateStage,
  loadAppUpdateReleaseNotes,
} = await jiti.import("./AppUpdateDialog.tsx");

const version = "0.3.6";
const validNotes = {
  version,
  body: "## Fixed\n\n- Safer updates",
  htmlUrl: `https://github.com/kahme247/ompweb/releases/tag/v${version}`,
};
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

test("release notes loader fetches and validates production notes", async () => {
  const controller = new AbortController();
  let request;
  const notes = await loadAppUpdateReleaseNotes(version, controller.signal, async (url, init) => {
    request = { url, signal: init?.signal };
    return jsonResponse(validNotes);
  });

  assert.deepEqual(request, { url: "/api/app-update/notes", signal: controller.signal });
  assert.deepEqual(notes, validNotes);

  for (const payload of [
    { ...validNotes, version: "0.3.5" },
    { ...validNotes, htmlUrl: `http://github.com/kahme247/ompweb/releases/tag/v${version}` },
    { ...validNotes, htmlUrl: `${validNotes.htmlUrl}?download=1` },
    { ...validNotes, body: "" },
    { ...validNotes, body: "x".repeat((64 * 1024) + 1) },
    { ...validNotes, body: "é".repeat((32 * 1024) + 1) },
  ]) {
    assert.equal(await loadAppUpdateReleaseNotes(
      version,
      controller.signal,
      async () => jsonResponse(payload),
    ), null);
  }

  assert.equal(await loadAppUpdateReleaseNotes(
    version,
    controller.signal,
    async () => new Response(null, { status: 204 }),
  ), null);
  assert.equal(await loadAppUpdateReleaseNotes(
    version,
    controller.signal,
    async () => new Response("{", { status: 200 }),
  ), null);
});

test("release notes loader preserves network and abort failures for retry", async () => {
  const networkError = new Error("offline");
  await assert.rejects(
    loadAppUpdateReleaseNotes(version, new AbortController().signal, async () => { throw networkError; }),
    (error) => error === networkError,
  );

  const controller = new AbortController();
  const pending = loadAppUpdateReleaseNotes(version, controller.signal, async (_url, init) => (
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })
  ));
  controller.abort(new DOMException("Aborted", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
});

test("visible stages map to five checklist rows without moving backwards", () => {
  const stages = ["preparing"];
  let next;
  while ((next = getNextAppUpdateStage(stages.at(-1)))) stages.push(next);
  assert.deepEqual(stages, ["preparing", "stopping", "installing", "restarting", "finalizing"]);
  assert.deepEqual([
    getAppUpdateStepIndex("restarting"),
    getAppUpdateStepIndex("preparing", "installing"),
    getAppUpdateStepIndex("completed"),
  ], [1, 2, 5]);
  assert.equal(getMonotonicAppUpdateStage("stopping", "installing"), "installing");
  assert.equal(getMonotonicAppUpdateStage("installing", "stopping"), "installing");
});

test("completed updates render five completed rows and truthful versions", () => {
  const completedStep = getAppUpdateStepIndex("completed");
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => ({
      current: index === completedStep,
      completed: index < completedStep,
    })),
    Array.from({ length: 5 }, () => ({ current: false, completed: true })),
  );

  const succeeded = {
    currentVersion: version,
    availableVersion: version,
    updateAvailable: false,
    selfUpdateStatus: {
      fromVersion: "0.3.5",
      targetVersion: version,
    },
  };
  assert.deepEqual(
    getAppUpdateVersionTransition(succeeded, "completed"),
    { fromVersion: "0.3.5", targetVersion: version },
  );
  assert.equal(
    getAppUpdateVersionTransition({ ...succeeded, selfUpdateStatus: null }, "completed"),
    null,
  );
  assert.match(
    source,
    /const currentStepIndex = getAppUpdateStepIndex\(phase, effectiveStage\);[\s\S]*const isCurrent = index === currentStepIndex;[\s\S]*const isCompleted = index < currentStepIndex;/,
  );
  assert.match(source, /<span>v\{versionTransition\.fromVersion\}<\/span>[\s\S]*<span>v\{versionTransition\.targetVersion\}<\/span>/);
});

test("update progress, release notes, and stopping diagnostics remain accessible", () => {
  assert.match(source, /<ol aria-label=\{t\("appUpdateDialog\.progressLabel"\)\} aria-live="polite"/);
  assert.match(source, /aria-current=\{isCurrent \? "step" : undefined\}/);
  assert.match(source, /role="region"[\s\S]*aria-label=\{t\("appUpdateDialog\.releaseNotesTitle"[\s\S]*tabIndex=\{0\}/);
  assert.match(source, /<section\s+aria-label=\{drainSummary\}[\s\S]*role="status" aria-live="polite"/);
});

test("every shipped locale covers the update dialog copy", async () => {
  const locales = await Promise.all(["en", "ja", "zh-CN"].map(async (locale) => JSON.parse(
    await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
  )));
  const requiredKeys = Object.keys(locales[0]).filter((key) => (
    key.startsWith("appUpdateDialog.")
    || ["appShell.commandCopied", "appShell.commandCopyFailed", "appShell.copyCommand"].includes(key)
  ));
  for (const [index, messages] of locales.entries()) {
    for (const key of requiredKeys) {
      assert.equal(typeof messages[key], "string", `${["en", "ja", "zh-CN"][index]} is missing ${key}`);
      assert.ok(messages[key].trim(), `${["en", "ja", "zh-CN"][index]} has empty ${key}`);
    }
  }
});
