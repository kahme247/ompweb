import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TodoList } = await jiti.import("./TodoList.tsx");

test("renders live todo phases, task states, and blockers", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{
      id: "phase-1",
      name: "Implementation",
      tasks: [
        { id: "task-1", content: "Trace todo state", status: "completed" },
        { id: "task-2", content: "Render task list", status: "in_progress" },
        { id: "task-3", content: "Verify in browser", status: "blocked", blocker: "Server unavailable" },
      ],
    }],
  }));

  assert.match(html, /Implementation/);
  assert.match(html, /Trace todo state/);
  assert.match(html, /Render task list/);
  assert.match(html, /Verify in browser/);
  assert.match(html, /Blocked: Server unavailable/);
  assert.match(html, /1\/3 complete/);
});

test("renders nothing when no todo list exists", () => {
  assert.equal(renderToStaticMarkup(React.createElement(TodoList, { phases: [] })), "");
  assert.equal(renderToStaticMarkup(React.createElement(TodoList)), "");
});

test("counts only completed tasks and collapses long plans", () => {
  const html = renderToStaticMarkup(React.createElement(TodoList, {
    phases: [{
      name: "Tasks",
      tasks: [
        { content: "One", status: "completed" },
        { content: "Two", status: "abandoned" },
        { content: "Three", status: "pending" },
        { content: "Four", status: "pending" },
        { content: "Five", status: "pending" },
        { content: "Six", status: "pending" },
      ],
    }],
  }));

  assert.match(html, /1\/6 complete/);
  assert.doesNotMatch(html, /Six/);
  assert.match(html, /Show all tasks/);
});

test("collapsible mode collapses to a toggle header and expands again", () => {
  const phases = [{ name: "Tasks", tasks: [{ content: "Wire panels", status: "in_progress" }] }];
  const collapsedHtml = renderToStaticMarkup(React.createElement(TodoList, {
    phases,
    collapsible: true,
    defaultExpanded: false,
  }));
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.doesNotMatch(collapsedHtml, /Wire panels/);
  const expandedHtml = renderToStaticMarkup(React.createElement(TodoList, {
    phases,
    collapsible: true,
    defaultExpanded: true,
  }));
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /Wire panels/);
});

/** A plan long enough that an uncapped panel would run off the viewport. */
const longPlan = [{
  name: "Migration",
  tasks: Array.from({ length: 56 }, (_, i) => ({ content: `Task number ${i + 1}`, status: "pending" })),
}];

const expandedPanel = () => renderToStaticMarkup(React.createElement(TodoList, {
  phases: longPlan,
  collapsible: true,
  defaultExpanded: true,
}));

test("the expanded task list is capped and scrolls on its own", () => {
  const html = expandedPanel();

  // The panel is pinned above the composer, outside the chat scroller, so
  // without its own cap the tail of a long plan is unreachable.
  assert.match(html, /max-height:min\(30vh,\s*240px\)/);
  assert.match(html, /overflow-y:auto/);
});

/** Index of the `</div>` that closes the div opening at `openIndex`. */
function divCloseIndex(html, openIndex) {
  const tags = /<(\/?)div\b[^>]*?>/g;
  tags.lastIndex = openIndex;
  let depth = 0;
  for (let match; (match = tags.exec(html)) !== null; ) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

test("the show-all footer stays outside the scrolling area", () => {
  const html = expandedPanel();
  const scrollerOpen = html.lastIndexOf("<div", html.indexOf("overflow-y:auto"));
  assert.notEqual(scrollerOpen, -1);

  // Preview mode renders only the first few tasks, so anchor on the container
  // itself rather than on any task text: a footer inside the scroller would
  // scroll away with the very list it controls.
  const scrollerClose = divCloseIndex(html, scrollerOpen);
  assert.notEqual(scrollerClose, -1);
  const footer = html.indexOf("Show all tasks");
  assert.notEqual(footer, -1);
  assert.ok(footer > scrollerClose, "footer button must render after the scroll container closes");
});

test("the scroll area is reachable by keyboard and named", () => {
  const html = expandedPanel();

  // Todo rows are static text, unlike the button cards of the subagents panel,
  // so the container itself has to take focus for a keyboard-only reader.
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="group"[^>]*aria-label="Task list"|aria-label="Task list"[^>]*role="group"/);

  // Its name must differ from the enclosing section's, or a screen reader
  // announces "Tasks" for the region and again for the scroll area inside it.
  assert.match(html, /<section[^>]*aria-label="Tasks"/);
  assert.doesNotMatch(html, /role="group"[^>]*aria-label="Tasks"/);
});
