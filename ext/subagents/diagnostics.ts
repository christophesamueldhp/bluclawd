export function sanitizeDiagnosticText(input: string): string {
	return input
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[REDACTED_KEY]")
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',;)]+/gi, "$1=[REDACTED]");
}
