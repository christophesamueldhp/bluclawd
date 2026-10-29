#!/usr/bin/env bash
# Reproduces a test that fails only under parallel load: runs `vitest run` WIDTH-wide (default 16),
# ROUNDS times (default 3), and counts the failed runs. Arguments go to vitest, e.g.
#   scripts/stress-test.sh test/sandbox-reaper.test.ts -t "left behind"
# Concurrent vitest processes redden timing races that CPU load alone does not (#45).
# Still green? LOAD=test/subagents-writer-backend.test.ts runs a second stress of that file alongside and
# reports its count too: sandbox startup is the heaviest load (#76). READINESS_MS=120000 widens every fixture
# readiness wait: green then means the failure is slow startup, not a hang. If the load run is itself red on
# readiness, the machine is saturated and neither result means anything: lower WIDTH until the load run is green.
shopt -s nullglob
width=${WIDTH:-16}
rounds=${ROUNDS:-3}
logs=$(mktemp -d)
if [ -n "${LOAD:-}" ]; then
	LOAD= "$0" "$LOAD" >"$logs/load.out" 2>&1 &
	load=$!
fi
for round in $(seq "$rounds"); do
	slots=()
	for slot in $(seq "$width"); do
		# Default reporters keep the load a real run puts on the machine; the json goes beside the log.
		npx vitest run --outputFile.json="$logs/$round-$slot.json" "$@" >"$logs/$round-$slot.log" 2>&1 || touch "$logs/$round-$slot.failed" &
		slots+=($!)
	done
	wait "${slots[@]}"
done
failed=("$logs"/*.failed)
load_failed=0
if [ -n "${load:-}" ]; then
	wait "$load" || load_failed=1
	echo "load ($LOAD): $(tail -1 "$logs/load.out")"
fi
# Grouped by failing test, then by first error; the count goes last, so a `tail` keeps it.
for marker in "${failed[@]}"; do
	grep -E "^ FAIL " "${marker%.failed}.log" | sort -u
done | sort | uniq -c
for marker in "${failed[@]}"; do
	grep -m1 -E "Error" "${marker%.failed}.log"
done | sort | uniq -c
echo "${#failed[@]}/$((width * rounds)) runs failed; logs in $logs"
[ ${#failed[@]} -eq 0 ] && [ $load_failed -eq 0 ]
