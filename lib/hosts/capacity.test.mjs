import assert from "node:assert/strict";
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
