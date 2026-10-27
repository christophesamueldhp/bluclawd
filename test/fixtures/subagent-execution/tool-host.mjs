let requestText = "";
for await (const chunk of process.stdin) {
	requestText += chunk;
	if (requestText.length > 32 * 1024) throw new Error("Probe input limit");
}
const request = JSON.parse(requestText);
const sdk = await import(request.sdkUrl);
const tools = {
	read: sdk.createReadTool(request.cwd),
	grep: sdk.createGrepTool(request.cwd),
	find: sdk.createFindTool(request.cwd),
	ls: sdk.createLsTool(request.cwd),
	edit: sdk.createEditTool(request.cwd),
	write: sdk.createWriteTool(request.cwd),
	bash: sdk.createBashTool(request.cwd, { shellPath: "/bin/bash", exposeSessionEnvironment: false }),
};
const results = [];
for (const operation of request.operations) {
	try {
		const tool = tools[operation.tool];
		if (!tool) throw new Error("Unknown probe tool");
		const result = await tool.execute("native-boundary-probe", operation.input, new AbortController().signal);
		const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
		results.push({ ok: result.isError !== true, text: text.slice(0, 32 * 1024) });
	} catch {
		results.push({ ok: false, text: "Tool request failed" });
	}
}
process.stdout.write(JSON.stringify({ results }));
