import { messageInteractionMarkup } from "./interactive.js";
import {
	TelexAgentKind,
	type TelexBlock,
	TelexBlockType,
	TelexChannelPermission,
	type TelexChannelPermissionName,
	type TelexConversation,
	TelexConversationKind,
	type TelexIdentityBrief,
	TelexIdentityFlag,
	TelexIdentityKind,
	TelexIdentityStatus,
	type TelexMember,
	TelexMemberRole,
	type TelexMessage,
	TelexMessageFlag,
	TelexMessageStatus,
	TelexNoticeLevel,
	TelexToolStatus,
	labelMap,
} from "./types.js";

const conversationKindLabel = labelMap(TelexConversationKind);
const memberRoleLabel = labelMap(TelexMemberRole);
const identityKindLabel = labelMap(TelexIdentityKind);
const agentKindLabel = labelMap(TelexAgentKind);
const identityStatusLabel = labelMap(TelexIdentityStatus);
const messageStatusLabel = labelMap(TelexMessageStatus);
const toolStatusLabel = labelMap(TelexToolStatus);
const noticeLevelLabel = labelMap(TelexNoticeLevel);
const blockTypeLabel = labelMap(TelexBlockType);

function flagLabels(e: Record<string, number>, flags: number): string[] {
	const out: string[] = [];
	for (const [name, bit] of Object.entries(e)) {
		if (bit !== 0 && (flags & bit) === bit) out.push(name.toLowerCase());
	}
	return out;
}

// Leave the label empty so the server can fill in the display name.
export function describeIdentity(i: TelexIdentityBrief) {
	const { avatar: _avatar, agent_kind: _agentKind, ...rest } = i;
	return {
		...rest,
		kind: identityKindLabel[i.kind] ?? i.kind,
		...(i.agent_kind ? { agent_kind: agentKindLabel[i.agent_kind] ?? i.agent_kind } : {}),
		status: identityStatusLabel[i.status] ?? i.status,
		flags: flagLabels(TelexIdentityFlag, i.flags),
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
		...(b.notice
			? {
					notice: {
						...b.notice,
						level: noticeLevelLabel[b.notice.level ?? 0] ?? b.notice.level,
					},
				}
			: {}),
		...(interaction ? { text: messageInteractionMarkup(m, interaction, selfId, direct) } : {}),
	};
}

export function describeMessage(m: TelexMessage, selfId: string | null, direct: boolean) {
	return {
		...m,
		status: messageStatusLabel[m.status] ?? m.status,
		flags: flagLabels(TelexMessageFlag, m.flags),
		data: {
			...m.data,
			blocks: (m.data?.blocks ?? [])
				.filter((b) => b.type !== TelexBlockType.THINKING)
				.map((b) => describeBlock(m, b, selfId, direct)),
		},
	};
}
