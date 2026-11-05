import type { AuthEvent, AuthPrompt, AuthType, Credential, Provider } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionCommandContext,
	getSelectListTheme,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Input, SelectList, Text } from "@earendil-works/pi-tui";

/** Provider-owned login, isolated from the live credential until it succeeds. */
export function loginAccount(
	ctx: ExtensionCommandContext,
	provider: Provider,
	type: AuthType,
	agentDir: string,
): Promise<Credential | undefined> {
	return ctx.ui.custom<Credential | undefined>((tui, theme, _keys, done) => {
		const controller = new AbortController();
		const content = new Container();
		const frame = new Container();
		const border = new DynamicBorder((text) => theme.fg("accent", text));
		frame.addChild(border);
		frame.addChild(new Text(theme.fg("accent", `Sign in to ${provider.name}`)));
		frame.addChild(content);
		frame.addChild(new Text(theme.fg("dim", "Esc cancels • use the browser account you want to add")));
		frame.addChild(border);
		let input: Input | SelectList | undefined;
		let cancelPrompt: (() => void) | undefined;

		const notify = (event: AuthEvent) => {
			if (controller.signal.aborted) return;
			if (event.type === "auth_url") {
				content.addChild(new Text(`Open this URL in your browser:\n${event.url}\n${event.instructions ?? ""}`));
			} else if (event.type === "device_code") {
				content.addChild(new Text(`Open ${event.verificationUri}\nEnter code: ${event.userCode}`));
			} else {
				content.addChild(new Text(event.message));
				if (event.type === "info") {
					for (const link of event.links ?? []) content.addChild(new Text(`${link.label ?? "Open"}: ${link.url}`));
				}
			}
			tui.requestRender();
		};

		const prompt = (request: AuthPrompt): Promise<string> =>
			new Promise((resolve, reject) => {
				controller.signal.throwIfAborted();
				request.signal?.throwIfAborted();
				const finish = (value?: string) => {
					request.signal?.removeEventListener("abort", cancel);
					cancelPrompt = undefined;
					input = undefined;
					content.removeChild(field);
					if (value === undefined) reject(new Error("Login cancelled"));
					else resolve(value);
					tui.requestRender();
				};
				const cancel = () => finish();
				cancelPrompt = cancel;
				content.addChild(new Text(request.message));
				let field: { render(width: number): string[]; invalidate(): void };
				if (request.type === "select") {
					const list = new SelectList(
						request.options.map((option) => ({
							value: option.id,
							label: option.label,
							description: option.description,
						})),
						Math.min(8, request.options.length),
						getSelectListTheme(),
					);
					list.onSelect = (item) => finish(item.value);
					input = list;
					field = list;
				} else {
					const entry = new Input({ placeholder: request.placeholder });
					entry.onSubmit = (value) => finish(value);
					input = entry;
					// Never render entered credentials, including authorization codes, into terminal history.
					field = {
						render: (width) => new Text(`› ${"•".repeat(Math.min(entry.getValue().length, 60))}`).render(width),
						invalidate: () => {},
					};
				}
				content.addChild(field);
				request.signal?.addEventListener("abort", cancel, { once: true });
				tui.requestRender();
			});

		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) throw new Error("This provider has no interactive login for that method.");
		void method
			.login(
				{ signal: controller.signal, prompt, notify },
				{ getDeviceId: () => SettingsManager.create(ctx.cwd, agentDir).getOrCreateDeviceId() },
			)
			.then((credential) => {
				if (!controller.signal.aborted) done(credential);
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					ctx.ui.notify("Sign-in failed. Your existing accounts were not changed. Try again to sign in.", "error");
					done(undefined);
				}
			});

		return {
			render: (width) => frame.render(width),
			invalidate: () => frame.invalidate(),
			handleInput: (data) => {
				if (getKeybindings().matches(data, "tui.select.cancel")) {
					controller.abort();
					cancelPrompt?.();
					done(undefined);
				} else input?.handleInput(data);
				tui.requestRender();
			},
			dispose: () => {
				controller.abort();
				cancelPrompt?.();
			},
		};
	});
}
