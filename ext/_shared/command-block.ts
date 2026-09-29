import { Container, Spacer, Text } from "@earendil-works/pi-tui";

/** A blank line, then the block indented by one column — pi's own command-output shape. */
export function commandBlock(lines: string[]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(lines.join("\n"), 1, 0));
	return container;
}
