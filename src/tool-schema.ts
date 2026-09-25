import { type Static, Type } from "@sinclair/typebox";
import { TelexChannelPermission, type TelexChannelPermissionName } from "./types.js";

const PermissionName = Type.Union(
	(Object.keys(TelexChannelPermission) as TelexChannelPermissionName[]).map((name) =>
		Type.Literal(name),
	),
);

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
		action: Type.Literal("update_identity", {
			description: "Edit the bot's own display name and/or description.",
		}),
		display_name: Type.Optional(Type.String({ description: "New display name (1-100 chars)" })),
		description: Type.Optional(
			Type.String({ description: "New description (up to 200 chars)" }),
		),
	}),
	Type.Object({
		action: Type.Literal("list_conversations", {
			description:
				"List the bot's conversations (chats and channels), paginated and abridged; get_conversation_info has the full one. Filter with kind=1 to list only channels.",
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
		action: Type.Literal("rename_conversation", {
			description:
				"Rename a channel or a non-default chat the bot is a member of. The default 1:1 chat cannot be renamed.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
		title: Type.String({ description: "New title (1-200 chars)" }),
	}),
	Type.Object({
		action: Type.Literal("update_conversation_settings", {
			description:
				"Change a channel's settings: allow an action to every member, deny it to restrict it to the owner and admins, and replace the announcement.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
		allow: Type.Optional(
			Type.Array(PermissionName, { description: "Permissions to open up to members" }),
		),
		deny: Type.Optional(
			Type.Array(PermissionName, {
				description: "Permissions to restrict to the owner and admins",
			}),
		),
		announcement: Type.Optional(
			Type.String({ description: "Announcement text (up to 1000 chars); empty clears it" }),
		),
	}),
	Type.Object({
		action: Type.Literal("delete_conversation", {
			description: "Delete a channel.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
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
		action: Type.Literal("update_member_role", {
			description:
				"Set a channel member's role. 'owner' hands the channel over and leaves you an admin.",
		}),
		conversation_id: Type.String({ description: "Conversation id (16-char hex)" }),
		identity_id: Type.Optional(
			Type.String({ description: "Member identity id (16-char hex)" }),
		),
		email: Type.Optional(
			Type.String({ description: "Member email to resolve to an identity" }),
		),
		role: Type.Union([Type.Literal("member"), Type.Literal("admin"), Type.Literal("owner")], {
			description: "The role to give the member",
		}),
	}),
	Type.Object({
		action: Type.Literal("remove_members", {
			description:
				"Remove members from a channel by identity id and/or email; every email must resolve or nobody is removed.",
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
	Type.Object({
		action: Type.Literal("answer_interaction", {
			description:
				"Answer an <interaction> listing message_id and interaction_id; one call per message.",
		}),
		message_id: Type.String({ description: "The message carrying the interactions" }),
		answers: Type.Array(
			Type.Object({
				interaction_id: Type.String(),
				option_ids: Type.Optional(Type.Array(Type.String())),
				text: Type.Optional(Type.String()),
			}),
			{ description: "One answer per interaction" },
		),
	}),
]);

export type TelexToolParams = Static<typeof TelexToolSchema>;
