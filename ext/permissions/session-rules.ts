/**
 * The rules the parent session layers over its settings files — `--disallowedTools`,
 * `--allowedTools`, the ask-all posture and "yes for this session" grants — published
 * by `permissions/index.ts` for the subagent gate and the commands the subagent layer
 * runs. They live nowhere on disk, so a child that re-read settings alone would escape
 * a `--disallowedTools` deny just by being delegated the work.
 *
 * A {@link sharedRef}: the subagents extension is its own `pi.extensions` entry and gets
 * a separate copy of this module (see active-mode.ts).
 */

import { sharedRef } from "../_shared/global-state.ts";
import type { Rules } from "./rules.ts";

export interface SessionRuleLayer {
	/** Merged into the settings rules, list by list. */
	rules?: Rules;
	/** `--allowedTools`: explicit grants, kept apart as the parent keeps them. */
	cliAllow?: Rules;
}

const ref = sharedRef<SessionRuleLayer>("permissions.sessionRules", {});

export function setSessionRuleLayer(layer: SessionRuleLayer): void {
	ref.set(layer);
}

export function getSessionRuleLayer(): SessionRuleLayer {
	return ref.get();
}

/** Settings rules with the session layer on top — what the parent evaluates against. */
export function withSessionRules(base: Rules): Rules {
	const session = ref.get().rules ?? {};
	return {
		...base,
		allow: [...(base.allow ?? []), ...(session.allow ?? [])],
		ask: [...(base.ask ?? []), ...(session.ask ?? [])],
		deny: [...(base.deny ?? []), ...(session.deny ?? [])],
	};
}
