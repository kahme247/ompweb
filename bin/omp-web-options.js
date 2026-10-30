"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hashPassword, isPasswordHash } = require("./omp-web-password-hash");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isLoopbackHost } = require("./network-addresses");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/** Legacy plaintext credential: detected so `ompweb` can migrate (env) or refuse (flag) it. */
function legacyPassword(args, env) {
  const flagIndex = args.findIndex((arg) => arg === "--password" || arg.startsWith("--password="));
  if (flagIndex !== -1) {
    const arg = args[flagIndex];
    const inline = arg.startsWith("--password=") ? arg.slice("--password=".length) : undefined;
    const value = inline !== undefined ? inline : (args[flagIndex + 1] ?? "");
    return { value, source: "flag" };
  }
  const fromEnv = env.OMP_WEB_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { value: fromEnv, source: "env" };
  return undefined;
}

function printHelp() {
  console.log(`Usage: ompweb [options]

Options:
  -p, --port <port>        Server port (default 30177, env PORT)
  -H, --hostname <host>    Bind hostname (default 127.0.0.1, env OMP_WEB_HOSTNAME)
      --no-open            Do not open the browser automatically
      --install-tray       Install system tray service & shortcuts (Windows tray / Linux SNI tray)
      --uninstall-tray     Uninstall system tray service & shortcuts
      --tray               Start background system tray manager
  -h, --help               Show this help
      --version            Show version

Commands:
  hash-password            Read a password from stdin and print the value for
                           OMP_WEB_PASSWORD_HASH

Password:
  ompweb hash-password                       # prompts, input hidden
  echo "a-long-random-password" | ompweb hash-password
  OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$...' ompweb

  ompweb never passes a plaintext password on: --password is rejected, and an
  OMP_WEB_PASSWORD is hashed at startup with a warning that prints its hash
  (set alongside OMP_WEB_PASSWORD_HASH, it is rejected), because every omp
  session inherits the environment and an agent could print the password
  into its transcript.

Security: use HTTPS via a trusted reverse proxy or VPN when binding to a
non-loopback hostname, so the password and session cookie stay private.`);
}

/**
 * Resolve launch options from argv and the environment. A legacy plaintext
 * password (env or `--password`) is reported instead of parsed: the caller
 * migrates or refuses it rather than passing it to the server.
 */
function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      help:      { type: "boolean", short: "h" },
      version:   { type: "boolean" },
      "no-open":         { type: "boolean" },
      "install-tray":    { type: "boolean" },
      "install-service": { type: "boolean" },
      "uninstall-tray":  { type: "boolean" },
      tray:              { type: "boolean" },
    },
    strict: false,
  });

  const passwordHash = typeof env.OMP_WEB_PASSWORD_HASH === "string" ? env.OMP_WEB_PASSWORD_HASH.trim() : undefined;
  const legacy = legacyPassword(args, env);

  const shared = {
    port: cliArgs.port ?? env.PORT ?? "30177",
    hostname: cliArgs.hostname ?? env.OMP_WEB_HOSTNAME ?? "127.0.0.1",
    passwordHash,
    legacyPassword: legacy?.value,
    legacyPasswordSource: legacy?.source,
    openBrowser: !cliArgs["no-open"] && !isEnabled(env.OMP_WEB_NO_OPEN),
    installTray: Boolean(cliArgs["install-tray"] || cliArgs["install-service"]),
    uninstallTray: Boolean(cliArgs["uninstall-tray"]),
    tray: Boolean(cliArgs.tray),
  };

  if (cliArgs.version) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require("../package.json");
      console.log(pkg.version ?? "0.0.0");
    } catch { console.log("0.0.0"); }
    return { ...shared, version: true };
  }
  // Expose help flag without exiting here — caller (bin/omp-web.js) decides
  // whether to exit, keeping parseLaunchOptions testable. Print here so
  // --help works even when the caller is a test.
  if (cliArgs.help) {
    printHelp();
    return { ...shared, help: true };
  }
  return shared;
}

/**
 * The password and bind checks before a server starts (bin/omp-web.js, server/binary.ts). Only a password hash reaches
 * the server (issue #239): a plaintext OMP_WEB_PASSWORD alone is migrated, hashed into OMP_WEB_PASSWORD_HASH and
 * removed from process.env before any child can inherit it. The removed --password flag, a plaintext set next to a
 * hash, an invalid hash, or a non-loopback bind without a password print why and exit 1.
 * @returns {string | undefined} the password hash, if any
 */
function checkLaunchSecurity(launchOptions) {
  let passwordHash = launchOptions.passwordHash;
  if (launchOptions.legacyPasswordSource === "env" && !passwordHash) {
    passwordHash = hashPassword(process.env.OMP_WEB_PASSWORD);
    process.env.OMP_WEB_PASSWORD_HASH = passwordHash;
    delete process.env.OMP_WEB_PASSWORD;
    console.warn([
      "Warning: OMP_WEB_PASSWORD holds a plaintext password. This option has been deprecated and is marked for removal.",
      "",
      "Every omp session inherits omp-web's environment, so an agent could print",
      "the password into its transcript. ompweb hashed it and kept it out of the",
      "server's environment, but agents can still read it from this launcher",
      "process, and a new hash is made on every start, which signs every browser",
      "out on each restart.",
      "",
      "Remove OMP_WEB_PASSWORD and set this instead:",
      "",
      `  OMP_WEB_PASSWORD_HASH='${passwordHash}'`,
    ].join("\n"));
  } else if (launchOptions.legacyPasswordSource === "env") {
    console.error("OMP_WEB_PASSWORD_HASH and the plaintext OMP_WEB_PASSWORD are both set. Remove OMP_WEB_PASSWORD.");
    process.exit(1);
  } else if (launchOptions.legacyPassword !== undefined) {
    console.error([
      "ompweb no longer accepts a plaintext password: the --password flag was removed.",
      "Every omp session inherits this process's environment, so an agent could",
      "print the password into its transcript.",
      "",
      "Create a hash and use that instead:",
      "",
      "  ompweb hash-password",
      "  OMP_WEB_PASSWORD_HASH='scrypt$...' ompweb",
    ].join("\n"));
    process.exit(1);
  }
  if (passwordHash !== undefined && !isPasswordHash(passwordHash)) {
    console.error(`OMP_WEB_PASSWORD_HASH is not a valid password hash.\n\nGenerate one with: ompweb hash-password`);
    process.exit(1);
  }
  const { hostname } = launchOptions;
  if (!isLoopbackHost(hostname)) {
    if (passwordHash === undefined) {
      console.error(`Refusing to listen on ${hostname} without a password hash. Run: ompweb hash-password, then set OMP_WEB_PASSWORD_HASH. Or bind to 127.0.0.1.`);
      process.exit(1);
    }
    console.warn(`Warning: ompweb is listening on ${hostname} over HTTP. Use HTTPS or a trusted VPN to protect the password and session cookie in transit.`);
  }
  return passwordHash;
}

module.exports = { checkLaunchSecurity, parseLaunchOptions, printHelp };
