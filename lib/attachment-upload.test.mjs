import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-attachment-upload-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const upload = await jiti.import("./attachment-upload.ts");
const createRoute = await jiti.import("../app/api/attachments/route.ts");
const batchRoute = await jiti.import("../app/api/attachments/[batchId]/route.ts");

/** fetch that serves /api/attachments from the real route handlers. */
function routeFetch(log = []) {
  return async (url, init = {}) => {
    const request = new Request(new URL(url, "http://localhost"), init);
    log.push(`${request.method} ${new URL(request.url).pathname}`);
    const match = new URL(request.url).pathname.match(/^\/api\/attachments(?:\/([^/]+))?$/);
    if (!match) return new Response("not found", { status: 404 });
    if (!match[1]) return createRoute.POST(request);
    const params = { params: Promise.resolve({ batchId: decodeURIComponent(match[1]) }) };
    return request.method === "PUT" ? batchRoute.PUT(request, params) : batchRoute.POST(request, params);
  };
}

test("chunk plans cap request bytes and parts, split large files, and skip empty ones", () => {
  const entries = [
    { path: "d/a", file: new Blob(["x".repeat(5)]) },
    { path: "d/empty", file: new Blob([]) },
    { path: "d/b", file: new Blob(["y".repeat(12)]) },
    { path: "d/c", file: new Blob(["z"]) },
  ];
  const plan = upload.planAttachmentChunks(entries, 8, 3);
  const shape = plan.map((parts) => parts.map((part) => [part.path, part.offset, part.blob.size]));
  assert.deepEqual(shape, [
    [["d/a", 0, 5], ["d/b", 0, 3]],
    [["d/b", 3, 8]],
    [["d/b", 11, 1], ["d/c", 0, 1]],
  ]);
  for (const parts of plan) assert.ok(parts.reduce((total, part) => total + part.blob.size, 0) <= 8);
  // Part count alone also starts a new request.
  const tiny = Array.from({ length: 5 }, (_, i) => ({ path: `t/${i}`, file: new Blob(["1"]) }));
  assert.deepEqual(upload.planAttachmentChunks(tiny, 100, 2).map((parts) => parts.length), [2, 2, 1]);
  assert.deepEqual(upload.planAttachmentChunks([{ path: "e", file: new Blob([]) }]), []);
});

test("a folder pick groups files by their top folder and keeps relative paths", async () => {
  const file = (name, relativePath) => {
    const value = new File([name], name);
    Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
    return value;
  };
  const { folders, looseFiles } = upload.foldersFromDirectoryInput([
    file("a.csv", "dataset/a.csv"),
    file("b.csv", "dataset/sub/b.csv"),
    file("loose.txt", ""),
  ]);
  assert.deepEqual(folders.map((folder) => folder.name), ["dataset"]);
  assert.deepEqual((await folders[0].entries(10)).map((entry) => entry.path), ["dataset/a.csv", "dataset/sub/b.csv"]);
  assert.deepEqual(looseFiles.map((f) => f.name), ["loose.txt"]);
});

function fakeFileEntry(name, content) {
  return { name, isFile: true, isDirectory: false, file: (resolve) => resolve(new File([content], name)) };
}

function fakeDirectoryEntry(name, children) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      // Real readers return the listing in batches, then an empty one.
      const batches = [children.slice(0, 1), children.slice(1), []];
      return { readEntries: (resolve) => resolve(batches.shift() ?? []) };
    },
  };
}

test("a dropped directory is walked depth first with every batch of entries", async () => {
  const root = fakeDirectoryEntry("project", [
    fakeFileEntry("README.md", "# hi"),
    fakeDirectoryEntry("src", [fakeFileEntry("main.c", "int main;"), fakeDirectoryEntry("empty", [])]),
    fakeFileEntry("data.bin", "\u0000"),
  ]);
  const folder = upload.folderFromDirectoryEntry(root);
  assert.equal(folder.name, "project");
  assert.deepEqual((await folder.entries(100)).map((entry) => entry.path), ["project/README.md", "project/src/main.c", "project/data.bin"]);
  // The walk stops just past the limit so the cap check can refuse it.
  assert.equal((await folder.entries(1)).length, 2);
});

test("drops split into plain files and directories", () => {
  const plain = new File(["a"], "a.pdf");
  const directory = fakeDirectoryEntry("docs", []);
  const items = [
    { kind: "file", getAsFile: () => plain, webkitGetAsEntry: () => ({ isDirectory: false }) },
    { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => directory },
    { kind: "string", getAsFile: () => null, webkitGetAsEntry: () => null },
  ];
  const result = upload.splitDroppedItems({ items, files: [plain] });
  assert.deepEqual(result.files, [plain]);
  assert.deepEqual(result.folders.map((folder) => folder.name), ["docs"]);
  // Without the entries API every dropped file stays a plain file.
  const legacy = upload.splitDroppedItems({ items: [{ kind: "file" }], files: [plain] });
  assert.deepEqual(legacy, { files: [plain], folders: [] });
});

test("uploadAttachment sends a folder through the routes and returns its reference", async () => {
  const log = [];
  const progress = [];
  // A non-repeating-per-chunk pattern, so a misplaced chunk changes the bytes.
  const big = Uint8Array.from({ length: 9 * 1024 * 1024 }, (_, index) => index % 251);
  const reference = await upload.uploadAttachment({
    kind: "folder",
    name: "dataset",
    entries: [
      { path: "dataset/notes.txt", file: new Blob(["hello"]) },
      { path: "dataset/raw/big.bin", file: new Blob([big]) },
    ],
  }, { fetchImpl: routeFetch(log), onProgress: (uploaded) => progress.push(uploaded) });

  assert.equal(reference.kind, "folder");
  assert.equal(reference.fileCount, 2);
  assert.equal(reference.size, 5 + big.byteLength);
  assert.equal(reference.path, join(agentDir, "omp-web", "attachments", reference.batchId, "dataset"));
  assert.equal(readFileSync(join(reference.path, "notes.txt"), "utf8"), "hello");
  assert.ok(readFileSync(join(reference.path, "raw", "big.bin")).equals(big), "the chunked file's bytes match the source");
  // 9 MiB + 5 bytes needs two 8 MiB chunk requests.
  assert.deepEqual(log.map((line) => line.split(" ")[0]), ["POST", "PUT", "PUT", "POST"]);
  assert.deepEqual(progress, [8 * 1024 * 1024, 5 + big.byteLength]);
});

test("uploadAttachment surfaces the server's error code", async () => {
  await assert.rejects(
    () => upload.uploadAttachment({ kind: "file", name: "a/b", entries: [{ path: "a/b", file: new Blob(["x"]) }] }, { fetchImpl: routeFetch() }),
    (error) => error instanceof upload.AttachmentUploadError && error.status === 400 && error.code === "invalid_attachment"
      && typeof error.serverError === "string" && error.serverError === error.message,
  );
});
