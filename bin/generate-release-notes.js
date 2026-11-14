"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync, existsSync, writeFileSync } = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolve } = require("node:path");

// `owner/name` from package.json's repository (lib/release-repo.ts does the same for the TypeScript side).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DEFAULT_REPO = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(require("../package.json").repository.url)[1];

const IGNORED_CONTRIBUTORS = new Set([
  "kahme247",
  "harvi8",
  "github-actions[bot]",
  "dependabot[bot]",
  "factory-droid[bot]",
  "opencode",
  "root",
  "evox",
  "claude opus",
]);

function extractFromChangelog(changelogContent, tag) {
  if (!changelogContent || !tag) return null;
  const cleanTag = tag.startsWith("v") ? tag : `v${tag}`;
  const rawTag = tag.startsWith("v") ? tag.slice(1) : tag;

  const regex = new RegExp(
    `^##\\s*\\[?(?:v?${cleanTag.slice(1)}|${rawTag})\\]?(?:\\s*-\\s*\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "im"
  );

  const match = regex.exec(changelogContent);
  if (!match) return null;

  const startIndex = match.index + match[0].length;
  const remaining = changelogContent.slice(startIndex);

  const nextSectionMatch = remaining.match(/\n##\s+\[?[v\d]/);
  let sectionContent = nextSectionMatch
    ? remaining.slice(0, nextSectionMatch.index)
    : remaining;

  sectionContent = sectionContent.trim().replace(/\n---\s*$/, "").trim();
  return sectionContent || null;
}

function parseGitLog(rawLog) {
  const commits = [];
  const rawCommits = rawLog.split("---END-COMMIT---");

  for (const block of rawCommits) {
    const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    const hash = lines[0];
    const authorName = lines[1];
    const authorEmail = lines[2];
    const subject = lines[3] || "";
    const bodyLines = lines.slice(4);

    const coAuthors = [];
    for (const bodyLine of bodyLines) {
      const coAuthorMatch = bodyLine.match(/^Co-authored-by:\s*(.+?)\s*<([^>]+)>/i);
      if (coAuthorMatch) {
        coAuthors.push({ name: coAuthorMatch[1].trim(), email: coAuthorMatch[2].trim() });
      }
    }

    commits.push({
      hash,
      author: { name: authorName, email: authorEmail },
      subject,
      coAuthors,
    });
  }

  return commits;
}

function cleanSubject(subject, repo = DEFAULT_REPO) {
  let cleaned = subject.trim();

  cleaned = cleaned.replace(/^(?:feat|fix|perf|refactor|style|security|docs|chore|test|ci|build)(?:\([^)]+\))?!?:?\s*/i, "");

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  cleaned = cleaned.replace(/\(#(\d+)\)/g, `([#$1](https://github.com/${repo}/pull/$1))`);

  return cleaned;
}

function extractUsername(name, email) {
  if (!name && !email) return null;

  const ghMatch = (email || "").match(/^(?:\d+\+)?([a-zA-Z0-9-]+)@users\.noreply\.github\.com$/i);
  if (ghMatch) {
    return ghMatch[1];
  }

  const cleanName = (name || "").replace(/^@/, "").trim();
  if (/^[a-zA-Z0-9_-]+$/.test(cleanName) && cleanName.length >= 2 && cleanName.length <= 39) {
    return cleanName;
  }

  return null;
}

function extractContributors(commits) {
  const contributorMap = new Map();

  for (const c of commits) {
    const people = [c.author, ...c.coAuthors];
    for (const p of people) {
      if (!p || !p.email) continue;
      const lowerEmail = p.email.toLowerCase();
      const lowerName = (p.name || "").toLowerCase();

      let isIgnored = false;
      for (const ign of IGNORED_CONTRIBUTORS) {
        if (lowerEmail.includes(ign) || lowerName === ign) {
          isIgnored = true;
          break;
        }
      }
      if (isIgnored) continue;

      const username = extractUsername(p.name, p.email);
      if (username && !IGNORED_CONTRIBUTORS.has(username.toLowerCase())) {
        contributorMap.set(`@${username}`, true);
      } else if (p.name && !IGNORED_CONTRIBUTORS.has(lowerName)) {
        contributorMap.set(p.name, true);
      }
    }
  }

  return Array.from(contributorMap.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function formatReleaseNotes({
  tag,
  version,
  changelogBody,
  commits = [],
  previousTag,
  repo = DEFAULT_REPO,
}) {
  const lines = [];

  if (changelogBody) {
    lines.push(changelogBody);
  } else {
    const features = [];
    const fixes = [];
    const others = [];

    for (const c of commits) {
      const s = c.subject.trim();
      if (/^(?:chore: )?release( ompweb)? v?[0-9]/i.test(s) || /^v?[0-9]+\.[0-9]+\.[0-9]+$/i.test(s)) {
        continue;
      }

      const cleaned = cleanSubject(s, repo);
      if (/^feat(?:\([^)]+\))?!?:/i.test(s)) {
        features.push(cleaned);
      } else if (/^(?:fix|perf|refactor|style|security)(?:\([^)]+\))?!?:/i.test(s)) {
        fixes.push(cleaned);
      } else {
        others.push(cleaned);
      }
    }

    if (features.length > 0) {
      lines.push("## Highlights\n");
      for (const item of features) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    if (fixes.length > 0) {
      lines.push("## Fixes & Improvements\n");
      for (const item of fixes) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    if (others.length > 0 && features.length === 0 && fixes.length === 0) {
      lines.push("## Changes\n");
      for (const item of others) {
        lines.push(`- ${item}`);
      }
      lines.push("");
    }

    const contributors = extractContributors(commits);
    if (contributors.length > 0) {
      lines.push("## Contributors\n");
      lines.push("Thank you to the contributors who made this release possible:");
      for (const contributor of contributors) {
        lines.push(`- ${contributor}`);
      }
      lines.push("");
    }
  }

  if (!lines.join("\n").includes("## Upgrade")) {
    lines.push("\n## Upgrade\n");
    lines.push("```bash");
    lines.push(`npm install -g @kahme247/ompweb@${version}`);
    lines.push("```");
  }

  if (!lines.join("\n").includes("**Full changelog:**")) {
    const changelogUrl = previousTag
      ? `https://github.com/${repo}/compare/${previousTag}...${tag}`
      : `https://github.com/${repo}/releases/tag/${tag}`;
    lines.push(`\n**Full changelog:** ${changelogUrl}`);
  }

  return lines.join("\n").trim() + "\n";
}

function generateReleaseNotes({
  tag,
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  changelogPath = "CHANGELOG.md",
  cwd = process.cwd(),
} = {}) {
  if (!tag) {
    throw new Error("Release tag is required (e.g. v0.3.6)");
  }

  const cleanTag = tag.startsWith("v") ? tag : `v${tag}`;
  const version = cleanTag.slice(1);

  let changelogBody = null;
  const fullChangelogPath = resolve(cwd, changelogPath);
  if (existsSync(fullChangelogPath)) {
    const content = readFileSync(fullChangelogPath, "utf8");
    changelogBody = extractFromChangelog(content, cleanTag);
  }

  let previousTag = "";
  try {
    previousTag = execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0", `${cleanTag}^`, "--match", "v*"],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
    ).trim();
  } catch {
    previousTag = "";
  }

  const range = previousTag ? `${previousTag}..${cleanTag}` : cleanTag;
  let commits = [];
  try {
    const rawLog = execFileSync(
      "git",
      ["log", range, "--format=%H%n%an%n%ae%n%s%n%b%n---END-COMMIT---"],
      { cwd, encoding: "utf8" }
    );
    commits = parseGitLog(rawLog, repo);
  } catch {
    commits = [];
  }

  return formatReleaseNotes({
    tag: cleanTag,
    version,
    changelogBody,
    commits,
    previousTag,
    repo,
  });
}

module.exports = {
  extractFromChangelog,
  parseGitLog,
  cleanSubject,
  extractUsername,
  extractContributors,
  formatReleaseNotes,
  generateReleaseNotes,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let tag = process.env.TAG || process.env.GITHUB_REF_NAME;
  let outputPath = null;
  let repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  let changelogPath = "CHANGELOG.md";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) {
      tag = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (args[i] === "--changelog" && args[i + 1]) {
      changelogPath = args[++i];
    }
  }

  if (!tag) {
    console.error("Usage: generate-release-notes.js --tag <tag> [--output <file>] [--repo <owner/repo>]");
    process.exit(1);
  }

  try {
    const notes = generateReleaseNotes({ tag, repo, changelogPath });
    if (outputPath) {
      writeFileSync(outputPath, notes, "utf8");
      console.log(`Release notes written to ${outputPath}`);
    } else {
      process.stdout.write(notes);
    }
  } catch (err) {
    console.error(`Error generating release notes: ${err.message}`);
    process.exit(1);
  }
}
