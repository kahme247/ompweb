import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("top bar surfaces selected model output capacity without provider quota claims", () => {
  assert.match(source, /modelCapacity?.maxTokens/);
  assert.match(source, /tooltipMaxOutput/);
  assert.doesNotMatch(source, /provider quota|remaining allowance|reset time/i);
});

test("prepared recovery deduplicates in flight and retries transport failures", () => {
  const commit = source.slice(
    source.indexOf("const submitAppUpdateCommit"),
    source.indexOf("const recoverPreparedAppUpdate"),
  );
  const recovery = source.slice(
    source.indexOf("const recoverPreparedAppUpdate"),
    source.indexOf("const completeAppUpdate"),
  );
  assert.match(recovery, /status\.state !== "prepared"[\s\S]*status\.stage !== "preparing" && status\.stage !== "stopping"/);
  assert.match(recovery, /current === attemptId\) return;[\s\S]*current = attemptId;[\s\S]*submitAppUpdateCommit\(attemptId\)/);
  assert.match(commit, /AppUpdateTransportError[\s\S]*current === attemptId[\s\S]*current = null/);
});

test("late startup update responses cannot overwrite an active attempt", () => {
  const refresh = source.slice(
    source.indexOf("const refreshAppUpdate"),
    source.indexOf("const acknowledgeAppUpdate"),
  );
  const proceed = source.slice(
    source.indexOf("const proceedWithAppUpdate"),
    source.indexOf("const dismissAppUpdate"),
  );
  const guard = refresh.indexOf("appUpdateStartInFlightRef.current");
  assert.ok(guard >= 0 && guard < refresh.indexOf("setAppUpdate(data)"));
  assert.match(
    refresh,
    /if \(\s*autoOpen\s*&& \(appUpdateStartInFlightRef\.current \|\| appUpdateAttemptRef\.current !== null \|\| appUpdateCompletingRef\.current\)\s*\) return null;/,
  );
  assert.match(
    refresh.slice(guard, refresh.indexOf("setAppUpdate(data)")),
    /appUpdateAttemptRef\.current !== null[\s\S]*appUpdateCompletingRef\.current[\s\S]*return null/,
  );
  assert.match(proceed, /appUpdateStartInFlightRef\.current = true;[\s\S]*action: "prepare"/);
});

test("update timers use supported promises and preparing dwell is display-only", () => {
  assert.doesNotMatch(source, /Promise\.withResolvers/);
  assert.match(source, /await new Promise<void>\(\(resolve\) => window\.setTimeout\(resolve, remainingMs\)\)/);

  const stages = source.slice(
    source.indexOf("const showAppUpdateStagesThrough"),
    source.indexOf("const [ompUpdateAvailable"),
  );
  assert.match(
    stages,
    /current === "preparing" \? APP_UPDATE_PREPARING_MIN_MS : APP_UPDATE_VISIBLE_STAGE_MIN_MS/,
  );

  const proceed = source.slice(
    source.indexOf("const proceedWithAppUpdate"),
    source.indexOf("const dismissAppUpdate"),
  );
  const commit = proceed.indexOf("submitAppUpdateCommit(prepared.attemptId)");
  const monitor = proceed.indexOf("void monitorAppUpdate(prepared.attemptId, prepared.targetVersion)");
  const dwell = proceed.indexOf('await showAppUpdateStagesThrough("stopping")');
  const activeGuard = proceed.indexOf("appUpdateAttemptRef.current !== prepared.attemptId");
  const restarting = proceed.indexOf('setAppUpdatePhase("restarting")');
  assert.ok(commit >= 0 && commit < dwell);
  assert.ok(monitor >= 0 && monitor < dwell);
  assert.ok(dwell < activeGuard && activeGuard < restarting);
});
