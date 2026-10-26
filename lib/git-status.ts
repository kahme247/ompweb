import type { GitCollapseReason, GitFileStatus } from "./git-types";

/** Attributes queried by `git check-attr` for `parseGitCollapseReasons`. */
export const GIT_REVIEW_ATTRIBUTES = [
  "linguist-generated",
  "linguist-vendored",
  "linguist-documentation",
  "diff",
  "binary",
] as const;

function collapseReasonFromAttributes(
  diff: string | undefined,
  binary: string | undefined,
  generated: string | undefined,
  vendored: string | undefined,
  documentation: string | undefined,
): GitCollapseReason | undefined {
  // `no-diff` wins so callers can suppress the diff from the reason alone.
  // `binary` also unsets diff; binary changes (images, fonts) stay in the main list.
  if (diff === "unset" && binary !== "set") return "no-diff";
  if (generated === "set" || generated === "true") return "generated";
  if (vendored === "set" || vendored === "true") return "vendored";
  if (documentation === "set" || documentation === "true") return "documentation";
  return undefined;
}

/** Parses `git check-attr -z` output (`path NUL attr NUL value NUL` triples). */
export function parseGitCollapseReasons(output: string): Map<string, GitCollapseReason> {
  const reasons = new Map<string, GitCollapseReason>();
  let currentPath = "";
  let diff: string | undefined;
  let binary: string | undefined;
  let generated: string | undefined;
  let vendored: string | undefined;
  let documentation: string | undefined;

  let pos = 0;
  const len = output.length;
  while (pos < len) {
    const pEnd = output.indexOf("\0", pos);
    if (pEnd === -1) break;
    const aStart = pEnd + 1;
    const aEnd = output.indexOf("\0", aStart);
    if (aEnd === -1) break;
    const vStart = aEnd + 1;
    const vEnd = output.indexOf("\0", vStart);
    if (vEnd === -1) break;

    const filePath = output.slice(pos, pEnd);
    const attr = output.slice(aStart, aEnd);
    const value = output.slice(vStart, vEnd);
    pos = vEnd + 1;

    if (filePath !== currentPath) {
      if (currentPath) {
        const reason = collapseReasonFromAttributes(diff, binary, generated, vendored, documentation);
        if (reason) reasons.set(currentPath, reason);
      }
      currentPath = filePath;
      diff = undefined;
      binary = undefined;
      generated = undefined;
      vendored = undefined;
      documentation = undefined;
    }

    if (attr === "diff") diff = value;
    else if (attr === "binary") binary = value;
    else if (attr === "linguist-generated") generated = value;
    else if (attr === "linguist-vendored") vendored = value;
    else if (attr === "linguist-documentation") documentation = value;
  }

  if (currentPath) {
    const reason = collapseReasonFromAttributes(diff, binary, generated, vendored, documentation);
    if (reason) reasons.set(currentPath, reason);
  }
  return reasons;
}

export interface GitPorcelainEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

function usesRenamePath(indexStatus: string, worktreeStatus: string): boolean {
  return indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
}

export function parseGitPorcelainV1(output: string): GitPorcelainEntry[] {
  const records = output.split("\0");
  const entries: GitPorcelainEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4 || record[2] !== " ") continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const entry: GitPorcelainEntry = {
      path: record.slice(3),
      indexStatus,
      worktreeStatus,
    };
    if (usesRenamePath(indexStatus, worktreeStatus)) {
      entry.originalPath = records[++i] || undefined;
    }
    entries.push(entry);
  }

  return entries;
}

const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function classifyGitStatus(entry: GitPorcelainEntry): Pick<GitFileStatus, "status" | "code"> {
  const pair = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (pair === "??") return { status: "untracked", code: "U" };
  if (CONFLICT_STATUSES.has(pair) || pair.includes("U")) return { status: "conflict", code: "C" };
  if (pair.includes("D")) return { status: "deleted", code: "D" };
  if (pair.includes("R") || pair.includes("C")) return { status: "renamed", code: "R" };
  if (pair.includes("A")) return { status: "added", code: "A" };
  return { status: "modified", code: "M" };
}
