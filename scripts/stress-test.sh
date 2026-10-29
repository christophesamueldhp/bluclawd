#!/usr/bin/env bash
# Reproduces a test that fails only under parallel load: runs `vitest run` WIDTH-wide (default 16),
# ROUNDS times (default 3), and counts the failed runs. Arguments go to vitest, e.g.
#   scripts/stress-test.sh test/sandbox-reaper.test.ts -t "left behind"
# Concurrent vitest processes redden timing races that CPU load alone does not (#45).
# Still green? Run a second `scripts/stress-test.sh test/subagents-writer-backend.test.ts` concurrently:
# sandbox startup is the heaviest load (#76). READINESS_MS=120000 widens every fixture readiness wait:
# green then means the failure is slow startup, not a hang.
shopt -s nullglob
width=${WIDTH:-16}
rounds=${ROUNDS:-3}
logs=$(mktemp -d)
for round in $(seq "$rounds"); do
	for slot in $(seq "$width"); do
		# Default reporters keep the load a real run puts on the machine; the json goes beside the log.
		npx vitest run --outputFile.json="$logs/$round-$slot.json" "$@" >"$logs/$round-$slot.log" 2>&1 || touch "$logs/$round-$slot.failed" &
	done
	wait
done
failed=("$logs"/*.failed)
echo "${#failed[@]}/$((width * rounds)) runs failed; logs in $logs"
for marker in "${failed[@]}"; do
	grep -m1 -E "Error" "${marker%.failed}.log"
done | sort | uniq -c
[ ${#failed[@]} -eq 0 ]
