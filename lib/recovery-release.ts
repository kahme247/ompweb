import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";
import { fetchHostUpdateBytes } from "./hosts/update-worker";
import type { LegacyRecoveryRelease } from "./hosts/legacy-recovery";
import { releaseRepo } from "./release-repo";
import { isRecord } from "./type-guards";

const TAG = /^(?:v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?|\d{8}T\d{6}Z-[a-f0-9]{7,40})$/;
let cached: { tag: string; checkedAt: number; release: LegacyRecoveryRelease } | undefined;

/** A prerelease's package version is not its artifact identity: use the tag stamped into that exact build. */
export function installedRecoveryTag(): string {
  const file = join(process.env.OMP_WEB_PACKAGE_DIR || process.cwd(), "build-info.json");
  if (!existsSync(file)) return `v${packageJson.version}`;
  const info: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(info) || info.version !== packageJson.version || typeof info.releaseTag !== "string" || !TAG.test(info.releaseTag)) {
    throw new Error("This installation has invalid recovery release identity metadata");
  }
  return info.releaseTag;
}

export async function recoveryHelperRelease(force = false): Promise<LegacyRecoveryRelease> {
  const tag = installedRecoveryTag();
  if (!force && cached?.tag === tag && Date.now() - cached.checkedAt < 5 * 60_000) return cached.release;
  const repo = releaseRepo();
  const value: unknown = JSON.parse((await fetchHostUpdateBytes(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, 2 * 1024 * 1024)).toString("utf8"));
  if (!isRecord(value) || value.tag_name !== tag || value.draft === true || !Array.isArray(value.assets)) {
    throw new Error("The server's matching published recovery release is unavailable");
  }
  const assets: LegacyRecoveryRelease["assets"] = [];
  for (const item of value.assets) {
    if (!isRecord(item) || typeof item.name !== "string" || !/^ompweb-(?:linux|darwin)-(?:x64|arm64)\.tar\.gz$|^ompweb-windows-x64\.zip$/.test(item.name)) continue;
    if (typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest) || assets.some((asset) => asset.name === item.name)) {
      throw new Error("The recovery release has an invalid or duplicate asset digest");
    }
    assets.push({ name: item.name, digest: item.digest });
  }
  if (!assets.length) throw new Error("The server's recovery release contains no verified platform binaries");
  const release: LegacyRecoveryRelease = { version: packageJson.version, tag, repo, assets };
  cached = { tag, checkedAt: Date.now(), release };
  return release;
}
