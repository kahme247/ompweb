import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  buildUnit,
  escapeUnitPath,
  escapeUnitValue,
  formatExecStart,
  launcherInterpreterDir,
  readLauncherInterpreter,
  resolveOmpwebBin,
  runCli,
  validateHostname,
  validatePort,
} = require("./omp-web-systemd.js");
const {
  parseServiceEnv,
  serializeServiceEnv,
  writeServiceEnv,
} = require("./service-env.js");

test("service env files round-trip quoted values", () => {
  const serialized = serializeServiceEnv({
    PORT: "30177",
    OMP_WEB_HOSTNAME: "0.0.0.0",
    OMP_WEB_PASSWORD: 'secret\\with"quotes',
  });

  assert.match(serialized, /OMP_WEB_PASSWORD="secret\\\\with\\"quotes"/);
  assert.deepEqual(parseServiceEnv(serialized), {
    PORT: "30177",
    OMP_WEB_HOSTNAME: "0.0.0.0",
    OMP_WEB_PASSWORD: 'secret\\with"quotes',
  });
});

test("writeServiceEnv creates the parent directory and a private file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-service-env-"));
  try {
    const envPath = path.join(dir, "nested", "web-service.env");
    writeServiceEnv({ PORT: "40100", OMP_WEB_HOSTNAME: "127.0.0.1" }, envPath);
    assert.deepEqual(parseServiceEnv(readFileSync(envPath, "utf8")), {
      PORT: "40100",
      OMP_WEB_HOSTNAME: "127.0.0.1",
    });
    if (process.platform !== "win32") assert.equal(statSync(envPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildUnit points at the generated env file and keeps runtime settings out of the unit", () => {
  const unit = buildUnit({
    ompwebBin: "/usr/local/bin/ompweb",
    env: { OMP_WEB_OMP_BIN: "/home/u/.bun/bin/omp" },
    home: "/home/u",
    envPath: "/home/u/.omp/agent/web-service.env",
  });

  assert.match(unit, /ExecStart=\/usr\/local\/bin\/ompweb\n/);
  assert.match(unit, /WorkingDirectory=%h/);
  assert.match(unit, /EnvironmentFile=\/home\/u\/\.omp\/agent\/web-service\.env/);
  assert.doesNotMatch(unit, /PORT=/);
  assert.doesNotMatch(unit, /OMP_WEB_PASSWORD/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StartLimitIntervalSec=60/);
  assert.match(unit, /StartLimitBurst=5/);
  assert.match(unit, /WantedBy=default\.target/);
  if (process.platform === "linux") {
    assert.match(unit, /"PATH=\/home\/u\/\.bun\/bin:\/usr\/local\/bin:.*\/usr\/bin:\/bin"/);
  }
});

test("buildUnit adds the launcher interpreter dir for Bun/npm installs of omp", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-bun-"));
  try {
    const fakeBinDir = path.join(dir, "local", "bin");
    const fakeBunDir = path.join(dir, "mise", "shims");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(fakeBunDir, { recursive: true });
    // Bun global installs are launcher scripts needing `bun` at runtime.
    writeFileSync(path.join(fakeBinDir, "omp"), "#!/usr/bin/env bun\n", { mode: 0o755 });
    writeFileSync(path.join(fakeBunDir, "bun"), "#!/bin/sh\n", { mode: 0o755 });

    assert.equal(readLauncherInterpreter(path.join(fakeBinDir, "omp")), "bun");
    assert.equal(
      launcherInterpreterDir(path.join(fakeBinDir, "omp"), { PATH: [fakeBunDir, "/usr/bin"].join(path.delimiter) }),
      fakeBunDir,
    );
    // Null when the interpreter is not installed: keep the old PATH shape.
    assert.equal(launcherInterpreterDir(path.join(fakeBinDir, "omp"), { PATH: "/usr/bin" }), null);

    const unit = buildUnit({
      ompwebBin: "/usr/local/bin/ompweb",
      env: { OMP_WEB_OMP_BIN: path.join(fakeBinDir, "omp") },
      home: "/home/u",
      envPath: "/home/u/.omp/agent/web-service.env",
    });
    const pathLine = unit.split("\n").find((line) => line.startsWith("Environment="));
    assert.ok(pathLine?.includes(`PATH=${escapeUnitValue(fakeBinDir)}${path.delimiter}`), `unit PATH missing omp dir: ${pathLine}`);
    assert.ok(!pathLine?.includes(escapeUnitValue(fakeBunDir)), `unit PATH should not invent a bun dir: ${pathLine}`);
    // Native binaries have no shebang: PATH keeps the old shape.
    writeFileSync(path.join(fakeBinDir, "omp-native"), "\x7fELF-native-binary", { mode: 0o755 });
    assert.equal(readLauncherInterpreter(path.join(fakeBinDir, "omp-native")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit helpers escape systemd values and paths", () => {
  assert.equal(escapeUnitValue("100%h"), "100%%h");
  assert.equal(escapeUnitValue('quo"te\\'), 'quo\\"te\\\\');
  assert.equal(escapeUnitPath("/home/user name/web-service.env"), "/home/user\\x20name/web-service.env");
  assert.equal(escapeUnitPath("/home/100%name/web-service.env"), "/home/100%%name/web-service.env");
  assert.equal(formatExecStart("/usr/local/bin/ompweb"), "/usr/local/bin/ompweb");
  assert.equal(formatExecStart("/home/user name/ompweb"), '"/home/user name/ompweb"');
});

test("resolveOmpwebBin honors an executable override", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-"));
  try {
    const fake = path.join(dir, "ompweb");
    writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(resolveOmpwebBin({ OMP_WEB_SYSTEMD_BIN: fake }), fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("port and hostname validation rejects unsafe values", () => {
  assert.equal(validatePort("30177"), "30177");
  assert.equal(validateHostname("0.0.0.0"), "0.0.0.0");
  assert.throws(() => validatePort("0"), /invalid port/);
  assert.throws(() => validatePort("65536"), /invalid port/);
  assert.throws(() => validatePort("not-a-port"), /invalid port/);
  assert.throws(() => validateHostname("  "), /hostname must not be empty/);
});

test("install creates the env file and unit with LAN settings", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-install-"));
  try {
    const home = path.join(dir, "home");
    const binDir = path.join(dir, "bin");
    const fakeOmpweb = path.join(binDir, "ompweb");
    const fakeSystemctl = path.join(binDir, "systemctl");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakeOmpweb, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(fakeSystemctl, "#!/bin/sh\ncase \"$*\" in *is-active*) exit 3 ;; *) exit 0 ;; esac\n", { mode: 0o755 });

    const childEnv = {
      ...process.env,
      HOME: home,
      PATH: binDir,
      OMP_WEB_SYSTEMD_BIN: fakeOmpweb,
      OMP_WEB_HOSTNAME: "0.0.0.0",
      OMP_WEB_PASSWORD: "test-password",
      OMP_WEB_NO_OPEN: "0",
      PORT: "40123",
    };
    delete childEnv.PI_CODING_AGENT_DIR;
    delete childEnv.OMP_WEB_OMP_BIN;

    const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "omp-web-systemd.js"), "install", "--no-autostart"], {
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const envPath = path.join(home, ".omp", "agent", "web-service.env");
    const unitPath = path.join(home, ".config", "systemd", "user", "ompweb.service");
    assert.deepEqual(parseServiceEnv(readFileSync(envPath, "utf8")), {
      PORT: "40123",
      OMP_WEB_HOSTNAME: "0.0.0.0",
      OMP_WEB_NO_OPEN: "0",
      OMP_WEB_PASSWORD: "test-password",
    });
    assert.match(readFileSync(unitPath, "utf8"), /EnvironmentFile=.*web-service\.env/);
    assert.match(result.stdout, /config:.*web-service\.env/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install fails loudly when the omp launcher interpreter is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ompweb-systemd-missing-interp-"));
  try {
    const binDir = path.join(dir, "bin");
    const fakeOmpweb = path.join(binDir, "ompweb");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(fakeOmpweb, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Launcher script needing an interpreter that is nowhere on PATH.
    writeFileSync(path.join(binDir, "omp"), "#!/usr/bin/env bun\n", { mode: 0o755 });

    const childEnv = {
      ...process.env,
      PATH: [binDir, path.dirname(process.execPath)].join(path.delimiter),
      OMP_WEB_SYSTEMD_BIN: fakeOmpweb,
      OMP_WEB_OMP_BIN: path.join(binDir, "omp"),
      PORT: "40123",
    };
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "omp-web-systemd.js"), "install", "--no-autostart"], {
      env: childEnv,
      encoding: "utf8",
    });
    // runCli fails before the platform gate (platform-agnostic message).
    assert.match(result.stderr, /interpreter.*bun.*not found on PATH/);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main ompweb bin forwards the systemd subcommand", () => {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "omp-web.js"), "systemd", "--version"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), require("../package.json").version);
});

test("runCli handles help and unknown commands without systemd", async () => {
  assert.deepEqual((await runCli(["--help"])).exitCode, 0);
  assert.deepEqual((await runCli(["bogus-command"])).exitCode, 2);
});
