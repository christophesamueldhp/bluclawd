#!/usr/bin/env bash
# Runs the tests on Linux: `vitest run` in an Ubuntu 24.04 container, with the distribution's tmux and the
# host's Node, as an unprivileged user given none of the host's environment. Arguments go to vitest, with
# paths from the repo root, e.g.
#   scripts/linux-check.sh test/subagent-pane-runs.test.ts -t "works in a pane"
# The tree tested is the git index: unstaged changes are left out, so `git add` what the run should see.
# Exits with vitest's status. A tmux send-keys that hangs (#397) blocks vitest past any test timeout,
# so a watchdog ends the run once one is older than 60 s. The container goes when the script ends.
# The image, with node_modules installed, is reused while package.json, the lockfile, vendor/, the Node
# and tmux versions and the recipe below are unchanged; old ones stay behind as bluclawd-linux-check:<key>.
# NODE_VERSION=v26.8.1 picks another Node than the host's.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node_version=${NODE_VERSION:-$(node -v)}
tmux_version=3.4
dockerfile='
FROM ubuntu:24.04
ARG NODE_VERSION
ARG TMUX_VERSION
RUN apt-get update -qq && \
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux git ca-certificates curl xz-utils procps ripgrep bubblewrap socat libatomic1 && \
	rm -rf /var/lib/apt/lists/* && \
	test "$(tmux -V)" = "tmux $TMUX_VERSION"
RUN arch=$(dpkg --print-architecture | sed s/amd64/x64/) && mkdir /opt/node && \
	curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$arch.tar.xz" | tar -xJ -C /opt/node --strip-components=1
ENV PATH=/opt/node/bin:$PATH
RUN useradd -m -u 1001 dev && mkdir -p /work/bluclawd && chown dev:dev /work/bluclawd
USER dev
WORKDIR /work/bluclawd
COPY --chown=dev:dev . .
RUN npm ci --no-audit --no-fund
'
watchdog='
while sleep 5; do
	if ps -u dev -o etimes=,args= | awk '\''$2 == "tmux" && / send-keys / && $1 > 60 { hung = 1 } END { exit !hung }'\''; then
		echo "linux-check: a tmux send-keys hung for over 60 s; ending the run" >&2
		pkill -KILL -u dev
	fi
done
'

tree=$(git write-tree)
key=$(printf '%s\n' "$dockerfile" "$node_version" "$tmux_version" \
	"$(git rev-parse "$tree:package.json" "$tree:package-lock.json" "$tree:vendor")" | git hash-object --stdin)
image=bluclawd-linux-check:${key:0:12}
name=bluclawd-linux-check-$$
context=$(mktemp -d)
cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	rm -rf "$context"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if ! docker image inspect "$image" >/dev/null 2>&1; then
	echo "linux-check: building $image (Node $node_version, tmux $tmux_version)"
	git archive "$tree" package.json package-lock.json vendor | tar -x -C "$context"
	docker build -t "$image" --build-arg NODE_VERSION="$node_version" --build-arg TMUX_VERSION="$tmux_version" \
		-f - "$context" <<<"$dockerfile"
fi

# --init puts an init as PID 1, so orphans are reaped as on a real system, not left as zombies that read as alive.
# The container's own process is root's, so the watchdog's kill of every dev process leaves it.
# The sandbox tests' bubblewrap needs new namespaces and a /proc mount, which Docker's default seccomp, AppArmor
# and masked paths deny; lifting those three is enough, without --privileged's capabilities and devices.
docker run -d --rm --init --user root --name "$name" \
	--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
	"$image" sleep 86400 >/dev/null
git archive "$tree" | docker exec -i --user dev "$name" tar -x -C /work/bluclawd
docker exec --user root "$name" bash -c "$watchdog" &
# In the background, so a signal to this script runs its traps at once rather than after vitest ends.
docker exec --user dev --env LANG=C.UTF-8 "$name" npx vitest run "$@" &
status=0
wait $! || status=$?
exit $status
