import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("keeps every test file's agent directory out of the user's own", () => {
	expect(realpathSync(getAgentDir()).startsWith(realpathSync(tmpdir()))).toBe(true);
});
