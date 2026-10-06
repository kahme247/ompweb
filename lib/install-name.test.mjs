import assert from "node:assert/strict";
import test from "node:test";
import { getInstallName as resolveInstallName, getInstallNames } from "./install-name.ts";

// Hostname tests must not depend on the developer's server environment.
const getInstallName = (headers) => resolveInstallName(headers, "");

test("uses the host without its port as the installation name", () => {
  assert.equal(getInstallName(new Headers({ host: "work.example.com:30177" })), "work.example.com");
});

test("keeps named LAN hosts as installation names", () => {
  assert.equal(getInstallName(new Headers({ host: "devbox:30177" })), "devbox");
  assert.equal(getInstallName(new Headers({ host: "devbox.local:30177" })), "devbox.local");
});

test("displays internationalized domain labels and suffixes in Unicode", () => {
  for (const [ascii, unicode] of [
    ["xn--bcher-kva.example", "bücher.example"],
    ["example.xn--qubec-csa", "example.québec"],
  ]) {
    for (const host of [ascii, `${ascii}:30177`, unicode, `${unicode}:30177`]) {
      assert.equal(getInstallName(new Headers({ host })), unicode, host);
    }
  }
});

test("uses the generic name for localhost and IP addresses", () => {
  for (const host of ["localhost:30177", "LOCALHOST.:30177", "127.0.0.1:30177", "192.168.1.10", "[::1]:30177", "[2001:db8::1]:30177"]) {
    assert.equal(getInstallName(new Headers({ host })), "omp web", host);
  }
});

test("falls back to the generic name when Host is missing or malformed", () => {
  assert.equal(getInstallName(new Headers()), "omp web");
  assert.equal(getInstallName(new Headers({ host: "[broken" })), "omp web");
});

test("uses the first Unicode hostname label only for the short name", () => {
  for (const [host, name, shortName] of [
    ["ai-web.example.dev:30177", "ai-web.example.dev", "ai-web"],
    ["devbox", "devbox", "devbox"],
    ["devbox.local", "devbox.local", "devbox"],
    ["xn--bcher-kva.example", "bücher.example", "bücher"],
    ["example.xn--qubec-csa", "example.québec", "example"],
    ["localhost", "omp web", "omp web"],
    ["192.168.1.10", "omp web", "omp web"],
    ["[::1]:30177", "omp web", "omp web"],
    ["[broken", "omp web", "omp web"],
  ]) {
    assert.deepEqual(getInstallNames(new Headers({ host }), ""), { name, shortName }, host);
  }
  assert.deepEqual(getInstallNames(new Headers(), ""), { name: "omp web", shortName: "omp web" });
});

test("explicit names override every host and retain dots and Unicode", () => {
  for (const host of ["ai-web.example.dev", "devbox", "localhost", "192.168.1.10", "[broken", ""]) {
    const headers = new Headers(host ? { host } : {});
    assert.deepEqual(getInstallNames(headers, "  Mon OMP.québec  "), {
      name: "Mon OMP.québec", shortName: "Mon OMP.québec",
    });
    assert.equal(resolveInstallName(headers, " Mon OMP "), "Mon OMP");
  }
});

test("empty and whitespace-only overrides fall back to the hostname", () => {
  for (const override of ["", " \t\n "]) {
    assert.deepEqual(getInstallNames(new Headers({ host: "work.example.com" }), override), {
      name: "work.example.com", shortName: "work",
    });
  }
});

test("reads OMP_WEB_NAME at call time for both name helpers", () => {
  const previous = process.env.OMP_WEB_NAME;
  const headers = new Headers({ host: "work.example.com" });
  try {
    for (const name of ["First", "Deuxième"]) {
      process.env.OMP_WEB_NAME = name;
      assert.equal(resolveInstallName(headers), name);
      assert.deepEqual(getInstallNames(headers), { name, shortName: name });
    }
    delete process.env.OMP_WEB_NAME;
    assert.equal(resolveInstallName(headers), "work.example.com");
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_NAME;
    else process.env.OMP_WEB_NAME = previous;
  }
});
