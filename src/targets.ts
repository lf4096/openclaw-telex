// Telex entity ids are 16-char lowercase hex (uniqueid.ID.String form). A target
// is a conversation id; identity ids share the same shape.
const HEX_ID = /^[0-9a-f]{16}$/i;

export function normalizeTelexTarget(raw: string): string | null {
	const trimmed = raw.trim();
	return trimmed ? trimmed : null;
}

export function looksLikeTelexId(raw: string): boolean {
	return HEX_ID.test(raw.trim());
}
