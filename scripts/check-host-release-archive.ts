// `bun scripts/check-host-release-archive.ts release/ompweb-<os>-<arch>.tar.gz` (.zip for Windows): unpacks a built
// release archive through the host updater's own checks and limits (lib/hosts/update-worker.ts), so a release the
// updater would refuse fails the build instead.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { extractHostReleaseArchive, HOST_RELEASE_MAX_ARCHIVE, HOST_RELEASE_MAX_EXPANDED, HOST_RELEASE_MAX_MEMBER } from "../lib/hosts/update-worker";

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const archive = process.argv[2];
if (!archive) throw new Error("usage: check-host-release-archive.ts <release archive>");
const size = statSync(archive).size;
if (size > HOST_RELEASE_MAX_ARCHIVE) throw new Error(`${archive} is ${mib(size)}, over the host updater's ${mib(HOST_RELEASE_MAX_ARCHIVE)}`);
const staging = mkdtempSync(join(tmpdir(), "ompweb-release-check-"));
try {
  const members = await extractHostReleaseArchive(archive, basename(archive).replace(/\.(tar\.gz|zip)$/, ""), staging);
  const largest = members.reduce((a, b) => (b.size > a.size ? b : a));
  const total = members.reduce((sum, member) => sum + member.size, 0);
  console.log(`${archive}: ${mib(size)} of ${mib(HOST_RELEASE_MAX_ARCHIVE)}; largest member ${largest.name} ${mib(largest.size)} of ${mib(HOST_RELEASE_MAX_MEMBER)}; expanded ${mib(total)} of ${mib(HOST_RELEASE_MAX_EXPANDED)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
