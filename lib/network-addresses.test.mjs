import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  isWildcardHost,
  isLoopbackHost,
  getBrowserUrl,
  isTailscaleAddress,
  isIgnoredAddress,
  getAccessibleAddresses,
  formatAddressBanner,
} = require("../bin/network-addresses.js");

test("identifies wildcard hostnames", () => {
  assert.equal(isWildcardHost("0.0.0.0"), true);
  assert.equal(isWildcardHost("::"), true);
  assert.equal(isWildcardHost("0:0:0:0:0:0:0:0"), true);
  assert.equal(isWildcardHost(""), true);
  assert.equal(isWildcardHost(undefined), true);
  assert.equal(isWildcardHost(null), true);

  assert.equal(isWildcardHost("127.0.0.1"), false);
  assert.equal(isWildcardHost("localhost"), false);
  assert.equal(isWildcardHost("192.168.1.1"), false);
});

test("identifies loopback hostnames", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);

  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.1"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("safely resolves browser url avoiding 0.0.0.0", () => {
  assert.equal(getBrowserUrl("0.0.0.0", "59002"), "http://localhost:59002");
  assert.equal(getBrowserUrl("::", "59002"), "http://localhost:59002");
  assert.equal(getBrowserUrl(undefined, "59002"), "http://localhost:59002");
  assert.equal(getBrowserUrl("127.0.0.1", "30177"), "http://127.0.0.1:30177");
  assert.equal(getBrowserUrl("localhost", "30177"), "http://localhost:30177");
  assert.equal(getBrowserUrl("192.168.31.23", "59002"), "http://192.168.31.23:59002");
});

test("identifies Tailscale interface or CGNAT IP range", () => {
  assert.equal(isTailscaleAddress("Tailscale", "169.254.1.1"), true);
  assert.equal(isTailscaleAddress("tailscale0", "10.0.0.1"), true);
  assert.equal(isTailscaleAddress("utun4", "100.80.12.34"), true);
  assert.equal(isTailscaleAddress("Ethernet", "100.64.0.1"), true);
  assert.equal(isTailscaleAddress("Ethernet", "100.127.255.254"), true);

  assert.equal(isTailscaleAddress("Ethernet", "100.63.255.255"), false);
  assert.equal(isTailscaleAddress("Ethernet", "100.128.0.1"), false);
  assert.equal(isTailscaleAddress("Ethernet", "192.168.1.1"), false);
});

test("filters out ignored addresses like APIPA and TUN fake-ip", () => {
  assert.equal(isIgnoredAddress("Tailscale", "169.254.83.107"), true);
  assert.equal(isIgnoredAddress("Meta", "198.18.0.1"), true);
  assert.equal(isIgnoredAddress("Clash", "198.19.0.5"), true);
  assert.equal(isIgnoredAddress("Loopback", "127.0.0.1"), true);

  assert.equal(isIgnoredAddress("Ethernet", "192.168.31.23"), false);
  assert.equal(isIgnoredAddress("Tailscale", "100.80.12.34"), false);
  assert.equal(isIgnoredAddress("Wi-Fi", "10.0.0.15"), false);
});

test("getAccessibleAddresses formats loopback binding properly", () => {
  const result = getAccessibleAddresses({ hostname: "127.0.0.1", port: "30177" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].label, "Local");
  assert.equal(result.entries[0].url, "http://localhost:30177");
  assert.ok(result.hint?.includes("0.0.0.0"));
});

test("getAccessibleAddresses extracts and categorizes multi-interface 0.0.0.0 binding", () => {
  const mockInterfaces = {
    "Loopback": [
      { address: "127.0.0.1", family: "IPv4", internal: true },
    ],
    "Meta (TUN)": [
      { address: "198.18.0.1", family: "IPv4", internal: false },
    ],
    "Tailscale": [
      { address: "169.254.83.107", family: "IPv4", internal: false },
      { address: "100.80.12.34", family: "IPv4", internal: false },
    ],
    "Ethernet": [
      { address: "192.168.31.23", family: "IPv4", internal: false },
    ],
    "vEthernet (WSL)": [
      { address: "172.18.16.1", family: "IPv4", internal: false },
    ],
  };

  const result = getAccessibleAddresses({
    hostname: "0.0.0.0",
    port: "59002",
    interfaces: mockInterfaces,
  });

  assert.equal(result.entries.length, 4);

  const local = result.entries.find((e) => e.label === "Local");
  assert.ok(local);
  assert.equal(local.url, "http://localhost:59002");

  const lan = result.entries.find((e) => e.label === "Network" && e.address === "192.168.31.23");
  assert.ok(lan);
  assert.equal(lan.url, "http://192.168.31.23:59002");

  const ts = result.entries.find((e) => e.label === "Tailscale" && e.address === "100.80.12.34");
  assert.ok(ts);
  assert.equal(ts.url, "http://100.80.12.34:59002");

  const wsl = result.entries.find((e) => e.address === "172.18.16.1");
  assert.ok(wsl);

  // 198.18.0.1 and 169.254.83.107 should NOT be present
  assert.equal(result.entries.some((e) => e.address === "198.18.0.1"), false);
  assert.equal(result.entries.some((e) => e.address === "169.254.83.107"), false);
});

test("formatAddressBanner generates readable output with status indicators", () => {
  const banner = formatAddressBanner({
    version: "0.3.5",
    entries: [
      { label: "Local", url: "http://localhost:59002" },
      { label: "Network", url: "http://192.168.31.23:59002" },
    ],
    passwordEnabled: true,
    isTTY: false,
  });

  assert.ok(banner.includes("ompweb"));
  assert.ok(banner.includes("v0.3.5"));
  assert.ok(banner.includes("is ready"));
  assert.ok(banner.includes("Local:"));
  assert.ok(banner.includes("http://localhost:59002"));
  assert.ok(banner.includes("Network:"));
  assert.ok(banner.includes("http://192.168.31.23:59002"));
  assert.ok(banner.includes("OMP_WEB_PASSWORD"));
});
