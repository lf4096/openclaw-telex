import { messageInteractionMarkup } from "./interactive.js";
import {
	type TelexBlock,
	TelexBlockType,
	TelexChannelPermission,
	type TelexChannelPermissionName,
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
	labelMap,
} from "./types.js";

const conversationKindLabel = labelMap(TelexConversationKind);
const memberRoleLabel = labelMap(TelexMemberRole);
const identityKindLabel = labelMap(TelexIdentityKind);
const identityStatusLabel = labelMap(TelexIdentityStatus);
const messageStatusLabel = labelMap(TelexMessageStatus);
const toolStatusLabel = labelMap(TelexToolStatus);
const blockTypeLabel = labelMap(TelexBlockType);

function messageFlagLabels(flags: number): string[] {
	const out: string[] = [];
	for (const [name, bit] of Object.entries(TelexMessageFlag)) {
		if (bit !== 0 && (flags & bit) === bit) out.push(name.toLowerCase());
	}
	return out;
}

// Leave the label empty so the server can fill in the display name.
export function describeIdentity(i: TelexIdentityBrief) {
	return {
		...i,
		kind: identityKindLabel[i.kind] ?? i.kind,
		status: identityStatusLabel[i.status] ?? i.status,
		mention: `[@](mention:${i.id})`,
	};
}

type TelexChannelPermissionMap = Record<TelexChannelPermissionName, boolean>;

function memberPermissions(flags: number): TelexChannelPermissionMap {
	const out = {} as TelexChannelPermissionMap;
	for (const [name, bit] of Object.entries(TelexChannelPermission)) {
		out[name as TelexChannelPermissionName] = (flags & bit) === 0;
	}
	return out;
}

export function describeConversationBrief(c: TelexConversation) {
	return {
		id: c.id,
		kind: conversationKindLabel[c.kind] ?? c.kind,
		title: c.title,
		is_default: c.is_default,
		...(c.peer_id ? { peer_id: c.peer_id } : {}),
		member_count: c.member_count,
		last_seq: c.last_seq,
	};
}

export function describeConversation(c: TelexConversation) {
	const role = c.membership?.role;
	return {
		...describeConversationBrief(c),
		...(c.kind === TelexConversationKind.CHANNEL
			? {
					announcement: c.data?.announcement ?? "",
					member_permissions: memberPermissions(c.flags),
					...(role !== undefined ? { my_role: memberRoleLabel[role] ?? role } : {}),
				}
			: {}),
	};
}

export function describeMember(m: TelexMember, identities?: Map<string, TelexIdentityBrief>) {
	const identity = identities?.get(m.identity_id);
	return {
		identity_id: m.identity_id,
		role: memberRoleLabel[m.role] ?? m.role,
		...(identity ? { identity: describeIdentity(identity) } : {}),
	};
}

function describeBlock(m: TelexMessage, b: TelexBlock, selfId: string | null, direct: boolean) {
	const { interaction, ...rest } = b;
	return {
		...rest,
		type: blockTypeLabel[b.type] ?? b.type,
		...(b.tool
			? { tool: { ...b.tool, status: toolStatusLabel[b.tool.status] ?? b.tool.status } }
			: {}),
		...(interaction ? { text: messageInteractionMarkup(m, interaction, selfId, direct) } : {}),
	};
}

export function describeMessage(m: TelexMessage, selfId: string | null, direct: boolean) {
	return {
		...m,
		status: messageStatusLabel[m.status] ?? m.status,
		flags: messageFlagLabels(m.flags),
		data: {
			...m.data,
			blocks: (m.data?.blocks ?? []).map((b) => describeBlock(m, b, selfId, direct)),
		},
	};
}
