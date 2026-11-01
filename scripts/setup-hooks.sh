#!/bin/sh
# Run once per clone: sh scripts/setup-hooks.sh
# Activates the tracked hooks in .githooks/ (git never applies a committed hooks
# path by itself) and registers graphify's union merge driver for graph.json.
set -eu

root=$(git rev-parse --show-toplevel)
command -v graphify >/dev/null || {
	echo "graphify is not on PATH: install it (see CONTRIBUTING.md), then run this again." >&2
	exit 1
}
# Pin the Python graphify runs on, as `graphify hook install` does, so merges also
# work where graphify is not on PATH (GUI clients). Fall back to the PATH command.
python=$(sed -n '1s/^#!//p' "$(command -v graphify)" 2>/dev/null || true)
case $python in
/*) "$python" -c 'import graphify' 2>/dev/null || python= ;;
*) python= ;;
esac
if [ -n "$python" ]; then
	driver="\"$python\" -m graphify merge-driver %O %A %B"
else
	echo "warning: could not find graphify's Python; the merge driver needs graphify on PATH." >&2
	driver="graphify merge-driver %O %A %B"
fi
git -C "$root" config merge.graphify.name "graphify graph.json union merge"
git -C "$root" config merge.graphify.driver "$driver"

git -C "$root" config core.hooksPath .githooks
echo "core.hooksPath = .githooks; graphify merge driver: $driver"
