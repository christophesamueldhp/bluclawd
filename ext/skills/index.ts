/**
 * bluclawd's bundled skills.
 *
 * Contributed through `resources_discover`, the same mechanism the branding
 * extension uses for themes — pi aggregates the paths every handler returns, so
 * this being a second handler for that event is fine.
 *
 * The skills themselves are plain SKILL.md files under `bluclawd/skills/`. They
 * are shipped rather than left to the user's own skills directory so a fresh
 * checkout has them, and they are ordinary resources: pi decides whether to
 * register them as `/skill:name` commands via its own `enableSkillCommands`
 * setting.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

const skills: InlineExtension = {
	name: "skills",
	factory: (pi) => {
		pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }));
	},
};

export default skills.factory;
