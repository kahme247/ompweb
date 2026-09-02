// Small number/telemetry formatters shared by subagent UI surfaces
// (composer chips, transcript dialog, task-tool-result panel).

export function formatTokens(tokens: number | undefined): string | null {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1000) {
    const fixed = (tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1);
    return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}k` : `${fixed}k`;
  }
  return String(tokens);
}

export function formatCost(cost: number | undefined): string | null {
  if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1_000) return null;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/** Last path segment of a `provider/model:thinking` resolved-model string. */
export function shortModel(model: string | undefined): string | null {
  if (!model) return null;
  const separator = model.lastIndexOf("/");
  const id = separator >= 0 ? model.slice(separator + 1) : model;
  return id.replace(/:(off|minimal|low|medium|high|xhigh)$/, "") || null;
}

/** Count of nested (grandchild) subagents an agent currently has in flight. */
export function countNestedSubagents(progress: { inflightTaskDetails?: unknown; extractedToolData?: Record<string, unknown[]> } | undefined): number {
  if (!progress) return 0;
  let count = 0;
  const inflight = progress.inflightTaskDetails;
  if (inflight && typeof inflight === "object" && !Array.isArray(inflight)) {
    const details = inflight as Record<string, unknown>;
    if (Array.isArray(details.progress)) count += details.progress.length;
  }
  const extracted = progress.extractedToolData?.task;
  if (Array.isArray(extracted)) {
    // Upstream records one TaskToolDetails per task call:
    // extractedToolData.task = [TaskToolDetails], each with progress[].
    for (const item of extracted) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const details = item as Record<string, unknown>;
        if (Array.isArray(details.progress)) count += details.progress.length;
      }
    }
  }
  return count;
}
