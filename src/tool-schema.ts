import { type Static, Type } from "@sinclair/typebox";

export const TelexToolSchema = Type.Union([
	Type.Object({
		action: Type.Literal("search_identities", {
			description: "Search users and bots by display name or email (fuzzy).",
		}),
		query: Type.String({ description: "Search query (name or email)" }),
		limit: Type.Optional(Type.Number({ description: "Max results (1-100)" })),
	}),
	Type.Object({
		action: Type.Literal("get_identities", {
			description:
				"Resolve identities by exact id and/or email. Provide ids, emails, or both; unknown entries are omitted from the result.",
		}),
		ids: Type.Optional(
			Type.Array(Type.String(), { description: "Identity ids (16-char hex) to resolve" }),
		),
		emails: Type.Optional(
			Type.Array(Type.String(), { description: "Emails to resolve to identities" }),
		),
	}),
	Type.Object({
		action: Type.Literal("list_conversations", {
			description:
				"List the bot's conversations (chats and channels), paginated. Filter with kind=1 to list only channels.",
		}),
		kind: Type.Optional(
			Type.Number({ description: "Filter by kind: 0 = chat (DM), 1 = channel" }),
		),
		offset: Type.Optional(Type.Number({ description: "Records to skip (default 0)" })),
		limit: Type.Optional(Type.Number({ description: "Page size (1-100, default 20)" })),
	}),
	Type.Object({
		action: Type.Literal("get_conversation_info", {
			description: "Get a conversation's details by id.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
	}),
	Type.Object({
		action: Type.Literal("create_channel", {
			description:
				"Create a channel with the bot as owner. Initial members may be given by identity id and/or email; every email must resolve or nothing is created.",
		}),
		title: Type.String({ description: "Channel title (1-200 chars)" }),
		identity_ids: Type.Optional(
			Type.Array(Type.String(), { description: "Member identity ids (16-char hex)" }),
		),
		emails: Type.Optional(
			Type.Array(Type.String(), { description: "Member emails to resolve to identities" }),
		),
	}),
	Type.Object({
		action: Type.Literal("list_members", {
			description: "List the members of a conversation.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
	}),
	Type.Object({
		action: Type.Literal("add_members", {
			description:
				"Add members to a channel by identity id and/or email; every email must resolve or nobody is added.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
		identity_ids: Type.Optional(
			Type.Array(Type.String(), { description: "Member identity ids (16-char hex)" }),
		),
		emails: Type.Optional(
			Type.Array(Type.String(), { description: "Member emails to resolve to identities" }),
		),
	}),
	Type.Object({
		action: Type.Literal("get_conversation_messages", {
			description:
				"Fetch a conversation's message history in chronological (ascending seq) order. Omit bounds for the latest page; use before_seq to page older, after_seq to fetch newer.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
		before_seq: Type.Optional(
			Type.Number({ description: "Return messages with seq below this" }),
		),
		after_seq: Type.Optional(
			Type.Number({ description: "Return messages with seq above this" }),
		),
		limit: Type.Optional(Type.Number({ description: "Page size (1-100, default 50)" })),
	}),
]);

export type TelexToolParams = Static<typeof TelexToolSchema>;
