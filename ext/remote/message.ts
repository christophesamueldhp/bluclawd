import { styleTextWithAnsi } from "@earendil-works/pi-tui";
import { qrMatrix, renderQr } from "./qr.ts";

/** What `/remote-control` shows once the phone can reach the daemon: a QR code of the link that
 *  pairs it, and dimmed under it the code that also does, for a phone that cannot scan. */
export function pairingText(
	url: string,
	secret: string,
	code: string,
	expiresAt: number,
	now: number = Date.now(),
): string {
	const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
	return [
		`Remote control is on: ${url}`,
		`Scan with your phone's camera to pair it (valid ${minutes} minute${minutes === 1 ? "" : "s"}, once):`,
		renderQr(qrMatrix(`${url}/#pair=${secret}`)),
		// The QR code's lines end undimmed.
		styleTextWithAnsi(`Can't scan? Type ${code.slice(0, 3)} ${code.slice(3)} in the app`, undefined, undefined, {
			dim: true,
		}),
	].join("\n");
}
