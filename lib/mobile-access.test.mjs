import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  isTailscaleIpv4,
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

test("bind hostname comes from the documented env override, then Next's -H flag", () => {
  assert.equal(detectBindHostname({ OMP_WEB_HOSTNAME: "0.0.0.0" }, ["node", "server", "-H", "127.0.0.1"]), "0.0.0.0");
  assert.equal(detectBindHostname({}, ["next", "dev", "-H", "0.0.0.0"]), "0.0.0.0");
  assert.equal(detectBindHostname({}, ["next", "start", "--hostname=192.168.1.5"]), "192.168.1.5");
  assert.equal(detectBindHostname({}, ["next", "start"]), null);
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
  assert.deepEqual(candidateAddresses({ interfaces, port: 30177, magicDnsName: "pc.tailnet.ts.net." }), [
    { url: "http://pc.tailnet.ts.net:30177", label: "magicdns" },
    { url: "http://100.101.102.103:30177", label: "tailscale" },
    { url: "http://192.168.178.20:30177", label: "lan" },
    { url: "http://192.168.178.21:30177", label: "lan" },
  ]);
});

test("no interfaces still returns the MagicDNS address; duplicate addresses appear once", () => {
  assert.deepEqual(candidateAddresses({ interfaces: {}, port: 30177, magicDnsName: "pc.tailnet.ts.net" }), [
    { url: "http://pc.tailnet.ts.net:30177", label: "magicdns" },
  ]);
  const interfaces = { Tailscale: [iface("100.64.0.1")], WLAN: [iface("100.64.0.1")] };
  assert.deepEqual(candidateAddresses({ interfaces, port: 1 }).map((entry) => entry.url), ["http://100.64.0.1:1"]);
});

test("Tailscale CGNAT detection is 100.64.0.0/10 only", () => {
  assert.equal(isTailscaleIpv4("100.64.0.1"), true);
  assert.equal(isTailscaleIpv4("100.127.255.254"), true);
  // The first address past 100.64.0.0/10 is a public one.
  assert.equal(isTailscaleIpv4("100.128.0.1"), false);
  assert.equal(isTailscaleIpv4("192.168.1.2"), false);
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
});

test("the route reports binding, password state, addresses and methods without secrets", async () => {
  const route = await jiti.import("../app/api/mobile-access/route.ts");
  const response = await route.GET(new Request("http://localhost:30999/api/mobile-access"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.binding.port, 30999);
  assert.ok(["loopback", "network", "unknown"].includes(body.binding.exposure));
  assert.equal(typeof body.password.configured, "boolean");
  assert.equal(typeof body.password.problem, "boolean");
  assert.ok(Array.isArray(body.addresses));
  assert.ok(body.addresses.every((address) => address.url.startsWith("http://") && address.url.endsWith(":30999") && ["magicdns", "tailscale", "lan"].includes(address.label)));
  assert.deepEqual(body.methods.map((method) => method.id), ["cli", "windowsTray", "systemd", "launchd"]);
  const configured = (process.env.OMP_WEB_PASSWORD_HASH ?? "").trim();
  if (configured) assert.equal(JSON.stringify(body).includes(configured), false, "the configured hash never leaves the server");
  assert.match(body.methods[0].commands.join("\n"), /scrypt\$…/);
});
