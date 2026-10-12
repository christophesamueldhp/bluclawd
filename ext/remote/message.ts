// ext/remote/message.ts
/** What `/remote-control` shows once the phone can reach the daemon. */
export function pairingText(url: string, code: string, expiresAt: number, now: number = Date.now()): string {
	const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
	return [
		"Remote control is on",
		`1. On your phone, open ${url}`,
		"2. Share → Add to Home Screen, then open it from the Home Screen",
		`3. Enter the code ${code.slice(0, 3)} ${code.slice(3)} (expires in ${minutes} min)`,
		"/remote-control pair: a new code · /remote-control devices: paired devices · /remote-control: turn off",
	].join("\n");
}
