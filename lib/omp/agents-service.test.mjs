import assert from "node:assert/strict";
import { link, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseAgentFrontmatter, writeAgent } = await jiti.import("./agents-service.ts");

const payload = { description: "A test agent", body: "Do the task." };

test("renaming an agent is case-sensitive on POSIX filesystems", async () => {
  // secureScopeDir rejects symlinked scope paths; macOS tmpdir is a
  // /var -> /private/var symlink, so resolve it first.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    writeAgent(dir, "Scout", payload);
    writeAgent(dir, "scout", payload, "Scout");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renaming onto a distinct hardlink of the same file is a collision, not a case alias", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omp-agents-test-")));
  try {
    const { path: scoutPath } = writeAgent(dir, "Scout", payload);
    // A hardlink shares the inode but is a separate directory entry — the
    // rename target genuinely exists and must be rejected.
    await link(scoutPath, join(dir, "Existing.md"));
    assert.throws(() => writeAgent(dir, "Existing", payload, "Scout"), /agent file already exists/);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    assert.deepEqual(names, ["Existing.md", "Scout.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses agent frontmatter with an optional UTF-8 BOM", () => {
  const parsed = parseAgentFrontmatter("\uFEFF---\nname: scout\ndescription: Test\n---\nPrompt");
  assert.equal(parsed.frontmatter.name, "scout");
  assert.equal(parsed.body, "Prompt");
});
