import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, loadavg } from "node:os";
import { posix } from "node:path";

export interface HostCapacity {
  effectiveCpus: number;
  load1: number;
  busyFraction: number;
  stealFraction: number;
  availableMemoryBytes: number;
  activeSessions: number;
}

interface CpuCounters { busy: number; idle: number; steal: number }
interface EffectiveResources { effectiveCpus: number; availableMemoryBytes: number }
interface ResourceInputs {
  osCpus: number;
  osAvailableMemoryBytes: number;
  cpuMax?: string;
  cpusetCpus?: string;
  memoryMax?: string;
  memoryCurrent?: string;
}

function counter(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseProcStat(text: string): CpuCounters | null {
  const row = text.split("\n").find((line) => /^cpu\s/.test(line));
  if (!row) return null;
  const fields = row.trim().split(/\s+/).slice(1).map(counter);
  if (fields.length < 8 || fields.some((value) => value === null)) return null;
  const values = fields as number[];
  // user/nice already include guest time; iowait is idle, not busy or steal.
  const busy = values[0] + values[1] + values[2] + values[5] + values[6];
  const idle = values[3] + values[4];
  if (!Number.isSafeInteger(busy) || !Number.isSafeInteger(idle)) return null;
  return { busy, idle, steal: values[7] };
}

function cpusetSize(text: string): number | null {
  const ranges: [number, number][] = [];
  for (const part of text.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const start = counter(match[1]);
    const end = counter(match[2] ?? match[1]);
    if (start === null || end === null || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let count = 0;
  let last = -1;
  for (const [start, end] of ranges) {
    if (end > last) count += end - Math.max(start, last + 1) + 1;
    last = Math.max(last, end);
  }
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

export function parseEffectiveResources(input: ResourceInputs): EffectiveResources | null {
  let effectiveCpus = input.osCpus;
  let availableMemoryBytes = input.osAvailableMemoryBytes;
  if (!Number.isSafeInteger(effectiveCpus) || effectiveCpus <= 0
    || !Number.isSafeInteger(availableMemoryBytes) || availableMemoryBytes < 0) return null;

  if (input.cpuMax !== undefined) {
    const fields = input.cpuMax.trim().split(/\s+/);
    if (fields.length !== 2) return null;
    const period = counter(fields[1]);
    if (period === null || period === 0) return null;
    if (fields[0] !== "max") {
      const quota = counter(fields[0]);
      if (quota === null || quota === 0) return null;
      effectiveCpus = Math.min(effectiveCpus, quota / period);
    }
  }
  if (input.cpusetCpus !== undefined) {
    const count = cpusetSize(input.cpusetCpus);
    if (count === null) return null;
    effectiveCpus = Math.min(effectiveCpus, count);
  }
  const current = input.memoryCurrent === undefined ? undefined : counter(input.memoryCurrent.trim());
  if (current === null) return null;
  if (input.memoryMax !== undefined && input.memoryMax.trim() !== "max") {
    const limit = counter(input.memoryMax.trim());
    if (limit === null || current === undefined) return null;
    availableMemoryBytes = Math.min(availableMemoryBytes, Math.max(0, limit - current));
  }
  return { effectiveCpus, availableMemoryBytes };
}

export function capacityFromInterval(
  previous: CpuCounters | null,
  current: CpuCounters,
  resources: EffectiveResources,
  load1: number,
  activeSessions: number,
): HostCapacity | null {
  if (!previous || !Number.isFinite(load1) || load1 < 0
    || !Number.isSafeInteger(activeSessions) || activeSessions < 0) return null;
  const busy = current.busy - previous.busy;
  const idle = current.idle - previous.idle;
  const steal = current.steal - previous.steal;
  const total = busy + idle + steal;
  if (![busy, idle, steal].every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(total) || total <= 0) return null;
  return {
    effectiveCpus: resources.effectiveCpus,
    load1,
    busyFraction: busy / total,
    stealFraction: steal / total,
    availableMemoryBytes: resources.availableMemoryBytes,
    activeSessions,
  };
}

function mountPath(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export function resolveCgroupDirectories(cgroup: string, mountInfo: string): string[] | null {
  const membership = cgroup.split("\n").find((line) => line.startsWith("0::/"));
  if (!membership) return null;
  const path = membership.slice(3);
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  let mount: { root: string; point: string } | null = null;
  for (const line of mountInfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right?.startsWith("cgroup2 ")) continue;
    const fields = left.split(" ");
    if (fields.length < 6) continue;
    const root = mountPath(fields[3]);
    const point = mountPath(fields[4]);
    if (!posix.isAbsolute(root) || !posix.isAbsolute(point)) continue;
    if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) continue;
    // Prefer the full hierarchy when both a delegated mount and its root are visible.
    if (!mount || root.length < mount.root.length) mount = { root, point };
  }
  if (!mount) return null;
  let directory = posix.join(mount.point, posix.relative(mount.root, path));
  const directories: string[] = [];
  while (true) {
    directories.push(directory);
    if (directory === mount.point) return directories;
    const parent = posix.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

let previousCounters: CpuCounters | null = null;

/** Windows has no /proc or cgroups: Node reads per-CPU times and available physical memory from the OS.
 * shortcut: Job Object CPU/memory limits are not applied; read them if Windows workers ever run inside a job. */
function windowsSample(): { current: CpuCounters; resources: EffectiveResources } | null {
  let busy = 0, idle = 0;
  for (const { times } of cpus()) {
    busy += times.user + times.nice + times.sys + times.irq;
    idle += times.idle;
  }
  const available = freemem();
  if (!Number.isSafeInteger(busy) || !Number.isSafeInteger(idle) || busy + idle <= 0 || !Number.isSafeInteger(available)) return null;
  return { current: { busy, idle, steal: 0 }, resources: { effectiveCpus: availableParallelism(), availableMemoryBytes: available } };
}

/** Samples shared host counters; callers supply active turns, not saved sessions. */
export function sampleHostCapacity(activeSessions: number): HostCapacity | null {
  if (process.platform === "win32") {
    const sample = windowsSample();
    // Windows reports no load average; busyFraction carries the CPU pressure there.
    const capacity = sample ? capacityFromInterval(previousCounters, sample.current, sample.resources, 0, activeSessions) : null;
    previousCounters = sample?.current ?? null;
    return capacity;
  }
  if (process.platform !== "linux") return null;
  try {
    const current = parseProcStat(readFileSync("/proc/stat", "utf8"));
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    const directories = resolveCgroupDirectories(
      readFileSync("/proc/self/cgroup", "utf8"),
      readFileSync("/proc/self/mountinfo", "utf8"),
    );
    if (!current || !available || !directories) throw new Error("Capacity counters unavailable");
    const memoryKiB = counter(available[1]);
    if (memoryKiB === null) throw new Error("Invalid available memory counter");
    const osCpus = availableParallelism();
    let resources: EffectiveResources = { effectiveCpus: osCpus, availableMemoryBytes: memoryKiB * 1024 };
    for (const directory of directories) {
      const limits = parseEffectiveResources({
        osCpus,
        osAvailableMemoryBytes: resources.availableMemoryBytes,
        cpuMax: readOptional(posix.join(directory, "cpu.max")),
        cpusetCpus: readOptional(posix.join(directory, "cpuset.cpus.effective")),
        memoryMax: readOptional(posix.join(directory, "memory.max")),
        memoryCurrent: readOptional(posix.join(directory, "memory.current")),
      });
      if (!limits) throw new Error("Invalid cgroup limits");
      resources = {
        effectiveCpus: Math.min(resources.effectiveCpus, limits.effectiveCpus),
        availableMemoryBytes: limits.availableMemoryBytes,
      };
    }
    const sample = capacityFromInterval(previousCounters, current, resources, loadavg()[0], activeSessions);
    previousCounters = current;
    return sample;
  } catch {
    // A failed read breaks the baseline; do not bridge a missing interval.
    previousCounters = null;
    return null;
  }
}
