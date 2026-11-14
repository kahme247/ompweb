import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { randomUUID } from "./random-uuid.ts";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("UUIDs remain valid and distinct on HTTP origins without randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    } });
    const ids = Array.from({ length: 100 }, () => randomUUID());
    for (const id of ids) assert.match(id, uuidV4);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});

test("UUIDs remain valid in secure contexts", () => {
  assert.match(randomUUID(), uuidV4);
});
