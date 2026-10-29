import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("sidebar drag scales pointer deltas by the interface zoom", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // clientX is viewport pixels while --sidebar-width is zoomed layout pixels;
  // without the correction the edge overshoots at 110/120% scale.
  assert.match(source, /--ui-scale/);
  assert.match(source, /\(ev\.clientX - startX\) \/ uiScale/);
});

test("the expand-thinking preference reaches the thinking block, off unless stored", async () => {
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const messageView = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

  // Stored like the tool-call preference, and only "true" turns it on.
  assert.match(appShell, /EXPAND_THINKING_STORAGE_KEY = "omp-web:expand-thinking"/);
  assert.match(appShell, /useState\(false\)/);
  assert.match(appShell, /setExpandThinkingByDefault\(window\.localStorage\.getItem\(EXPAND_THINKING_STORAGE_KEY\) === "true"\)/);
  assert.match(appShell, /window\.localStorage\.setItem\(EXPAND_THINKING_STORAGE_KEY, String\(expand\)\)/);
  // AppShell hands it to Settings and to the chat (a missing prop leaves the
  // setting inert, which is what the tool-call preference already taught).
  assert.match(appShell, /expandThinkingByDefault=\{expandThinkingByDefault\}/);
  assert.match(appShell, /onExpandThinkingByDefaultChange=\{handleExpandThinkingByDefaultChange\}/);
  // ChatWindow forwards it to both MessageView hosts; MessageView seeds the state.
  assert.equal(chatWindow.match(/expandThinkingByDefault=\{expandThinkingByDefault\}/g)?.length, 3);
  assert.match(messageView, /const \[expanded, setExpanded\] = useState\(expandByDefault\)/);
  // The toggle sits next to "Keep tool calls collapsed" and is searchable.
  assert.match(settings, /searchId="keep-tool-calls-collapsed"[\s\S]{0,400}searchId="expand-thinking-by-default"/);
  assert.match(settings, /id: "expand-thinking-by-default", tab: "general"/);
  assert.match(settings, /<ToggleSwitch checked=\{expandThinkingByDefault\} onChange=\{onExpandThinkingByDefaultChange\} \/>/);
});

test("every locale carries the expand-thinking setting copy", async () => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    assert.ok(messages["settingsConfig.expandThinkingByDefault"], `${locale} label`);
    assert.ok(messages["settingsConfig.expandThinkingByDefaultDesc"], `${locale} description`);
  }
});

test("the expand-process-details preference reaches the Process details fold, off unless stored", async () => {
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  assert.match(appShell, /EXPAND_PROCESS_DETAILS_STORAGE_KEY = "omp-web:expand-process-details"/);
  assert.match(appShell, /setExpandProcessDetails\(window\.localStorage\.getItem\(EXPAND_PROCESS_DETAILS_STORAGE_KEY\) === "true"\)/);
  assert.match(appShell, /window\.localStorage\.setItem\(EXPAND_PROCESS_DETAILS_STORAGE_KEY, String\(expand\)\)/);
  // Both hosts need the prop, otherwise the setting is inert.
  assert.match(appShell, /expandProcessDetails=\{expandProcessDetails\}/g);
  assert.equal(appShell.match(/expandProcessDetails=\{expandProcessDetails\}/g)?.length, 2);
  assert.match(appShell, /onExpandProcessDetailsChange=\{handleExpandProcessDetailsChange\}/);
  // ChatWindow seeds the fold's initial state from it.
  assert.match(chatWindow, /useState\(defaultExpanded\)/);
  assert.match(chatWindow, /defaultExpanded=\{expandProcessDetails\}/);
  assert.match(settings, /id: "expand-process-details", tab: "general"/);
  assert.match(settings, /<ToggleSwitch checked=\{expandProcessDetails\} onChange=\{onExpandProcessDetailsChange\} \/>/);
});

test("every locale carries the expand-process-details setting copy", async () => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    assert.ok(messages["settingsConfig.expandProcessDetails"], `${locale} label`);
    assert.ok(messages["settingsConfig.expandProcessDetailsDesc"], `${locale} description`);
  }
});
