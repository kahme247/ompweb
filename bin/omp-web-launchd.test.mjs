import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { HOST_LABEL, LABEL, buildPlist } = require("./omp-web-launchd.js");

const env = { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/Users/u/agent" };

test("the host daemon plist runs `ompweb host`, restarts with KeepAlive, and is throttled", () => {
  const plist = buildPlist({
    label: HOST_LABEL,
    args: ["/usr/local/bin/npx", "--yes", "@kahme247/ompweb@latest", "host"],
    env,
    logName: "ompweb-host",
    throttleInterval: 10,
  });
  assert.equal(HOST_LABEL, "com.kahme247.ompweb-host");
  assert.match(plist, /<key>Label<\/key><string>com\.kahme247\.ompweb-host<\/string>/);
  assert.match(plist, /<string>@kahme247\/ompweb@latest<\/string>\n    <string>host<\/string>\n  <\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>PI_CODING_AGENT_DIR<\/key><string>\/Users\/u\/agent<\/string>/);
  assert.match(plist, /ompweb-host\.log<\/string>/);
});

test("the web plist keeps its arguments and has no throttle", () => {
  const plist = buildPlist({ label: LABEL, args: ["/usr/local/bin/npx", "--yes", "pkg & co"], env, logName: "ompweb" });
  assert.match(plist, /<string>pkg &amp; co<\/string>\n  <\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /ThrottleInterval/);
  assert.doesNotMatch(plist, /<string>host<\/string>/);
});
