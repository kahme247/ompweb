import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { parseProcStat, parseEffectiveResources, capacityFromInterval, resolveCgroupDirectories } = await import("./capacity.ts");

const GiB = 1024 ** 3;
const resources = (overrides = {}) => ({
  osCpus: 8,
  osAvailableMemoryBytes: 64 * GiB,
  cpuMax: "max 100000\n",
  cpusetCpus: "0-7\n",
  memoryMax: "max\n",
  memoryCurrent: "8589934592\n",
  ...overrides,
});

// guest/guest_nice are already included in user/nice, not additional busy time.
const before = `cpu  100 20 30 400 10 5 5 10 20 5
cpu0 50 10 15 200 5 2 3 5 10 2
intr 1234
`;
const after = `cpu  120 25 40 440 15 10 10 20 25 7
cpu0 60 12 20 220 7 5 5 10 12 3
intr 1240
`;

// These literals yield deltas: busy=45, idle+iowait=45, steal=10.
const firstCounters = { busy: 160, idle: 410, steal: 10 };
const secondCounters = { busy: 205, idle: 455, steal: 20 };
const effective = { effectiveCpus: 1.5, availableMemoryBytes: 16 * GiB };

test("a 24 GiB cgroup exposes only memory.max minus memory.current, not host free RAM", () => {
  assert.deepEqual(parseEffectiveResources(resources({
    cpuMax: "150000 100000\n",
    memoryMax: "25769803776\n",
  })), effective);
});

test("OS availability can further lower cgroup memory headroom", () => {
  assert.deepEqual(parseEffectiveResources(resources({
    osAvailableMemoryBytes: 3 * GiB,
    memoryMax: "25769803776\n",
  })), { effectiveCpus: 8, availableMemoryBytes: 3 * GiB });
});

test("memory already at or above its limit has no available headroom", () => {
  for (const memoryCurrent of ["25769803776", "26843545600"]) {
    assert.deepEqual(parseEffectiveResources(resources({
      memoryMax: "25769803776",
      memoryCurrent,
    })), { effectiveCpus: 8, availableMemoryBytes: 0 });
  }
});

test("CPU quota remains fractional rather than rounding to a whole CPU", () => {
  assert.deepEqual(parseEffectiveResources(resources({ cpuMax: "150000 100000" })), {
    effectiveCpus: 1.5,
    availableMemoryBytes: 64 * GiB,
  });
});

test("an effective cpuset can lower the CPU quota", () => {
  assert.deepEqual(parseEffectiveResources(resources({
    cpuMax: "150000 100000",
    cpusetCpus: "3\n",
  })), { effectiveCpus: 1, availableMemoryBytes: 64 * GiB });
});

test("a finite CPU quota cannot expose more CPUs than the OS reports", () => {
  assert.deepEqual(parseEffectiveResources(resources({
    osCpus: 2,
    cpuMax: "400000 100000",
  })), { effectiveCpus: 2, availableMemoryBytes: 64 * GiB });
});

test("cpuset ranges and disjoint CPU IDs are counted, not their highest CPU ID", () => {
  assert.deepEqual(parseEffectiveResources(resources({ cpusetCpus: "0-2,6,8-9\n" })), {
    effectiveCpus: 6,
    availableMemoryBytes: 64 * GiB,
  });
});

test("unlimited cgroups still use OS CPU and memory bounds", () => {
  assert.deepEqual(parseEffectiveResources(resources({
    osCpus: 2,
    osAvailableMemoryBytes: 5 * GiB,
  })), { effectiveCpus: 2, availableMemoryBytes: 5 * GiB });
});

test("absent cgroup files leave the OS bounds intact", () => {
  assert.deepEqual(parseEffectiveResources({ osCpus: 4, osAvailableMemoryBytes: 7 * GiB }), {
    effectiveCpus: 4,
    availableMemoryBytes: 7 * GiB,
  });
});

test("a finite memory limit without its current counter is not a trustworthy sample", () => {
  assert.equal(parseEffectiveResources(resources({
    memoryMax: "25769803776",
    memoryCurrent: undefined,
  })), null);
});

test("invalid resource counters and limits cannot advertise usable capacity", () => {
  const invalid = [
    { osCpus: 0 },
    { osCpus: NaN },
    { osAvailableMemoryBytes: -1 },
    { osAvailableMemoryBytes: Infinity },
    { cpuMax: "150000 0" },
    { cpuMax: "0 100000" },
    { cpuMax: "150000junk 100000" },
    { cpusetCpus: "3-1" },
    { cpusetCpus: "0,nope" },
    { cpusetCpus: "" },
    { memoryMax: "not-a-limit" },
    { memoryMax: "25769803776bytes" },
    { memoryCurrent: "-1" },
    { memoryCurrent: "NaN" },
  ];
  for (const fields of invalid) {
    assert.equal(parseEffectiveResources(resources(fields)), null, JSON.stringify(fields));
  }
});

test("proc aggregate counters exclude guest double-counting and keep steal separate", () => {
  assert.deepEqual(parseProcStat(before), firstCounters);
  assert.deepEqual(parseProcStat(after), secondCounters);
});

test("missing, truncated, negative or malformed aggregate CPU counters are rejected", () => {
  for (const text of [
    "",
    "cpu0 100 20 30 400 10 5 5 10\n",
    "cpu 100 20 30\n",
    "cpu 100 20 30 400 10 5 5\n",
    "cpu 100 20 30 400 10 5 5 -1\n",
    "cpu 100 20 30 400 10x 5 5 10\n",
    "cpu 100 20 30 400 NaN 5 5 10\n",
  ]) {
    assert.equal(parseProcStat(text), null, JSON.stringify(text));
  }
});

test("the first counter observation cannot produce interval utilization", () => {
  assert.equal(capacityFromInterval(null, firstCounters, effective, 0.75, 2), null);
});

test("utilization uses interval deltas, excludes steal from busy, and preserves load and sessions", () => {
  assert.deepEqual(capacityFromInterval(
    parseProcStat(before), parseProcStat(after), effective, 0.75, 2,
  ), {
    effectiveCpus: 1.5,
    load1: 0.75,
    busyFraction: 0.45,
    stealFraction: 0.1,
    availableMemoryBytes: 16 * GiB,
    activeSessions: 2,
  });
});

test("a following interval is measured against its own previous counters", () => {
  const third = parseProcStat("cpu 120 25 40 520 15 10 10 40 25 7\n");
  assert.deepEqual(capacityFromInterval(secondCounters, third, effective, 0, 0), {
    effectiveCpus: 1.5,
    load1: 0,
    busyFraction: 0,
    stealFraction: 0.2,
    availableMemoryBytes: 16 * GiB,
    activeSessions: 0,
  });
});

test("unchanged counters and any reset counter cannot yield a trustworthy interval", () => {
  assert.equal(capacityFromInterval(firstCounters, firstCounters, effective, 0, 0), null);
  for (const field of ["busy", "idle", "steal"]) {
    const reset = { ...secondCounters, [field]: firstCounters[field] - 1 };
    assert.equal(capacityFromInterval(firstCounters, reset, effective, 0, 0), null, field);
  }
});

test("invalid load or active session counts cannot leak into a capacity report", () => {
  for (const [load1, activeSessions] of [[NaN, 0], [Infinity, 0], [-1, 0], [0, -1], [0, NaN]]) {
    assert.equal(capacityFromInterval(firstCounters, secondCounters, effective, load1, activeSessions), null);
  }
});

test("the process cgroup resolves from its leaf through every visible ancestor", () => {
  assert.deepEqual(resolveCgroupDirectories(
    "0::/system.slice/omp.service\n",
    "31 22 0:28 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n",
  ), ["/sys/fs/cgroup/system.slice/omp.service", "/sys/fs/cgroup/system.slice", "/sys/fs/cgroup"]);
});

test("a delegated cgroup mount is mapped relative to its mount root", () => {
  assert.deepEqual(resolveCgroupDirectories(
    "0::/tenant/omp\n",
    "31 22 0:28 /tenant /sys/fs/cgroup\\040worker rw - cgroup2 cgroup rw\n",
  ), ["/sys/fs/cgroup worker/omp", "/sys/fs/cgroup worker"]);
});

test("an unmappable or unsafe process cgroup cannot fall back to filesystem root limits", () => {
  const mount = "31 22 0:28 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
  for (const cgroup of ["", "2:cpu:/tenant/omp\n", "0::/other/omp\n", "0::/tenant/../other\n"]) {
    assert.equal(resolveCgroupDirectories(cgroup, mount), null, JSON.stringify(cgroup));
  }
});

// Builtin replacements and the sampler's module-local baseline live only in each child.
function runSamplerFixture(steps) {
  const files = {
    "/proc/self/cgroup": "0::/system.slice/omp.service\n",
    "/proc/self/mountinfo": "31 22 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    "/proc/meminfo": "MemTotal:       134217728 kB\nMemAvailable:   67108864 kB\n",
    "/sys/fs/cgroup/system.slice/omp.service/cpu.max": "400000 100000\n",
    "/sys/fs/cgroup/system.slice/omp.service/cpuset.cpus.effective": "0-3\n",
    "/sys/fs/cgroup/system.slice/omp.service/memory.max": "25769803776\n",
    "/sys/fs/cgroup/system.slice/omp.service/memory.current": "8589934592\n",
    "/sys/fs/cgroup/system.slice/cpu.max": "150000 100000\n",
    "/sys/fs/cgroup/system.slice/cpuset.cpus.effective": "0-7\n",
    "/sys/fs/cgroup/system.slice/memory.max": "21474836480\n",
    "/sys/fs/cgroup/system.slice/memory.current": "17179869184\n",
    "/sys/fs/cgroup/cpu.max": "max 100000\n",
    "/sys/fs/cgroup/cpuset.cpus.effective": "0-7\n",
    "/sys/fs/cgroup/memory.max": "max\n",
    "/sys/fs/cgroup/memory.current": "34359738368\n",
  };
  const script = `
    const fs = require("node:fs");
    const os = require("node:os");
    const { syncBuiltinESMExports } = require("node:module");
    const originalReadFileSync = fs.readFileSync;
    const files = ${JSON.stringify(files)};
    const steps = ${JSON.stringify(steps)};
    let step;
    Object.defineProperty(process, "platform", { value: "linux" });
    fs.readFileSync = (path, encoding) => {
      // Preserve module-loader reads; only proc/cgroup acquisition belongs to this fixture.
      if (typeof path !== "string" || (!path.startsWith("/proc/") && !path.startsWith("/sys/fs/cgroup/"))) {
        return originalReadFileSync(path, encoding);
      }
      if (encoding !== "utf8") throw new Error("Unexpected fixture encoding");
      if (path === step.failPath) {
        throw Object.assign(new Error("Fixture read failure"), { code: "EIO" });
      }
      if (!(path in files)) {
        throw Object.assign(new Error("Absent fixture file: " + path), { code: "ENOENT" });
      }
      return files[path];
    };
    os.availableParallelism = () => 8;
    os.loadavg = () => [step.load1 ?? 0.75, 0, 0];
    syncBuiltinESMExports();
    const { sampleHostCapacity } = await import(${JSON.stringify(new URL("./capacity.ts", import.meta.url).href)});
    const samples = [];
    for (step of steps) {
      Object.assign(files, step.files);
      files["/proc/stat"] = step.procStat;
      samples.push(sampleHostCapacity(step.activeSessions ?? 2));
    }
    console.log(JSON.stringify(samples));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
}

test("the sampler advances its baseline and clears it after an acquisition failure", () => {
  const third = "cpu 120 25 40 520 15 10 10 40 25 7\n";
  const recovered = "cpu 150 25 40 560 15 10 10 40 25 7\n";
  const next = "cpu 160 25 40 640 15 10 10 50 25 7\n";
  assert.deepEqual(runSamplerFixture([
    { procStat: before },
    { procStat: after },
    { procStat: third, load1: 0, activeSessions: 0 },
    { procStat: recovered, failPath: "/proc/meminfo" },
    { procStat: recovered },
    { procStat: next, load1: 1, activeSessions: 3 },
  ]), [
    null,
    {
      effectiveCpus: 1.5, load1: 0.75, busyFraction: 0.45, stealFraction: 0.1,
      availableMemoryBytes: 4 * GiB, activeSessions: 2,
    },
    {
      effectiveCpus: 1.5, load1: 0, busyFraction: 0, stealFraction: 0.2,
      availableMemoryBytes: 4 * GiB, activeSessions: 0,
    },
    null,
    null,
    {
      effectiveCpus: 1.5, load1: 1, busyFraction: 0.1, stealFraction: 0.1,
      availableMemoryBytes: 4 * GiB, activeSessions: 3,
    },
  ]);
});

test("the sampler combines leaf and ancestor limits using each ancestor's own memory usage", () => {
  assert.deepEqual(runSamplerFixture([
    { procStat: before },
    { procStat: after },
    {
      procStat: "cpu 140 30 50 480 20 15 15 30 30 9\n",
      files: { "/sys/fs/cgroup/system.slice/omp.service/memory.current": "24696061952\n" },
    },
    {
      procStat: "cpu 160 35 60 520 25 20 20 40 35 11\n",
      files: {
        "/sys/fs/cgroup/cpu.max": "75000 100000\n",
        "/sys/fs/cgroup/memory.max": "68719476736\n",
        "/sys/fs/cgroup/memory.current": "68182605824\n",
      },
    },
  ]), [
    null,
    {
      effectiveCpus: 1.5, load1: 0.75, busyFraction: 0.45, stealFraction: 0.1,
      availableMemoryBytes: 4 * GiB, activeSessions: 2,
    },
    {
      effectiveCpus: 1.5, load1: 0.75, busyFraction: 0.45, stealFraction: 0.1,
      availableMemoryBytes: GiB, activeSessions: 2,
    },
    {
      effectiveCpus: 0.75, load1: 0.75, busyFraction: 0.45, stealFraction: 0.1,
      availableMemoryBytes: 0.5 * GiB, activeSessions: 2,
    },
  ]);
});

test("Windows samples OS CPU times and available memory without /proc, cgroups or a load average", () => {
  // Kernel time `sys` includes `irq` on Windows and both rise between samples: `sys` must count, `irq` must not count again.
  const cpu = (busy, idle, irq) => ({ times: { user: busy - irq - 2, nice: 0, sys: irq + 2, irq, idle } });
  const steps = [
    { cpus: [cpu(100, 900, 4), cpu(100, 900, 4)], free: 8 * GiB },
    { cpus: [cpu(160, 940, 40), cpu(140, 960, 40)], free: 6 * GiB, activeSessions: 1 },
    { cpus: [], free: 6 * GiB },
    { cpus: [cpu(200, 1000, 40), cpu(200, 1000, 40)], free: 5 * GiB },
    { cpus: [cpu(230, 1070, 60), cpu(230, 1070, 60)], free: 5 * GiB, activeSessions: 4 },
  ];
  const script = `
    const os = require("node:os");
    const fs = require("node:fs");
    const { syncBuiltinESMExports } = require("node:module");
    const steps = ${JSON.stringify(steps)};
    let step;
    Object.defineProperty(process, "platform", { value: "win32" });
    const readFileSync = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      if (typeof path === "string" && (path.startsWith("/proc/") || path.startsWith("/sys/"))) throw new Error("Windows must not read " + path);
      return readFileSync(path, ...args);
    };
    os.cpus = () => step.cpus;
    os.freemem = () => step.free;
    os.availableParallelism = () => 2;
    os.loadavg = () => { throw new Error("Windows has no load average"); };
    syncBuiltinESMExports();
    const { sampleHostCapacity } = await import(${JSON.stringify(new URL("./capacity.ts", import.meta.url).href)});
    const samples = [];
    for (step of steps) samples.push(sampleHostCapacity(step.activeSessions ?? 0));
    console.log(JSON.stringify(samples));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), [
    null,
    { effectiveCpus: 2, load1: 0, busyFraction: 0.5, stealFraction: 0, availableMemoryBytes: 6 * GiB, activeSessions: 1 },
    null,
    null,
    { effectiveCpus: 2, load1: 0, busyFraction: 0.3, stealFraction: 0, availableMemoryBytes: 5 * GiB, activeSessions: 4 },
  ]);
});
