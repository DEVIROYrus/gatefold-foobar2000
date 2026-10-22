#!/usr/bin/env bash
# Everything CI checks in the theme, on this machine: the static checks, then every end-to-end test,
# split into parts that run side by side (JOBS=n, default: the number of CPU cores). Logs: .e2e-logs/
set -uo pipefail
cd "$(dirname "$0")/.."
node tools/check.mjs || exit 1
N=${JOBS:-$(nproc)}
rm -rf .e2e-logs && mkdir -p .e2e-logs
pids=()
for i in $(seq 1 "$N"); do SHARD="$i/$N" PYTHONUNBUFFERED=1 python3 tests/e2e.py > ".e2e-logs/part-$i.log" 2>&1 & pids+=($!); done
rc=0
for p in "${pids[@]}"; do wait "$p" || rc=1; done
grep -h "FAIL\|Traceback\|still running" .e2e-logs/*.log
for f in .e2e-logs/*.log; do echo "$(basename "$f" .log): $(tail -n1 "$f")"; done
exit $rc
