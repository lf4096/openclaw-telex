export function checkGroupAccess(params: {
	groupPolicy: string;
	groupAllowFrom?: string[];
	groupSenderAllowFrom?: string[];
	conversationId: string;
	senderId: string;
	senderEmail?: string;
}): { allowed: boolean; reason?: string } {
	const {
		groupPolicy,
		groupAllowFrom,
		groupSenderAllowFrom,
		conversationId,
		senderId,
		senderEmail,
	} = params;

	if (groupPolicy === "disabled") {
		return { allowed: false, reason: "groupPolicy is disabled" };
	}

	if (groupPolicy === "allowlist") {
		const list = groupAllowFrom ?? [];
		if (!list.includes(conversationId)) {
			return { allowed: false, reason: `channel ${conversationId} not in groupAllowFrom` };
		}
	}

	if (groupSenderAllowFrom && groupSenderAllowFrom.length > 0) {
		if (!isTelexSenderAllowed(senderId, senderEmail, groupSenderAllowFrom)) {
			return {
				allowed: false,
				reason: `sender ${senderId} not in groupSenderAllowFrom`,
			};
		}
	}

	return { allowed: true };
}

// Shared allowlist rule: trim; "*" allows all; exact id match; case-insensitive
// email match. Reused by the DM path in bot.ts.
export function isTelexSenderAllowed(
	senderId: string,
	email: string | undefined,
	allowFrom: string[],
): boolean {
	return allowFrom.some((entry) => {
		const e = entry.trim();
		if (e === "*") return true;
		if (e === senderId) return true;
		if (email && e.toLowerCase() === email.toLowerCase()) return true;
		return false;
	});
}
