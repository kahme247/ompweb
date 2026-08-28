import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FileExplorer } = await jiti.import("./FileExplorer.tsx");

function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      cwd: "/tmp/project",
      onOpenFile() {},
      ...props,
    }),
  );
}

test("renders the search input only while the search panel is open", () => {
  const closed = render();
  assert.doesNotMatch(closed, /aria-label="(Search files|fileExplorer\.searchFiles)"/);

  const open = render({ fileSearchOpen: true });
  assert.match(open, /aria-label="(Search files|fileExplorer\.searchFiles)"/);
  assert.match(open, /placeholder="(Search files\.\.\.|fileExplorer\.searchPlaceholder)"/);
});

test("keeps the regular file tree visible while the search query is empty", () => {
  // An open panel with no query must not hide the tree behind an empty
  // search-results state.
  const open = render({ fileSearchOpen: true });
  assert.match(open, /role="tree"/);
  assert.match(open, /(Loading files\.\.\.|fileExplorer\.loadingFiles)/);
  assert.doesNotMatch(open, /(No matching files|fileExplorer\.noMatchingFiles)/);
});
