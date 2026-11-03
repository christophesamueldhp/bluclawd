import { DynamicBorder, type ExtensionCommandContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const LIST_KEYS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.confirm",
	"tui.select.cancel",
] as const;

/** A searchable list in place of the editor, like pi's /model picker, starting on `current`. */
export function pick(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	current: string | undefined,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const search = new Input();
		let list = new SelectList([], 1, getSelectListTheme());
		const build = (selected?: string) => {
			const shown = fuzzyFilter(items, search.getValue(), (item) => `${item.label} ${item.value}`);
			list = new SelectList(shown, Math.max(1, Math.min(shown.length, 10)), getSelectListTheme());
			list.setSelectedIndex(
				Math.max(
					0,
					shown.findIndex((item) => item.value === selected),
				),
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
		};
		build(current);
		const border = new DynamicBorder((text) => theme.fg("accent", text));
		const header = new Text(theme.fg("accent", theme.bold(title)));
		const hint = new Text(theme.fg("dim", "type to search • ↑↓ navigate • enter select • esc cancel"));
		return {
			render: (width) => [border, header, search, list, hint, border].flatMap((part) => part.render(width)),
			invalidate: () => {},
			handleInput: (data) => {
				const keys = getKeybindings();
				if (LIST_KEYS.some((key) => keys.matches(data, key))) list.handleInput(data);
				else {
					search.handleInput(data);
					build();
				}
				tui.requestRender();
			},
		};
	});
}
