import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, ModelErrorBanner, filterModelOptions } = await jiti.import("./ChatInput.tsx");
const { setDraft, clearDraft } = await jiti.import("@/lib/draft-store");

test("shows Queue instead of Stop for typed text during a run", () => {
  const draftKey = "chat-input-queue-action-test";
  setDraft(draftKey, { value: "Continue after the current run", images: [], files: [] });
  try {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onFollowUp() {},
        isStreaming: true,
        draftKey,
      }),
    );

    assert.match(html, />(Queue|chatInput\.queue)</);
    assert.match(html, /title="(Queue this message after the agent finishes|chatInput\.queueMessage)"/);
    assert.doesNotMatch(html, />(Stop|chatInput\.stop)</);
  } finally {
    clearDraft(draftKey);
  }
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  // en.json is assembled from locale parts; before assembly the key renders as-is.
  assert.match(html, /(Model error|chatInput\.modelError)/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("formats structured Claude low-priority state in the browser locale", () => {
  const resetsAtSec = Math.floor(Date.now() / 1000) + 3_600;
  const time = new Date(resetsAtSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      isStreaming: false,
      usageLimit: { stage: "low_priority", resetsAtSec, allowanceLeftPercent: 62 },
    }),
  );
  assert.match(html, new RegExp(`low priority until ${time.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")} · 62% left`));
});

test("formats every Claude usage-limit stage", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const shortReset = nowSec + 3_600;
  const longReset = nowSec + 86_400;
  const shortTime = new Date(shortReset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const longTime = new Date(longReset * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const rows = [
    [{ stage: "low_priority", resetsAtSec: shortReset }, `low priority until ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: false }, "limit reached · wrapping up"],
    [{ stage: "wrap_up", resetsAtSec: shortReset, extraUsage: false }, `limit reached · wrapping up · resets ${shortTime}`],
    [{ stage: "wrap_up", extraUsage: true }, "limit reached · wrap-up, then extra usage"],
    [{ stage: "low_priority", resetsAtSec: longReset }, `low priority until ${longTime}`],
  ];
  for (const [usageLimit, label] of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, isStreaming: false, usageLimit }),
    );
    assert.ok(html.includes(label), `${JSON.stringify(usageLimit)} should render ${label}`);
  }
});

test("never renders a null percentage, an invalid date, or a past reset clock", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const pastSec = nowSec - 3_600;
  const rows = [
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: null },
    { stage: "low_priority", resetsAtSec: nowSec + 3_600, allowanceLeftPercent: Number.NaN },
    { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: undefined, allowanceLeftPercent: 62 },
    { stage: "low_priority", resetsAtSec: null },
    { stage: "low_priority", resetsAtSec: pastSec, allowanceLeftPercent: 62 },
    { stage: "wrap_up", resetsAtSec: null, extraUsage: false },
    { stage: "wrap_up", resetsAtSec: pastSec, extraUsage: false },
  ];
  for (const usageLimit of rows) {
    const html = renderToStaticMarkup(
      React.createElement(ChatInput, { onSend() {}, isStreaming: false, usageLimit }),
    );
    const label = `${JSON.stringify(usageLimit)} -> ${html}`;
    // "null" / "NaN" / "Invalid Date" reaching the label is the bug this pins:
    // every one of them is a value the user would plan their session around.
    assert.ok(!html.includes("Invalid Date"), `invalid date rendered: ${label}`);
    assert.ok(!html.includes("null%"), `null percentage rendered: ${label}`);
    assert.ok(!html.includes("NaN%"), `NaN percentage rendered: ${label}`);
    // A reset already in the past must not render a plausible wrong clock.
    if (usageLimit.resetsAtSec === pastSec) {
      assert.ok(!html.includes(new Date(pastSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        `past reset clock rendered: ${label}`);
    }
  }
  // The allowance is still worth showing when the reset time is unusable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null, allowanceLeftPercent: 62 },
      }),
    ),
    /low priority · 62% left/,
  );
  // ...and something is still shown when neither is usable.
  assert.match(
    renderToStaticMarkup(
      React.createElement(ChatInput, {
        onSend() {},
        isStreaming: false,
        usageLimit: { stage: "low_priority", resetsAtSec: null },
      }),
    ),
    /class="composer-usage-limit-badge"[^>]*>low priority</,
  );
});

test("shows the Slow toggle only when omp reports /slow applies, pressed when enabled", () => {
  const render = (props) => renderToStaticMarkup(
    React.createElement(ChatInput, { onSend() {}, isStreaming: false, onSlowModeChange() {}, ...props }),
  );
  // Older omp omits the field; an unsupported model reports false.
  for (const props of [{}, { slowModeSupported: false, slowModeEnabled: true }]) {
    assert.doesNotMatch(render(props), /composer-slow-control/);
  }
  assert.match(
    render({ slowModeSupported: true, slowModeEnabled: true }),
    /<button[^>]*class="composer-slow-control"[^>]*aria-pressed="true"/,
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      modelError: "Invalid models.json schema",
      modelList: [],
      modelNames: {},
    }),
  );

  assert.match(html, />(No models|chatInput\.noModels)</);
  assert.match(html, /title="(No available models|chatInput\.noAvailableModels)"/);
});


test("renders goal, planning, and advisor indicators at the composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onModelChange() {},
      isStreaming: false,
      model: { provider: "test", modelId: "model" },
      modelList: [{ provider: "test", modelId: "model", id: "model", name: "Test model" }],
      modelNames: {},
      activeGoal: { objective: "Ship the active goal bar", startedAt: 0 },
      activePlan: { objective: "Plan the implementation" },
      advisorEnabled: true,
      onAdvisorChange() {},
    }),
  );

  assert.match(html, /Ship the active goal bar/);
  assert.match(html, /(Planning in progress|chatInput\.planningInProgress)/);
  // The advisor toggle moved into the plus menu: no pressed toggle inline,
  // but the plus trigger renders for the same props.
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("renders the compact toolbar action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onCompact() {},
      isStreaming: false,
    }),
  );

  assert.match(html, /title="(Compact context|chatInput\.compactContext)"/);
});

test("shows the advisor thunder indicator with the reviewing model and reasoning", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      advisorActive: true,
      advisorModel: { name: "GPT-5.6 Luna", reasoning: "xhigh" },
    }),
  );

  assert.match(html, /aria-label="[^"]*GPT-5\.6 Luna[^"]*xhigh[^"]*"/);
});

test("filters model options by display name, identifier, and provider", () => {
  const options = [
    { provider: "OpenAI", modelId: "gpt-5.2", name: "GPT-5.2" },
    { provider: "Anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ];

  assert.deepEqual(filterModelOptions(options, "sonnet", "en"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "5.2", "en"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "OPENAI", "en"), [options[0]]);
  assert.equal(filterModelOptions(options, "   ", "en"), options);
});

test("renders single queued prompt in compact bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First follow-up task"],
        steering: [],
      },
    }),
  );

  assert.match(html, /First follow-up task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.match(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("keeps editing and deletion but hides Steer for a single queued steer", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      onPromoteQueuedToSteer() {},
      isStreaming: true,
      queuedMessages: {
        followUp: [],
        steering: ["Already prioritized task"],
      },
    }),
  );

  assert.match(html, /Already prioritized task/);
  assert.match(html, />(Edit|chatInput\.queuedEdit)</);
  assert.match(html, />(Delete|chatInput\.queuedDelete)</);
  assert.doesNotMatch(html, />(Steer|chatInput\.queuedSteerAction)</);
});

test("renders multiple queued prompts with count and expand action", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      queuedMessages: {
        followUp: ["First task", "Second task"],
        steering: ["Priority steer"],
      },
    }),
  );

  assert.match(html, /\(3\)/);
  assert.match(html, />(Show all queued prompts|Show all|chatInput\.expandQueued)</);
  assert.match(html, /First task/);
});


test("nested model picker groups by provider and pins the current provider first", async () => {
  const { groupModelOptionsByProvider, orderProviderGroups } = await jiti.import("./ChatInput-model-picker.tsx");
  const options = [
    { provider: "anthropic", modelId: "claude", name: "Claude" },
    { provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { provider: "openai", modelId: "gpt-5.5", name: "GPT-5.5" },
    { provider: "pi", modelId: "pi-1", name: "Pi" },
  ];
  const grouped = groupModelOptionsByProvider(options);
  assert.deepEqual(grouped.map((g) => g.provider), ["anthropic", "openai", "pi"]);
  assert.equal(grouped[1].options.length, 2);

  const ordered = orderProviderGroups(grouped, "openai");
  assert.deepEqual(ordered.map((g) => g.provider), ["openai", "anthropic", "pi"]);
});

test("model picker panel renders providers rail, models pane, and Add Providers", async () => {
  const { ModelPickerPanel } = await jiti.import("./ChatInput-model-picker.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ModelPickerPanel, {
      modelOptions: [
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "codex", modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        { provider: "pi", modelId: "pi-1", name: "Pi One" },
      ],
      filteredModelOptions: [
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        { provider: "codex", modelId: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
        { provider: "pi", modelId: "pi-1", name: "Pi One" },
      ],
      currentModel: { provider: "codex", modelId: "gpt-5.6-sol" },
      modelSearchQuery: "",
      onSearchQueryChange() {},
      isMobile: false,
      onSelectModel() {},
      onOpenProviders() {},
    }),
  );

  assert.match(html, /picker-nested-providers/);
  assert.match(html, /picker-nested-models/);
  assert.match(html, /GPT-5\.6 Sol/);
  assert.match(html, /GPT-5\.6 Terra/);
  assert.match(html, />codex</);
  assert.match(html, />pi</);
  assert.match(html, />(Add Providers|chatInput\.addProviders)</);
});


test("exposes tool presets through the plus menu when a handler is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      toolPreset: "full",
      onToolPresetChange() {},
    }),
  );

  // No inline preset trigger remains; the plus trigger carries the menu.
  assert.doesNotMatch(html, /aria-label="Change tool preset: full"/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
  assert.match(html, /aria-haspopup="menu"/);
});

test("plus trigger renders without change handlers", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
    }),
  );

  assert.doesNotMatch(html, /Change tool preset/);
  assert.match(html, /aria-label="(More actions|chatInput\.plusMenu)"/);
});

test("renders live status bar attached to the composer top edge when statusText is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
    }),
  );

  assert.match(html, /role="status"/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});

test("omits live status bar when statusText is absent or null", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: false,
      statusText: null,
    }),
  );

  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(html, /Waiting for model/);
});

test("renders both queued prompts and attached status bar together", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatInput, {
      onSend() {},
      onAbort() {},
      isStreaming: true,
      statusText: "Waiting for model...",
      queuedMessages: {
        steer: [],
        followUp: ["Next prompt to run"],
      },
    }),
  );

  assert.match(html, /Next prompt to run/);
  assert.match(html, /Waiting for model\.\.\./);
  assert.match(html, /live-status-dot/);
});
