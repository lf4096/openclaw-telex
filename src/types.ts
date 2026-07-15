import type {
	TelexAccountConfigSchema,
	TelexConfigSchema,
	TelexToolsConfigSchema,
	z,
} from "./config-schema.js";

export type TelexConfig = z.infer<typeof TelexConfigSchema>;
export type TelexAccountConfig = z.infer<typeof TelexAccountConfigSchema>;
export type TelexToolsConfig = z.infer<typeof TelexToolsConfigSchema>;

export type ResolvedTelexAccount = {
	accountId: string;
	enabled: boolean;
	configured: boolean;
	apiKey?: string;
	baseUrl: string;
	botId?: string;
	tools?: TelexToolsConfig;
	config: TelexConfig;
};

// Values must match telex.proto.
export const TelexBlockType = {
	TEXT: 1,
	IMAGE: 2,
	VIDEO: 3,
	AUDIO: 4,
	FILE: 5,
	THINKING: 11,
	TOOL: 12,
	EVENT: 21,
} as const;

export const TelexConversationKind = { CHAT: 0, CHANNEL: 1 } as const;
export const TelexMemberRole = { MEMBER: 0, ADMIN: 1, OWNER: 2 } as const;
export const TelexMessageStatus = { COMPLETED: 0, IN_PROGRESS: 1, ERROR: 2, ABORTED: 3 } as const;
export const TelexMessageFlag = { NONE: 0, EVENT: 1, EDITED: 2, FORK_PREFIX: 4 } as const;
export const TelexIdentityKind = { USER: 0, MATE_INSTANCE: 1, BOT: 2 } as const;
export const TelexIdentityStatus = { ACTIVE: 0, RETIRED: 1 } as const;
export const TelexToolStatus = { IN_PROGRESS: 0, SUCCESS: 1, ERROR: 2, ABORTED: 3 } as const;

export type TelexMedia = {
	file_id: string;
	name: string;
	size?: number | string;
	mime?: string;
	width?: number;
	height?: number;
	duration?: number;
};

export type TelexTool = {
	id: string;
	name: string;
	status: number;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
};

export type TelexEvent = {
	kind: string;
	details?: Record<string, unknown>;
};

export type TelexBlock = {
	seq?: number;
	type: number;
	text?: string;
	media?: TelexMedia;
	tool?: TelexTool;
	event?: TelexEvent;
};

export type TelexIdentityBrief = {
	id: string;
	kind: number;
	display_name: string;
	email: string;
	avatar: string;
	description: string;
	owner_id: string;
	status: number;
};

export type TelexMessage = {
	id: string;
	conversation_id: string;
	seq: number;
	sender_id: string;
	status: number;
	flags: number;
	root_id: string;
	data: { blocks: TelexBlock[]; mention_ids?: string[]; mention_all?: boolean };
	create_time: string | number;
	update_time: string | number;
};

export type TelexMember = {
	identity_id: string;
	role: number;
	read_seq?: number;
};

export type TelexConversation = {
	id: string;
	kind: number;
	title: string;
	creator_id: string;
	is_default: boolean;
	peer_id: string;
	fork_of_conversation_id: string;
	fork_of_message_id: string;
	member_count: number;
	last_seq: number;
	create_time: string | number;
	update_time: string | number;
	membership?: TelexMember;
};

export type TelexSubscribeEvent = {
	message?: TelexMessage;
};

export type TelexProbeResult = {
	ok: boolean;
	error?: string;
	latencyMs?: number;
};

export function telexTimeMs(value: string | number | undefined): number {
	if (typeof value === "number" && value > 0) return value * 1000;
	if (typeof value === "string" && value && !value.startsWith("0001-01-01")) {
		const ms = Date.parse(value);
		if (!Number.isNaN(ms)) return ms;
	}
	return Date.now();
}
