import {
	type TelexBlock,
	TelexBlockType,
	type TelexConversation,
	TelexConversationKind,
	type TelexIdentityBrief,
	TelexIdentityKind,
	TelexIdentityStatus,
	type TelexMember,
	TelexMemberRole,
	type TelexMessage,
	TelexMessageFlag,
	TelexMessageStatus,
	TelexToolStatus,
} from "./types.js";

// The wire protocol encodes these fields as integer enums; the agent reads the
// tool output as JSON, so surface the enum name (lowercased) instead of a bare int.
function labelMap(e: Record<string, number>): Record<number, string> {
	const out: Record<number, string> = {};
	for (const [name, value] of Object.entries(e)) out[value] = name.toLowerCase();
	return out;
}

const conversationKindLabel = labelMap(TelexConversationKind);
const memberRoleLabel = labelMap(TelexMemberRole);
const identityKindLabel = labelMap(TelexIdentityKind);
const identityStatusLabel = labelMap(TelexIdentityStatus);
const messageStatusLabel = labelMap(TelexMessageStatus);
const toolStatusLabel = labelMap(TelexToolStatus);
const blockTypeLabel = labelMap(TelexBlockType);

// Message flags are a bitmask, so expand the set bits into a list of labels.
function messageFlagLabels(flags: number): string[] {
	const out: string[] = [];
	for (const [name, bit] of Object.entries(TelexMessageFlag)) {
		if (bit !== 0 && (flags & bit) === bit) out.push(name.toLowerCase());
	}
	return out;
}

export function describeIdentity(i: TelexIdentityBrief) {
	return {
		...i,
		kind: identityKindLabel[i.kind] ?? i.kind,
		status: identityStatusLabel[i.status] ?? i.status,
	};
}

export function describeConversation(c: TelexConversation) {
	return { ...c, kind: conversationKindLabel[c.kind] ?? c.kind };
}

export function describeMember(m: TelexMember, identities?: Map<string, TelexIdentityBrief>) {
	const identity = identities?.get(m.identity_id);
	return {
		identity_id: m.identity_id,
		role: memberRoleLabel[m.role] ?? m.role,
		...(identity ? { identity: describeIdentity(identity) } : {}),
	};
}

function describeBlock(b: TelexBlock) {
	return {
		...b,
		type: blockTypeLabel[b.type] ?? b.type,
		...(b.tool
			? { tool: { ...b.tool, status: toolStatusLabel[b.tool.status] ?? b.tool.status } }
			: {}),
	};
}

export function describeMessage(m: TelexMessage) {
	return {
		...m,
		status: messageStatusLabel[m.status] ?? m.status,
		flags: messageFlagLabels(m.flags),
		data: { ...m.data, blocks: (m.data?.blocks ?? []).map(describeBlock) },
	};
}
