import { Container, Spacer, Text } from "@earendil-works/pi-tui";

export function commandBlock(lines: string[]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(lines.join("\n"), 1, 0));
	return container;
}
