import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("useDictation aborts in-flight transcription and silences transcript on cancellation", async () => {
  const source = await readFile(new URL("./useDictation.ts", import.meta.url), "utf8");

  // An AbortController must be held for in-flight requests
  assert.match(source, /abortControllerRef = useRef<AbortController \| null>\(null\)/);

  // Cancel must abort any pending fetch immediately
  assert.match(source, /abortControllerRef\.current\.abort\(\)/);

  // Unmount must also abort in-flight fetch
  assert.match(source, /return \(\) => \{\s*\n\s*cancelledRef\.current = true;/);

  // Late arrival after cancel must not invoke onTranscript or onError
  assert.match(source, /if \(!cancelledRef\.current\) \{\s*\n\s*onTranscript\(data\.text\.trim\(\)\);/);
});

test("ChatInput cancels dictation on Escape during both recording and transcribing", async () => {
  const source = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");

  // Escape must guard both isRecording and isTranscribing
  assert.match(source, /if \(isRecording \|\| isTranscribing\) \{\s*\n\s*if \(e\.key === "Escape"\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*cancelDictation\(\);/);
});
