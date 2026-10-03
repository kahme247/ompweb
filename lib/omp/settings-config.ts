import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { isMap, parseDocument, stringify } from "yaml";
import { getSettingsPath } from "./paths";
import { isRecord } from "../type-guards";
import { effectiveCompactionMethodOrder, isCompactionMethodOrder, type CompactionMethod } from "../compaction-methods";

export type NativeSettings = {
  defaultThinkingLevel?: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  providers?: { autoThinkingSource?: "classifier" | "vendor" };
  hideThinkingBlock?: boolean;
  externalThinking?: boolean;
  textVerbosity?: "low" | "medium" | "high";
  personality?: "default" | "friendly" | "pragmatic" | "none";
  advisor?: { enabled?: boolean; subagents?: boolean; syncBacklog?: "off" | "1" | "3" | "5"; immuneTurns?: number };
  tools?: { approvalMode?: "always-ask" | "write" | "yolo"; approval?: { bash?: "allow" | "prompt" | "deny"; extension?: "allow" | "prompt" } };
  enabledModels?: string[];
  disabledProviders?: string[];
  modelProviderOrder?: string[];
  registryHasScopedEntries?: boolean;
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    modelFallback?: boolean;
    fallbackRevertPolicy?: "cooldown-expiry" | "never";
    fallbackChains?: Record<string, string[]>;
  };
  compaction?: { enabled?: boolean; midTurnEnabled?: boolean; methodOrder?: CompactionMethod[]; autoContinue?: boolean; keepRecentTokens?: number };
  memory?: { backend?: "off" | "local" | "mnemopi" | "hindsight" };
  autolearn?: { enabled?: boolean; autoContinue?: boolean; minToolCalls?: number };
  mnemopi?: { scoping?: "global" | "per-project" | "per-project-tagged"; autoRecall?: boolean; autoRetain?: boolean; noEmbeddings?: boolean };
  mcp?: { enableProjectConfig?: boolean; renderMarkdownResults?: boolean; notifications?: boolean; notificationDebounceMs?: number };
};

const THINKING_LEVELS = new Set(["auto", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TEXT_VERBOSITIES = new Set(["low", "medium", "high"]);
const PERSONALITIES = new Set(["default", "friendly", "pragmatic", "none"]);
const BACKLOGS = new Set(["off", "1", "3", "5"]);
const APPROVAL_MODES = new Set(["always-ask", "write", "yolo"]);
const APPROVAL_POLICIES = new Set(["allow", "prompt", "deny"]);
const FALLBACK_REVERT_POLICIES = new Set(["cooldown-expiry", "never"]);
const MEMORY_BACKENDS = new Set(["off", "local", "mnemopi", "hindsight"]);
const MEMORY_SCOPES = new Set(["global", "per-project", "per-project-tagged"]);

function configPath(): string {
  return getSettingsPath();
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function assertOptionalRecord(value: unknown, name: string): asserts value is Record<string, unknown> | undefined {
  if (value !== undefined && !isRecord(value)) throw new Error(`${name} must be an object`);
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function readDocument() {
  const path = configPath();
  const doc = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0].message}`);
  return { path, doc };
}

/** Returns the persisted native OMP values only; omitted keys keep OMP defaults. */
export function readNativeSettings(): { path: string; settings: NativeSettings } {
  const { path, doc } = readDocument();
  const data = doc.toJS();
  if (!isRecord(data)) return { path, settings: {} };
  const advisor = isRecord(data.advisor) ? data.advisor : {};
  const providers = isRecord(data.providers) ? data.providers : {};
  const autoThinkingSource = providers.autoThinkingSource;
  const tools = isRecord(data.tools) ? data.tools : {};
  const approval = isRecord(tools.approval) ? tools.approval : {};
  const retry = isRecord(data.retry) ? data.retry : {};
  const fallbackChains = isRecord(retry.fallbackChains)
    ? Object.fromEntries(Object.entries(retry.fallbackChains).filter((entry): entry is [string, string[]] => typeof entry[0] === "string" && stringArray(entry[1]) !== undefined))
    : {};
  const compaction = isRecord(data.compaction) ? data.compaction : {};
  // omp's migration also accepts top-level dotted keys, nested values winning.
  const methodOrder = effectiveCompactionMethodOrder({
    methodOrder: data["compaction.methodOrder"],
    strategy: data["compaction.strategy"],
    remoteEnabled: data["compaction.remoteEnabled"],
    ...Object.fromEntries(Object.entries(compaction).filter(([, value]) => value != null)),
  });
  const memory = isRecord(data.memory) ? data.memory : {};
  const autolearn = isRecord(data.autolearn) ? data.autolearn : {};
  const mnemopi = isRecord(data.mnemopi) ? data.mnemopi : {};
  const mcp = isRecord(data.mcp) ? data.mcp : {};
  const registryHasScopedEntries = [data.enabledModels, data.disabledProviders, data.modelProviderOrder]
    .some((value) => Array.isArray(value) && !value.every((item) => typeof item === "string"));
  return {
    path,
    settings: {
      ...(THINKING_LEVELS.has(data.defaultThinkingLevel as string) ? { defaultThinkingLevel: data.defaultThinkingLevel as NativeSettings["defaultThinkingLevel"] } : {}),
      ...(autoThinkingSource === "classifier" || autoThinkingSource === "vendor"
        ? { providers: { autoThinkingSource } }
        : {}),
      ...(typeof data.hideThinkingBlock === "boolean" ? { hideThinkingBlock: data.hideThinkingBlock } : {}),
      ...(typeof data.externalThinking === "boolean" ? { externalThinking: data.externalThinking } : {}),
      ...(TEXT_VERBOSITIES.has(data.textVerbosity as string) ? { textVerbosity: data.textVerbosity as NativeSettings["textVerbosity"] } : {}),
      ...(PERSONALITIES.has(data.personality as string) ? { personality: data.personality as NativeSettings["personality"] } : {}),
      ...(Object.keys(advisor).length ? {
        advisor: {
          ...(typeof advisor.enabled === "boolean" ? { enabled: advisor.enabled } : {}),
          ...(typeof advisor.subagents === "boolean" ? { subagents: advisor.subagents } : {}),
          ...(BACKLOGS.has(advisor.syncBacklog as string) ? { syncBacklog: advisor.syncBacklog as "off" | "1" | "3" | "5" } : {}),
          ...(typeof advisor.immuneTurns === "number" && Number.isInteger(advisor.immuneTurns) ? { immuneTurns: advisor.immuneTurns } : {}),
        },
      } : {}),
      ...(Object.keys(tools).length ? { tools: {
        ...(APPROVAL_MODES.has(tools.approvalMode as string) ? { approvalMode: tools.approvalMode as "always-ask" | "write" | "yolo" } : {}),
        ...(APPROVAL_POLICIES.has(approval.bash as string) || approval.extension === "allow" || approval.extension === "prompt" ? { approval: {
          ...(APPROVAL_POLICIES.has(approval.bash as string) ? { bash: approval.bash as "allow" | "prompt" | "deny" } : {}),
          ...(approval.extension === "allow" || approval.extension === "prompt" ? { extension: approval.extension } : {}),
        } } : {}),
      } } : {}),
      ...(stringArray(data.enabledModels) ? { enabledModels: stringArray(data.enabledModels) } : {}),
      ...(stringArray(data.disabledProviders) ? { disabledProviders: stringArray(data.disabledProviders) } : {}),
      ...(stringArray(data.modelProviderOrder) ? { modelProviderOrder: stringArray(data.modelProviderOrder) } : {}),
      ...(registryHasScopedEntries ? { registryHasScopedEntries: true } : {}),
      ...(Object.keys(retry).length ? { retry: {
        ...(typeof retry.enabled === "boolean" ? { enabled: retry.enabled } : {}),
        ...(typeof retry.maxRetries === "number" && Number.isInteger(retry.maxRetries) ? { maxRetries: retry.maxRetries } : {}),
        ...(typeof retry.modelFallback === "boolean" ? { modelFallback: retry.modelFallback } : {}),
        ...(FALLBACK_REVERT_POLICIES.has(retry.fallbackRevertPolicy as string) ? { fallbackRevertPolicy: retry.fallbackRevertPolicy as "cooldown-expiry" | "never" } : {}),
        ...(Object.keys(fallbackChains).length ? { fallbackChains } : {}),
      } } : {}),
      ...(Object.keys(compaction).length || methodOrder ? { compaction: {
        ...(typeof compaction.enabled === "boolean" ? { enabled: compaction.enabled } : {}),
        ...(typeof compaction.midTurnEnabled === "boolean" ? { midTurnEnabled: compaction.midTurnEnabled } : {}),
        ...(methodOrder ? { methodOrder } : {}),
        ...(typeof compaction.autoContinue === "boolean" ? { autoContinue: compaction.autoContinue } : {}),
        ...(typeof compaction.keepRecentTokens === "number" && Number.isInteger(compaction.keepRecentTokens) ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
      } } : {}),
      ...(Object.keys(memory).length ? { memory: { ...(MEMORY_BACKENDS.has(memory.backend as string) ? { backend: memory.backend as "off" | "local" | "mnemopi" | "hindsight" } : {}) } } : {}),
      ...(Object.keys(autolearn).length ? { autolearn: {
        ...(typeof autolearn.enabled === "boolean" ? { enabled: autolearn.enabled } : {}),
        ...(typeof autolearn.autoContinue === "boolean" ? { autoContinue: autolearn.autoContinue } : {}),
        ...(typeof autolearn.minToolCalls === "number" && Number.isInteger(autolearn.minToolCalls) ? { minToolCalls: autolearn.minToolCalls } : {}),
      } } : {}),
      ...(Object.keys(mnemopi).length ? { mnemopi: {
        ...(MEMORY_SCOPES.has(mnemopi.scoping as string) ? { scoping: mnemopi.scoping as "global" | "per-project" | "per-project-tagged" } : {}),
        ...(typeof mnemopi.autoRecall === "boolean" ? { autoRecall: mnemopi.autoRecall } : {}),
        ...(typeof mnemopi.autoRetain === "boolean" ? { autoRetain: mnemopi.autoRetain } : {}),
        ...(typeof mnemopi.noEmbeddings === "boolean" ? { noEmbeddings: mnemopi.noEmbeddings } : {}),
      } } : {}),
      ...(Object.keys(mcp).length ? { mcp: {
        ...(typeof mcp.enableProjectConfig === "boolean" ? { enableProjectConfig: mcp.enableProjectConfig } : {}),
        ...(typeof mcp.renderMarkdownResults === "boolean" ? { renderMarkdownResults: mcp.renderMarkdownResults } : {}),
        ...(typeof mcp.notifications === "boolean" ? { notifications: mcp.notifications } : {}),
        ...(typeof mcp.notificationDebounceMs === "number" && Number.isInteger(mcp.notificationDebounceMs) ? { notificationDebounceMs: mcp.notificationDebounceMs } : {}),
      } } : {}),
    },
  };
}

/** Validates and applies a reviewed subset of OMP's global config schema. */
export function writeNativeSettings(settings: NativeSettings): void {
  if (!isRecord(settings)) throw new Error("Settings must be an object");
  assertOptionalRecord(settings.providers, "providers");
  const autoThinkingSource = settings.providers?.autoThinkingSource;
  if (autoThinkingSource !== undefined && autoThinkingSource !== "classifier" && autoThinkingSource !== "vendor") {
    throw new Error("Invalid Auto thinking source");
  }
  assertOptionalRecord(settings.advisor, "advisor");
  assertOptionalRecord(settings.tools, "tools");
  assertOptionalRecord(settings.tools?.approval, "tools.approval");
  assertOptionalRecord(settings.retry, "retry");
  assertOptionalRecord(settings.compaction, "compaction");
  assertOptionalRecord(settings.memory, "memory");
  assertOptionalRecord(settings.autolearn, "autolearn");
  assertOptionalRecord(settings.mnemopi, "mnemopi");
  assertOptionalRecord(settings.mcp, "mcp");
  for (const [name, value] of Object.entries({
    hideThinkingBlock: settings.hideThinkingBlock,
    externalThinking: settings.externalThinking,
    "advisor.enabled": settings.advisor?.enabled,
    "advisor.subagents": settings.advisor?.subagents,
    "retry.enabled": settings.retry?.enabled,
    "retry.modelFallback": settings.retry?.modelFallback,
    "compaction.enabled": settings.compaction?.enabled,
    "compaction.midTurnEnabled": settings.compaction?.midTurnEnabled,
    "compaction.autoContinue": settings.compaction?.autoContinue,
    "autolearn.enabled": settings.autolearn?.enabled,
    "autolearn.autoContinue": settings.autolearn?.autoContinue,
    "mnemopi.autoRecall": settings.mnemopi?.autoRecall,
    "mnemopi.autoRetain": settings.mnemopi?.autoRetain,
    "mnemopi.noEmbeddings": settings.mnemopi?.noEmbeddings,
    "mcp.enableProjectConfig": settings.mcp?.enableProjectConfig,
    "mcp.renderMarkdownResults": settings.mcp?.renderMarkdownResults,
    "mcp.notifications": settings.mcp?.notifications,
  })) assertOptionalBoolean(value, name);
  if (settings.defaultThinkingLevel !== undefined && !THINKING_LEVELS.has(settings.defaultThinkingLevel)) throw new Error("Invalid default thinking level");
  if (settings.textVerbosity !== undefined && !TEXT_VERBOSITIES.has(settings.textVerbosity)) throw new Error("Invalid text verbosity");
  if (settings.personality !== undefined && !PERSONALITIES.has(settings.personality)) throw new Error("Invalid personality");
  if (settings.advisor?.syncBacklog !== undefined && !BACKLOGS.has(settings.advisor.syncBacklog)) throw new Error("Invalid advisor sync backlog");
  if (settings.advisor?.immuneTurns !== undefined && (!Number.isInteger(settings.advisor.immuneTurns) || settings.advisor.immuneTurns < 0 || settings.advisor.immuneTurns > 20)) throw new Error("Advisor immune turns must be an integer between 0 and 20");
  if (settings.tools?.approvalMode !== undefined && !APPROVAL_MODES.has(settings.tools.approvalMode)) throw new Error("Invalid approval mode");
  if (settings.tools?.approval?.bash !== undefined && !APPROVAL_POLICIES.has(settings.tools.approval.bash)) throw new Error("Invalid Bash approval policy");
  if (settings.tools?.approval?.extension !== undefined && settings.tools.approval.extension !== "allow" && settings.tools.approval.extension !== "prompt") throw new Error("Invalid extension tool approval policy");
  if (settings.retry?.maxRetries !== undefined && (!Number.isInteger(settings.retry.maxRetries) || settings.retry.maxRetries < 0 || settings.retry.maxRetries > 20)) throw new Error("Retry attempts must be an integer between 0 and 20");
  if (settings.retry?.fallbackRevertPolicy !== undefined && !FALLBACK_REVERT_POLICIES.has(settings.retry.fallbackRevertPolicy)) throw new Error("Invalid fallback revert policy");
  if (settings.retry?.fallbackChains !== undefined) {
    for (const [role, chain] of Object.entries(settings.retry.fallbackChains)) {
      if (!role.trim() || !Array.isArray(chain) || chain.some((selector) => typeof selector !== "string" || !selector.trim())) throw new Error("Fallback chains require non-empty role and model selectors");
    }
  }
  if (settings.compaction?.methodOrder !== undefined && !isCompactionMethodOrder(settings.compaction.methodOrder)) throw new Error("Invalid compaction method order");
  if (settings.compaction?.keepRecentTokens !== undefined && (!Number.isInteger(settings.compaction.keepRecentTokens) || settings.compaction.keepRecentTokens < 1_000 || settings.compaction.keepRecentTokens > 1_000_000)) throw new Error("Compaction retained tokens must be an integer between 1,000 and 1,000,000");
  if (settings.memory?.backend !== undefined && !MEMORY_BACKENDS.has(settings.memory.backend)) throw new Error("Invalid memory backend");
  if (settings.autolearn?.minToolCalls !== undefined && (!Number.isInteger(settings.autolearn.minToolCalls) || settings.autolearn.minToolCalls < 0 || settings.autolearn.minToolCalls > 100)) throw new Error("Auto-learn minimum tool calls must be an integer between 0 and 100");
  if (settings.mnemopi?.scoping !== undefined && !MEMORY_SCOPES.has(settings.mnemopi.scoping)) throw new Error("Invalid Mnemopi memory scope");
  if (settings.mcp?.notificationDebounceMs !== undefined && (!Number.isInteger(settings.mcp.notificationDebounceMs) || settings.mcp.notificationDebounceMs < 0 || settings.mcp.notificationDebounceMs > 60_000)) throw new Error("MCP notification debounce must be an integer between 0 and 60,000");
  for (const [key, values] of Object.entries({ enabledModels: settings.enabledModels, disabledProviders: settings.disabledProviders, modelProviderOrder: settings.modelProviderOrder })) {
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim()))) throw new Error(`${key} must contain non-empty strings`);
  }

  const { path, doc } = readDocument();
  mkdirSync(dirname(path), { recursive: true });
  if (doc.contents === null) {
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, stringify(settings), "utf8");
    renameSync(temp, path);
    return;
  }
  if (!isMap(doc.contents)) throw new Error(`${path} must contain a YAML mapping`);
  if (settings.defaultThinkingLevel !== undefined) doc.set("defaultThinkingLevel", settings.defaultThinkingLevel);
  if (autoThinkingSource !== undefined) doc.setIn(["providers", "autoThinkingSource"], autoThinkingSource);
  if (settings.hideThinkingBlock !== undefined) doc.set("hideThinkingBlock", settings.hideThinkingBlock);
  if (settings.externalThinking !== undefined) doc.set("externalThinking", settings.externalThinking);
  if (settings.textVerbosity !== undefined) doc.set("textVerbosity", settings.textVerbosity);
  if (settings.personality !== undefined) doc.set("personality", settings.personality);
  for (const [key, value] of Object.entries(settings.advisor ?? {})) doc.setIn(["advisor", key], value);
  if (settings.tools?.approvalMode !== undefined) doc.setIn(["tools", "approvalMode"], settings.tools.approvalMode);
  if (settings.tools?.approval?.bash !== undefined) doc.setIn(["tools", "approval", "bash"], settings.tools.approval.bash);
  if (settings.tools?.approval?.extension !== undefined) doc.setIn(["tools", "approval", "extension"], settings.tools.approval.extension);
  if (settings.enabledModels !== undefined) doc.set("enabledModels", settings.enabledModels);
  if (settings.disabledProviders !== undefined) doc.set("disabledProviders", settings.disabledProviders);
  if (settings.modelProviderOrder !== undefined) doc.set("modelProviderOrder", settings.modelProviderOrder);
  for (const [key, value] of Object.entries(settings.retry ?? {})) doc.setIn(["retry", key], value);
  for (const [key, value] of Object.entries(settings.compaction ?? {})) doc.setIn(["compaction", key], value);
  for (const [key, value] of Object.entries(settings.memory ?? {})) doc.setIn(["memory", key], value);
  for (const [key, value] of Object.entries(settings.autolearn ?? {})) doc.setIn(["autolearn", key], value);
  for (const [key, value] of Object.entries(settings.mnemopi ?? {})) doc.setIn(["mnemopi", key], value);
  for (const [key, value] of Object.entries(settings.mcp ?? {})) doc.setIn(["mcp", key], value);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, doc.toString(), "utf8");
  renameSync(temp, path);
}
