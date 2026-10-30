import fs from "node:fs";
const f = "/tmp/bunspike/xprobe.sh";
fs.rmSync(f, { force: true });
fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
let access;
try { access = fs.accessSync(f, fs.constants.X_OK); } catch (e) { access = e.code; }
console.log(`${typeof Bun !== "undefined" ? "bun" : "node"}: mode=${(fs.statSync(f).mode & 0o777).toString(8)} accessSync(X_OK) returned ${JSON.stringify(access)} (=== undefined: ${access === undefined})`);
