import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  candidateAddresses,
  classifyExposure,
  DEFAULT_MOBILE_PORT,
  detectBindHostname,
  mobileAccessMethods,
  parseMagicDns,
  parseMobilePort,
} = await jiti.import("./mobile-access.ts");

// Only the fields the candidate scan reads; a netmask/mac fixture would only
// add address-shaped literals that are not part of the contract.
const iface = (address, { internal = false, family = "IPv4" } = {}) => ({ address, family, internal });

test("port parsing accepts only real TCP ports", () => {
  assert.equal(parseMobilePort("30177"), 30177);
  assert.equal(parseMobilePort(443), 443);
  assert.equal(parseMobilePort("0"), null);
  assert.equal(parseMobilePort("65536"), null);
  assert.equal(parseMobilePort("12x"), null);
  assert.equal(parseMobilePort(""), null);
  assert.equal(parseMobilePort(undefined), null);
});

test("bind hostname comes from OMP_WEB_HOSTNAME, which every entry point writes", () => {
  assert.equal(detectBindHostname({ OMP_WEB_HOSTNAME: "0.0.0.0" }), "0.0.0.0");
  assert.equal(detectBindHostname({ OMP_WEB_HOSTNAME: " 192.168.1.5 " }), "192.168.1.5");
  assert.equal(detectBindHostname({}), null);
  assert.equal(detectBindHostname({ OMP_WEB_HOSTNAME: "   " }), null);
});

test("exposure distinguishes loopback, wildcard/network and an unknown dev server", () => {
  assert.equal(classifyExposure("127.0.0.1"), "loopback");
  assert.equal(classifyExposure("localhost"), "loopback");
  assert.equal(classifyExposure("::1"), "loopback");
  assert.equal(classifyExposure("0.0.0.0"), "network");
  assert.equal(classifyExposure("192.168.1.5"), "network");
  assert.equal(classifyExposure(null), "unknown");
});

test("addresses skip loopback/link-local and put MagicDNS, then Tailscale, then LAN", () => {
  // Synthetic fixtures only: RFC 1918, link-local and CGNAT addresses.
  const interfaces = {
    "Loopback Pseudo-Interface 1": [iface("127.0.0.1", { internal: true })],
    Ethernet: [iface("192.168.178.20"), iface("169.254.10.5"), iface("fe80::1", { family: "IPv6" })],
    "Tailscale": [iface("100.101.102.103")],
    WLAN: [iface("192.168.178.21", { family: 4 })],
  };
  // A wildcard bind is the only case that lists interfaces; the helper's
  // "Local" (loopback) entry is dropped because a phone cannot reach it, and
  // Tailscale is listed before LAN (a phone away from home needs it first).
  assert.deepEqual(candidateAddresses({ hostname: "0.0.0.0", interfaces, port: 30177, magicDnsName: "pc.tailnet.ts.net." }), [
    { url: "http://pc.tailnet.ts.net:30177", label: "magicdns" },
    { url: "http://100.101.102.103:30177", label: "tailscale" },
    { url: "http://192.168.178.20:30177", label: "lan" },
    { url: "http://192.168.178.21:30177", label: "lan" },
  ]);
});

test("a specific-IP bind offers that address only, a loopback bind none", () => {
  // The regression the maintainer probed: a duplicate enumeration ignored the
  // binding and offered every interface address for a single-IP bind.
  const interfaces = {
    Ethernet: [iface("192.168.178.20")],
    "Tailscale": [iface("100.101.102.103")],
    WLAN: [iface("192.168.178.21")],
  };
  assert.deepEqual(candidateAddresses({ hostname: "192.168.178.21", interfaces, port: 30177 }), [
    { url: "http://192.168.178.21:30177", label: "lan" },
  ]);

  // Loopback: the helper reports the local URL and a hint; a phone gets nothing
  // usable, so the card shows no address rather than a 127.0.0.1 one. MagicDNS
  // is suppressed too: that name resolves to an address this server is not
  // listening on, so offering it would promise a reachability that is absent.
  assert.deepEqual(candidateAddresses({ hostname: "127.0.0.1", interfaces, port: 30177, magicDnsName: "pc.tailnet.ts.net" }), []);
  assert.deepEqual(candidateAddresses({ hostname: null, interfaces, port: 30177 }), []);
});

test("no interfaces still returns the MagicDNS address; duplicate addresses appear once", () => {
  assert.deepEqual(candidateAddresses({ hostname: "0.0.0.0", interfaces: {}, port: 30177, magicDnsName: "pc.tailnet.ts.net" }), [
    { url: "http://pc.tailnet.ts.net:30177", label: "magicdns" },
  ]);
  const interfaces = { Tailscale: [iface("100.64.0.1")], WLAN: [iface("100.64.0.1")] };
  assert.deepEqual(
    candidateAddresses({ hostname: "0.0.0.0", interfaces, port: 1 }).map((entry) => entry.url),
    ["http://100.64.0.1:1"],
  );
});

test("MagicDNS is advertised only when the bind covers the Tailscale address", () => {
  // RFC 5737 documentation addresses: a LAN-shaped bind without publishing a
  // real network's numbering.
  const interfaces = {
    Ethernet: [iface("203.0.113.10")],
    Tailscale: [iface("100.101.102.103")],
  };
  // A socket bound to one LAN IP does not listen on the Tailscale IP, so the
  // MagicDNS name would resolve to an address nothing is listening on.
  assert.deepEqual(
    candidateAddresses({ hostname: "203.0.113.10", port: 30177, magicDnsName: "node.example.ts.net", interfaces }),
    [{ url: "http://203.0.113.10:30177", label: "lan" }],
  );
  // A specific bind on a non-Tailscale address is the same case, with no
  // interface map at all.
  assert.deepEqual(
    candidateAddresses({ hostname: "203.0.113.11", port: 30177, magicDnsName: "node.example.ts.net", interfaces: {} }),
    [{ url: "http://203.0.113.11:30177", label: "lan" }],
  );
  // A wildcard bind listens on every interface, so the name is reachable.
  assert.deepEqual(
    candidateAddresses({ hostname: "0.0.0.0", port: 30177, magicDnsName: "node.example.ts.net", interfaces: {} }),
    [{ url: "http://node.example.ts.net:30177", label: "magicdns" }],
  );
  // A bind on the Tailscale address itself covers it, and the bound address is
  // the Tailscale one — both values sit in the helper's CGNAT range, so the
  // entry is labelled `tailscale` rather than `lan`.
  assert.deepEqual(
    candidateAddresses({ hostname: "100.64.0.1", port: 30177, magicDnsName: "node.example.ts.net", interfaces }),
    [
      { url: "http://node.example.ts.net:30177", label: "magicdns" },
      { url: "http://100.64.0.1:30177", label: "tailscale" },
    ],
  );
  assert.deepEqual(
    candidateAddresses({ hostname: "100.127.255.254", port: 30177, magicDnsName: "node.example.ts.net", interfaces: {} }),
    [
      { url: "http://node.example.ts.net:30177", label: "magicdns" },
      { url: "http://100.127.255.254:30177", label: "tailscale" },
    ],
  );
});

test("a specific-IP bind keeps its address kind and brackets IPv6", () => {
  // A bind on the tailnet IP is the Tailscale address, not a LAN one: the card
  // labels it so the user knows which network it needs to be on.
  assert.deepEqual(
    candidateAddresses({ hostname: "100.90.1.2", port: 30177, interfaces: {} }),
    [{ url: "http://100.90.1.2:30177", label: "tailscale" }],
  );
  // A specific IPv6 bind must produce a parseable URL, not `http://fd7a:...:30177`
  // (which a browser reads as host `fd7a` and a nonsense port).
  assert.deepEqual(
    candidateAddresses({ hostname: "fd7a:115c:a1e0::1", port: 30177, interfaces: {} }),
    [{ url: "http://[fd7a:115c:a1e0::1]:30177", label: "lan" }],
  );
  assert.deepEqual(
    candidateAddresses({ hostname: "fd7a:115c:a1e0::1", port: 30177, magicDnsName: "node.example.ts.net", interfaces: {} }),
    [{ url: "http://[fd7a:115c:a1e0::1]:30177", label: "lan" }],
    "an IPv6 bind that is not the Tailscale address does not advertise MagicDNS",
  );
});

test("MagicDNS parsing accepts only a plausible Self.DNSName", () => {
  assert.equal(parseMagicDns(JSON.stringify({ Self: { DNSName: "pc.tailnet.ts.net." } })), "pc.tailnet.ts.net");
  assert.equal(parseMagicDns(JSON.stringify({ Self: { DNSName: "  " } })), null);
  assert.equal(parseMagicDns(JSON.stringify({ Self: { DNSName: "bad name" } })), null);
  assert.equal(parseMagicDns(JSON.stringify({ Self: {} })), null);
  assert.equal(parseMagicDns(JSON.stringify({})), null);
  assert.equal(parseMagicDns("not json"), null);
});

test("tailscale is resolved from its install location, never from PATH", async (t) => {
  const { tailscaleBinary } = await jiti.import("./mobile-access.ts");
  const fakeDir = mkdtempSync(join(tmpdir(), "omp-web-tailscale-"));
  const fake = join(fakeDir, process.platform === "win32" ? "tailscale.exe" : "tailscale");
  writeFileSync(fake, "");
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeDir}${delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(fakeDir, { recursive: true, force: true });
  });

  // A PATH entry (a project, an npm bin, ~/.local/bin) must never be executed:
  // it would run with the server's environment and could read the login hash.
  const binary = tailscaleBinary();
  assert.notEqual(binary, fake);
  if (binary !== null) assert.ok(isAbsolute(binary), `${binary} must be an absolute install path`);
});

test("every start mode carries exact commands and no real secret", () => {
  const methods = mobileAccessMethods();
  assert.deepEqual(methods.map((method) => method.id), ["cli", "windowsTray", "systemd", "launchd"]);
  assert.ok(methods.every((method) => method.commands.length >= 1 && method.commands.every((command) => typeof command === "string" && command.length > 0)));
  assert.equal(DEFAULT_MOBILE_PORT, 30177);
  const joined = methods.flatMap((method) => method.commands).join("\n");
  assert.match(joined, /ompweb hash-password/);
  assert.match(joined, /ompweb-systemd install/);
  assert.match(joined, /ompweb-launchd install/);
  assert.match(joined, /ompweb --install-tray/);
  assert.doesNotMatch(joined, /scrypt\$1\$/);
  // No command carries a value: a plaintext password or a hash on the command
  // line would land in the shell history and in `ps`. Each install method
  // reads the hash at a hidden prompt instead.
  for (const command of methods.flatMap((method) => method.commands)) {
    assert.doesNotMatch(command, /OMP_WEB_PASSWORD(_HASH)?=['"]/, `command must not assign a secret inline: ${command}`);
  }
  assert.match(joined, /read -rs OMP_WEB_PASSWORD_HASH/);
  assert.match(joined, /Read-Host -AsSecureString/);
  // `read -p` is a zsh coprocess read, not a prompt: macOS's default shell
  // would fail with `read: -p: no coprocess` and never read the hash.
  assert.doesNotMatch(joined, /read -[a-z]*p/, "no POSIX-shell read may use -p: zsh reads a coprocess instead");
});

/** Locate a POSIX shell that can run the generated sequences. */
function shellForFlow() {
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    return existsSync(gitBash) ? { binary: gitBash, args: [] } : null;
  }
  return existsSync("/bin/bash") ? { binary: "/bin/bash", args: [] } : null;
}

test("the launchd setup reads, exports and hands the hash to the installer in a real shell", async (t) => {
  const shell = shellForFlow();
  if (!shell) {
    t.skip("no POSIX shell available to execute the generated commands");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "omp-web-launchd-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Stub `ompweb` and `ompweb-launchd` on PATH, so the exact generated strings
  // run unmodified and the installer reports what it actually received.
  const stub = (name, body) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  stub("ompweb", 'echo "STUB_HASH_PASSWORD"');
  stub(
    "ompweb-launchd",
    'echo "LAUNCHD hostname=$OMP_WEB_HOSTNAME hash=${OMP_WEB_PASSWORD_HASH}"',
  );

  const launchd = mobileAccessMethods().find((method) => method.id === "launchd");
  assert.ok(launchd);
  const script = [
    "set -u",
    ...launchd.commands,
  ].join("\n");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(shell.binary, [...shell.args, "-c", script], {
    input: `${KNOWN_HASH}\n`,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      // A stale value must be replaced by the hidden read, not inherited.
      OMP_WEB_PASSWORD_HASH: "stale-value-from-the-parent-shell",
    },
  });

  assert.equal(result.status, 0, `the generated flow must succeed; stderr: ${result.stderr}`);
  assert.match(result.stdout, /STUB_HASH_PASSWORD/, "the hash-password step runs first");
  // The prompt is printed by printf, so it appears even though the read is hidden.
  assert.match(result.stdout, /OMP_WEB_PASSWORD_HASH: /, "the hidden read prints its prompt");
  // The value reached the installer through the environment, not argv.
  assert.match(result.stdout, new RegExp(`LAUNCHD hostname=0\\.0\\.0\\.0 hash=${KNOWN_HASH.replace(/\$/g, "\\$")}`));
  assert.doesNotMatch(result.stdout, /stale-value-from-the-parent-shell/);
});

test("the exported hash survives into the installer's environment, not its command line", async (t) => {
  const shell = shellForFlow();
  if (!shell) {
    t.skip("no POSIX shell available to execute the generated commands");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "omp-web-launchd-argv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The installer records its own argv; the hash must not be in it.
  const file = join(dir, "ompweb-launchd");
  writeFileSync(file, '#!/bin/sh\nfor arg in "$@"; do echo "ARG:$arg"; done\n', { mode: 0o755 });
  const readHash = mobileAccessMethods()
    .find((method) => method.id === "launchd")
    .commands
    .find((command) => command.includes("read -rs"));
  assert.ok(readHash);

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(shell.binary, [...shell.args, "-c", `${readHash}\nOMP_WEB_HOSTNAME=0.0.0.0 ompweb-launchd install`], {
    input: `${KNOWN_HASH}\n`,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /ARG:install/);
  assert.doesNotMatch(result.stdout, /scrypt\$/, "the hash must never appear in argv");
});

/** Run `body` with the given environment variables set, restoring them after. */
async function withEnv(vars, body) {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A well-formed hash this build accepts. Fixed, so the leak assertion below
// runs whether or not the calling environment has a password configured.
const KNOWN_HASH = "scrypt$12$8$1$BwcHBwcHBwcHBwcHBwcHBw$CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

test("the route reports binding, password state, addresses and methods without secrets", async () => {
  const route = await jiti.import("../app/api/mobile-access/route.ts");
  await withEnv({ OMP_WEB_PASSWORD_HASH: KNOWN_HASH }, async () => {
    const response = await route.GET(new Request("http://localhost:30999/api/mobile-access"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.binding.port, 30999);
    assert.ok(["loopback", "network", "unknown"].includes(body.binding.exposure));
    // The test sets the hash itself, so this asserts the contract instead of
    // skipping when the machine happens to have no password configured.
    assert.equal(body.password.configured, true);
    assert.equal(body.password.problem, false);
    assert.ok(Array.isArray(body.addresses));
    assert.ok(body.addresses.every((address) => address.url.startsWith("http://") && address.url.endsWith(":30999") && ["magicdns", "tailscale", "lan"].includes(address.label)));
    assert.deepEqual(body.methods.map((method) => method.id), ["cli", "windowsTray", "systemd", "launchd"]);
    assert.equal(JSON.stringify(body).includes(KNOWN_HASH), false, "the configured hash never leaves the server");
    assert.equal(JSON.stringify(body).includes("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"), false, "not even the digest half");
  });
});

test("the route prefers the bound port over the request URL and PORT", async () => {
  const route = await jiti.import("../app/api/mobile-access/route.ts");
  // Production records the actual listener in OMP_WEB_PORT (server/app.ts).
  // Behind a proxy the request URL names the proxy's port, and PORT is only
  // the launcher's intent, so both must lose against the bound port.
  await withEnv({ OMP_WEB_PORT: "30180", PORT: "30181" }, async () => {
    const body = await (await route.GET(new Request("http://localhost:30999/api/mobile-access"))).json();
    assert.equal(body.binding.port, 30180);
    assert.ok(body.addresses.every((address) => address.url.endsWith(":30180")));
  });

  // No bound port (dev server): the request URL is the next best fact.
  await withEnv({ OMP_WEB_PORT: undefined, PORT: "30181" }, async () => {
    const body = await (await route.GET(new Request("http://localhost:30999/api/mobile-access"))).json();
    assert.equal(body.binding.port, 30999);
  });
});
