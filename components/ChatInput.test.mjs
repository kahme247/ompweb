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
test("queued slash commands gate /advisor behind the per-chat toggle", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const sendQueued = source.slice(
    source.indexOf("const sendQueued = useCallback"),
    source.indexOf("const primaryActionQueuesMessage"),
  );
  const guard = sendQueued.indexOf('commandName === "advisor" && !advisorEnabled');
  const expansion = sendQueued.indexOf("expandWebSlashCommand(msg)");

  assert.ok(guard > 0, "advisor guard missing from sendQueued");
  assert.ok(expansion > guard, "advisor guard must run before command expansion");
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
