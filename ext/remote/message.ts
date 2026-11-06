import { qrMatrix, renderQr } from "./qr.ts";

/** What `/remote-control` shows once the phone can reach the daemon: a QR code of the link that
 *  opens the app (pairing it, but not in Safari on iOS), and under it the code, which pairs the
 *  iPhone's Home Screen app or a phone that cannot scan. */
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
		`Scan with your phone's camera to open the app (valid ${minutes} minute${minutes === 1 ? "" : "s"}, once):`,
		renderQr(qrMatrix(`${url}/#pair=${secret}`)),
		`On iPhone, or if you can't scan: type ${code.slice(0, 3)} ${code.slice(3)} in the app`,
	].join("\n");
}
