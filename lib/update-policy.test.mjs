import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { checkNpmUpdate } = await jiti.import("./npm-update.ts");
const { checkOmpUpdate } = await jiti.import("./omp/updates.ts");
const { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } = await jiti.import("./update-policy.ts");
const {
  getSelfUpdateSupport,
  prepareSelfUpdate,
  commitSelfUpdate,
  validateCommitSelfUpdate,
} = await jiti.import("./self-update.ts");
const { GET: getAppUpdate, POST: postAppUpdate } = await jiti.import("../app/api/app-update/route.ts");
const { POST: postOmpUpdate } = await jiti.import("../app/api/omp-update/route.ts");

const ENV_VAR = DISABLE_AUTOUPDATE_ENV_VAR;


test("update opt-out accepts truthy values and leaves falsy values enabled", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), true);
  }
  for (const value of [undefined, "", "0", "false", "off", "no"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), false);
  }
});
test("update opt-out skips external checks and self-update actions", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env[ENV_VAR] = "1";
  process.env.OMP_WEB_OMP_BIN = join(tmpdir(), "omp-web-missing-omp-for-update-policy-test");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ version: "999.0.0" });
  };

  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  const appStatus = await checkNpmUpdate(true);
  assert.equal(appStatus.updatesDisabled, true);
  assert.equal(appStatus.updateAvailable, false);
  assert.equal(appStatus.availableVersion, null);

  const ompStatus = await checkOmpUpdate(true);
  assert.equal(ompStatus.updatesDisabled, true);
  assert.equal(ompStatus.updateAvailable, false);
  assert.equal(ompStatus.availableVersion, null);

  const appResponse = await getAppUpdate(new Request("http://localhost/api/app-update?force=1"));
  assert.equal(appResponse.status, 200);
  const appBody = await appResponse.json();
  assert.equal(appBody.updatesDisabled, true);
  assert.equal(appBody.updateAvailable, false);
  assert.equal(appBody.selfUpdateSupported, false);
  assert.equal(appBody.selfUpdateStatus, undefined);

  const ompResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check", force: true }),
  }));
  assert.equal(ompResponse.status, 200);
  const ompBody = await ompResponse.json();
  assert.equal(ompBody.updatesDisabled, true);
  assert.equal(ompBody.updateAvailable, false);

  const appPrepareResponse = await postAppUpdate(new Request("http://localhost/api/app-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare" }),
  }));
  assert.equal(appPrepareResponse.status, 403);
  assert.equal((await appPrepareResponse.json()).code, "updates_disabled");

  const ompUpdateResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update" }),
  }));
  assert.equal(ompUpdateResponse.status, 403);
  assert.equal((await ompUpdateResponse.json()).code, "updates_disabled");
  assert.equal(fetchCalls, 0);

  assert.equal(getSelfUpdateSupport().supported, false);
  await assert.rejects(prepareSelfUpdate("app"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  assert.throws(() => validateCommitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  await assert.rejects(() => commitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
});
