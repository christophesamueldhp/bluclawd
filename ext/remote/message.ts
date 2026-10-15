import { qrMatrix, renderQr } from "./qr.ts";

/** What `/remote-control` shows once the phone can reach the daemon: a QR code of the link that
 *  pairs it, and the code for the Home Screen app, which may not share Safari's pairing. */
export function pairingText(url: string, code: string, expiresAt: number, now: number = Date.now()): string {
	const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
	return [
		`Remote control is on: ${url}`,
		"Scan with your phone's camera to pair it:",
		renderQr(qrMatrix(`${url}/#pair=${code}`)),
		`Code for the Home Screen app: ${code.slice(0, 3)} ${code.slice(3)} (valid ${minutes} minute${minutes === 1 ? "" : "s"}, once)`,
	].join("\n");
}
