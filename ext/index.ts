/**
 * Each `ext/<name>/index.ts` file is a bare `export default function(pi) {...}`,
 * the shape pi's package loader requires for a file listed in `package.json`'s
 * `pi.extensions` manifest (`loadExtensionModule` in pi's own
 * `core/extensions/loader.ts` rejects anything that isn't `typeof === "function"`).
 * That manifest, not this file, is what `pi install` loads.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import accounts from "./accounts/index.ts";
import agentView from "./agent-view/index.ts";
import backgroundBash from "./background-bash/index.ts";
import branding from "./branding/index.ts";
import checkpoints from "./checkpoints/index.ts";
import help from "./help/index.ts";
import memory from "./memory/index.ts";
import paste from "./paste/index.ts";
import permissions from "./permissions/index.ts";
import promptAssist from "./prompt-assist/index.ts";
import remote from "./remote/index.ts";
import sandbox from "./sandbox/index.ts";
import skills from "./skills/index.ts";
import subagents from "./subagents/index.ts";
import tmuxLaunch from "./tmux-launch/index.ts";
import transcript from "./transcript/index.ts";
import vibes from "./vibes/index.ts";
import web from "./web/index.ts";

export function bluclawdExtensions(): InlineExtension[] {
	return [
		{ name: "tmux-launch", factory: tmuxLaunch },
		{ name: "permissions", factory: permissions },
		{ name: "sandbox", factory: sandbox },
		{ name: "checkpoints", factory: checkpoints },
		{ name: "background-bash", factory: backgroundBash },
		{ name: "subagents", factory: subagents },
		{ name: "branding", factory: branding },
		{ name: "transcript", factory: transcript },
		{ name: "agent-view", factory: agentView },
		{ name: "remote", factory: remote },
		{ name: "help", factory: help },
		{ name: "vibes", factory: vibes },
		{ name: "paste", factory: paste },
		{ name: "skills", factory: skills },
		{ name: "prompt-assist", factory: promptAssist },
		{ name: "web", factory: web },
		{ name: "memory", factory: memory },
		{ name: "accounts", factory: accounts },
	];
}
