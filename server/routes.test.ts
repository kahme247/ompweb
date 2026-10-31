import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { dispatch, ROUTE_MODULES, routePattern } from "./routes";

const root = path.join(import.meta.dir, "..");

test("the route table lists every app/api/**/route.ts and nothing else", () => {
  const onDisk = [...new Bun.Glob("app/api/**/route.ts").scanSync(root)]
    .map((file) => path.dirname(file).split(path.sep).join("/").slice("app/api/".length))
    .sort();
  assert.deepEqual(Object.keys(ROUTE_MODULES).sort(), onDisk);
});

test("route modules export only HTTP method handlers", () => {
  for (const [key, mod] of Object.entries(ROUTE_MODULES)) {
    for (const name of Object.keys(mod)) assert.match(name, /^(GET|POST|PUT|PATCH|DELETE)$/, `${key} exports ${name}`);
  }
});

test("routePattern maps dynamic and catch-all segments onto Bun's router", () => {
  assert.deepEqual(routePattern("files/[...path]"), { pattern: "/api/files/*", rest: { name: "path", index: 3 } });
  assert.deepEqual(routePattern("sessions/[id]/entries/[entryId]/thinking"), {
    pattern: "/api/sessions/:id/entries/:entryId/thinking",
    rest: null,
  });
});

test("dispatch answers missing methods, OPTIONS and HEAD as Next did, and passes the params", async () => {
  let seen: unknown;
  const mod = {
    GET: async (_request: Request, context: { params: Promise<{ id: string }> }) => {
      seen = await context.params;
      return new Response("ok", { status: 203 });
    },
  };
  const request = (method: string) => new Request("http://localhost/api/x", { method });

  const post = (await dispatch(mod, request("POST"), {}))!;
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  const options = (await dispatch(mod, request("OPTIONS"), {}))!;
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal((await dispatch(mod, request("HEAD"), {}))!.status, 203);
  assert.equal((await dispatch(mod, request("GET"), { id: "a b" }))!.status, 203);
  assert.deepEqual(seen, { id: "a b" });
});

test("dispatch turns a handler throw into a logged 500", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const response = (await dispatch({ GET: () => { throw new Error("boom"); } }, new Request("http://localhost/api/x"), {}))!;
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal Server Error" });
  assert.equal(error.mock.callCount(), 1);
});
