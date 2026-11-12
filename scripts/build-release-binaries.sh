#!/bin/sh
# The five binaries every release and prerelease ships (after `npm run build`), into release/:
# release/ompweb-<os>-<arch>.tar.gz, .zip for Windows, each with the matching omp runner
# (runner/release/ompweb-omp-<os>-<arch>) as ompweb-omp beside ompweb. Bun cross-compiles all of them from one machine.
# The x64 targets name -baseline (no AVX2 needed): in Bun 1.4.4 that is the default x64 runtime too (the
# same bytes), and naming it keeps a later Bun from shipping a -modern one. They keep the plain
# ompweb-<os>-x64 names.
set -eu
# Every platform's native addon package, which the runner embeds per target.
(cd runner && npx bun install --frozen-lockfile --os='*' --cpu='*' && npx bun scripts/build-binary.ts linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64)
for target in bun-linux-x64-baseline bun-linux-arm64 bun-darwin-x64-baseline bun-darwin-arm64 bun-windows-x64-baseline; do
	npx bun scripts/build-binary.ts --target "$target"
done
