import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { __githubReleaseNotesTesting } = jiti("./github-release-notes.ts");
const { createClient, parseRelease } = __githubReleaseNotesTesting;

function release(version, overrides = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    body: "## Changes\n\n- A useful improvement",
    html_url: `https://github.com/kahme247/ompweb/releases/tag/v${version}`,
    ...overrides,
  };
}

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test("accepts only the exact stable or prerelease tag requested", () => {
  assert.deepEqual(parseRelease("1.2.3", release("1.2.3")), {
    version: "1.2.3",
    body: "## Changes\n\n- A useful improvement",
    htmlUrl: "https://github.com/kahme247/ompweb/releases/tag/v1.2.3",
  });
  assert.deepEqual(parseRelease("1.2.3-beta.1", release("1.2.3-beta.1")), {
    version: "1.2.3-beta.1",
    body: "## Changes\n\n- A useful improvement",
    htmlUrl: "https://github.com/kahme247/ompweb/releases/tag/v1.2.3-beta.1",
  });
  assert.equal(parseRelease("1.2.3", release("1.2.4")), null);
  assert.equal(parseRelease("1.2.3", release("1.2.3", { tag_name: "1.2.3" })), null);
});

test("rejects drafts and stable/prerelease mismatches", () => {
  assert.equal(parseRelease("1.2.3", release("1.2.3", { draft: true })), null);
  assert.equal(parseRelease("1.2.3", release("1.2.3", { prerelease: true })), null);
  assert.equal(parseRelease("1.2.3-beta.1", release("1.2.3-beta.1", { prerelease: false })), null);
});

test("rejects missing, blank, malformed, and oversized note bodies", () => {
  assert.equal(parseRelease("1.2.3", release("1.2.3", { body: undefined })), null);
  assert.equal(parseRelease("1.2.3", release("1.2.3", { body: " \n\t" })), null);
  assert.equal(parseRelease("1.2.3", release("1.2.3", { body: 42 })), null);
  assert.ok(parseRelease("1.2.3", release("1.2.3", { body: "é".repeat(32 * 1024) })));
  assert.equal(parseRelease("1.2.3", release("1.2.3", { body: "é".repeat(32 * 1024 + 1) })), null);
});

test("accepts only the canonical safe GitHub release URL", () => {
  for (const html_url of [
    "http://github.com/kahme247/ompweb/releases/tag/v1.2.3",
    "https://github.example/kahme247/ompweb/releases/tag/v1.2.3",
    "https://github.com/kahme247/other/releases/tag/v1.2.3",
    "https://github.com/kahme247/ompweb/releases/tag/v1.2.3?next=https://example.com",
    "https://github.com/kahme247/ompweb/releases/tag/v1.2.3#notes",
  ]) {
    assert.equal(parseRelease("1.2.3", release("1.2.3", { html_url })), null);
  }
});

test("uses the fixed repository endpoint and credential-free GitHub headers", async () => {
  let request;
  const getNotes = createClient({
    fetchImpl: async (input, init) => {
      request = { input, init };
      return jsonResponse(release("1.2.3"));
    },
  });

  assert.ok(await getNotes("1.2.3"));
  assert.equal(request.input, "https://api.github.com/repos/kahme247/ompweb/releases/tags/v1.2.3");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("user-agent"), "@kahme247/ompweb");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.has("authorization"), false);
  assert.equal(request.init.cache, "no-store");
  assert.ok(request.init.signal instanceof AbortSignal);
});

test("invalid versions never reach GitHub", async () => {
  let calls = 0;
  const getNotes = createClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(release("1.2.3"));
    },
  });

  for (const version of ["v1.2.3", "1.2", "1.2.3/../../latest", "01.2.3", "1.2.3 beta"]) {
    assert.equal(await getNotes(version), null);
  }
  assert.equal(calls, 0);
});

test("turns non-OK GitHub responses into unavailable notes", async () => {
  for (const status of [403, 404, 429, 500, 503]) {
    const getNotes = createClient({ fetchImpl: async () => new Response("unavailable", { status }) });
    assert.equal(await getNotes("1.2.3"), null);
  }
});

test("turns malformed and oversized GitHub responses into unavailable notes", async () => {
  const malformed = createClient({ fetchImpl: async () => new Response("{not json", { status: 200 }) });
  assert.equal(await malformed("1.2.3"), null);

  const oversizedPayload = { ...release("1.2.3"), ignored: "x".repeat(256 * 1024) };
  const oversized = createClient({ fetchImpl: async () => jsonResponse(oversizedPayload) });
  assert.equal(await oversized("1.2.3"), null);

  const declaredOversized = createClient({
    fetchImpl: async () => jsonResponse(release("1.2.3"), { headers: { "Content-Length": String(256 * 1024 + 1) } }),
  });
  assert.equal(await declaredOversized("1.2.3"), null);
});

test("aborts a GitHub request at the configured timeout and returns unavailable", async () => {
  const getNotes = createClient({
    timeoutMs: 10,
    fetchImpl: async (_input, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });

  assert.equal(await getNotes("1.2.3"), null);
});

test("caches successful notes for the positive TTL", async () => {
  let now = 1_000;
  let calls = 0;
  const getNotes = createClient({
    now: () => now,
    positiveTtlMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(release("1.2.3"));
    },
  });

  assert.ok(await getNotes("1.2.3"));
  now += 99;
  assert.ok(await getNotes("1.2.3"));
  assert.equal(calls, 1);
  now += 1;
  assert.ok(await getNotes("1.2.3"));
  assert.equal(calls, 2);
});

test("caches unavailable notes for the shorter negative TTL", async () => {
  let now = 1_000;
  let calls = 0;
  const getNotes = createClient({
    now: () => now,
    negativeTtlMs: 20,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    },
  });

  assert.equal(await getNotes("1.2.3"), null);
  now += 19;
  assert.equal(await getNotes("1.2.3"), null);
  assert.equal(calls, 1);
  now += 1;
  assert.equal(await getNotes("1.2.3"), null);
  assert.equal(calls, 2);
});

test("coalesces concurrent requests for the same target version", async () => {
  let calls = 0;
  let finishFetch;
  const getNotes = createClient({
    fetchImpl: async () => {
      calls += 1;
      return new Promise((resolve) => {
        finishFetch = () => resolve(jsonResponse(release("1.2.3")));
      });
    },
  });

  const first = getNotes("1.2.3");
  const second = getNotes("1.2.3");
  assert.equal(calls, 1);
  finishFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls, 1);
});

test("bounds cached target versions and evicts the oldest entry", async () => {
  let calls = 0;
  const getNotes = createClient({
    maxCacheEntries: 2,
    fetchImpl: async (input) => {
      calls += 1;
      const version = String(input).split("/v").at(-1);
      return jsonResponse(release(version));
    },
  });

  await getNotes("1.0.0");
  await getNotes("1.0.1");
  await getNotes("1.0.2");
  await getNotes("1.0.0");
  assert.equal(calls, 4);
});
