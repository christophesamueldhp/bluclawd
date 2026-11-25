#!/usr/bin/env bash
# Reproduces a test that fails only under parallel load. It runs `vitest run` WIDTH-wide (default 16),
# ROUNDS times (default 3), and counts the failed runs. Arguments go to vitest, for example
#   scripts/stress-test.sh test/sandbox-reaper.test.ts -t "left behind"
# LOAD=test/subagents-writer-backend.test.ts runs a second stress of that file alongside and
# reports its count too.
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
for marker in "${failed[@]}"; do
	grep -E "^ FAIL " "${marker%.failed}.log" | sort -u
done | sort | uniq -c
for marker in "${failed[@]}"; do
	grep -m1 -E "Error" "${marker%.failed}.log"
done | sort | uniq -c
echo "${#failed[@]}/$((width * rounds)) runs failed; logs in $logs"
[ ${#failed[@]} -eq 0 ] && [ $load_failed -eq 0 ]
