// The compiled `ompweb` (scripts/build-binary.ts): the web server by default, with the npm launcher's flags and
// password env, `ompweb host` (the session daemon) and `ompweb hash-password`. The server runs in this process: there
// is no launcher, so no in-app update, tray or service installer. Static root: the directory the executable sits in
// (dist/, public/, node_modules/katex/, lib/omp/session-edit-extension.mjs), unless OMP_WEB_PACKAGE_DIR names another.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import packageJson from "../package.json";
import { formatAddressBanner, getAccessibleAddresses, getBrowserUrl, openInBrowser } from "../bin/network-addresses";
import { runHashPasswordCommand } from "../bin/omp-web-hash-password";
import { checkLaunchSecurity, parseLaunchOptions } from "../bin/omp-web-options";
import { runHostCli } from "@/lib/hosts/host-cli";

// Before any server module loads: app/api/manifest reads public/ from it when it loads, and the daemon names
// lib/omp/session-edit-extension.mjs in it to omp.
process.env.OMP_WEB_PACKAGE_DIR ??= path.dirname(realpathSync(process.execPath));
const root = process.env.OMP_WEB_PACKAGE_DIR;
const SEE_README = "README.md (Single binary) shows how to run `ompweb` and `ompweb host` as services instead.";

const command = process.argv[2];
if (command === "host") process.exit(await runHostCli(process.argv.slice(3)));
if (command === "hash-password" || command === "hash_password") {
  process.exit(await runHashPasswordCommand().catch((error: unknown) => {
    console.error(`Could not hash the password: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }));
}
if (["launchd", "ompweb-launchd", "systemd", "ompweb-systemd"].includes(command)) {
  console.error(`The ompweb binary has no service installer. ${SEE_README}`);
  process.exit(2);
}

const options = parseLaunchOptions();
if (options.help || options.version) process.exit(0);
if (options.installTray || options.uninstallTray || options.tray) {
  console.error(`The ompweb binary has no tray. ${SEE_README}`);
  process.exit(2);
}
const passwordHash = checkLaunchSecurity(options);
if (!existsSync(path.join(root, "dist", "index.html"))) {
  console.error(`No dist/index.html in ${root}. Keep the ompweb binary in the directory it was released in, or set OMP_WEB_PACKAGE_DIR to that directory.`);
  process.exit(1);
}
const { hostname, port } = options;
// What the npm launcher hands its server: the local daemon link (instrumentation.node.ts) dials this address.
Object.assign(process.env, { OMP_WEB_PORT: port, OMP_WEB_HOSTNAME: hostname });
// Loaded after the environment above is set, for the modules that read it when they load.
const { startProduction } = await import("./app");
await startProduction({ port: Number(port), hostname });
const { entries, hint } = getAccessibleAddresses({ hostname, port });
process.stdout.write(formatAddressBanner({ version: packageJson.version, entries, hint, passwordEnabled: passwordHash !== undefined, isTTY: process.stdout.isTTY }));
if (options.openBrowser) openInBrowser(getBrowserUrl(hostname, port));
