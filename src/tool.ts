import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { listEnabledTelexAccounts, resolveTelexAccount } from "./accounts.js";
import { type TelexClient, apiErrorDetail, resolveTelexClient } from "./client.js";
import {
	describeConversation,
	describeConversationBrief,
	describeIdentity,
	describeMember,
	describeMessage,
} from "./tool-format.js";
import { type TelexToolParams, TelexToolSchema } from "./tool-schema.js";
import {
	type ResolvedTelexAccount,
	TelexChannelPermission,
	type TelexChannelPermissionName,
	TelexConversationKind,
	TelexMemberRoleByName,
	type TelexToolsConfig,
} from "./types.js";

function json(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
	};
}

type ResolvedToolsConfig = Required<TelexToolsConfig>;

function resolveToolsConfig(cfg?: TelexToolsConfig): ResolvedToolsConfig {
	return {
		searchIdentities: cfg?.searchIdentities ?? true,
		getIdentities: cfg?.getIdentities ?? true,
		updateIdentity: cfg?.updateIdentity ?? true,
		listConversations: cfg?.listConversations ?? true,
		getConversationInfo: cfg?.getConversationInfo ?? true,
		createChannel: cfg?.createChannel ?? true,
		renameConversation: cfg?.renameConversation ?? true,
		updateConversationSettings: cfg?.updateConversationSettings ?? true,
		deleteConversation: cfg?.deleteConversation ?? true,
		listMembers: cfg?.listMembers ?? true,
		addMembers: cfg?.addMembers ?? true,
		updateMemberRole: cfg?.updateMemberRole ?? true,
		removeMembers: cfg?.removeMembers ?? true,
		getConversationMessages: cfg?.getConversationMessages ?? true,
		answerInteraction: cfg?.answerInteraction ?? true,
	};
}

// batch-get-identities silently skips unknown emails, so completeness is checked
// here: any unresolved email aborts before the mutation.
async function resolveMemberIds(
	client: TelexClient,
	identityIds: string[] | undefined,
	emails: string[] | undefined,
): Promise<{ ids: string[] } | { error: string }> {
	const ids = new Set(identityIds ?? []);
	const wanted = [...new Set(emails ?? [])];
	if (wanted.length > 0) {
		const identities = await client.getIdentities([], wanted);
		const byEmail = new Map(identities.map((i) => [i.email.toLowerCase(), i.id]));
		const unresolved = wanted.filter((email) => !byEmail.has(email.toLowerCase()));
		if (unresolved.length > 0) {
			return { error: `unresolved emails: ${unresolved.join(", ")}` };
		}
		for (const email of wanted) {
			const id = byEmail.get(email.toLowerCase());
			if (id) ids.add(id);
		}
	}
	return { ids: [...ids] };
}

async function resolveOneIdentityId(
	client: TelexClient,
	identityId: string | undefined,
	email: string | undefined,
): Promise<{ id: string } | { error: string }> {
	const resolved = await resolveMemberIds(
		client,
		identityId ? [identityId] : undefined,
		email ? [email] : undefined,
	);
	if ("error" in resolved) return resolved;
	if (resolved.ids.length !== 1) return { error: "provide exactly one identity_id or email" };
	return { id: resolved.ids[0] };
}

export function registerTelexTool(api: OpenClawPluginApi) {
	if (!api.config) {
		api.logger.debug?.("telex tool: No config available, skipping");
		return;
	}

	const accounts = listEnabledTelexAccounts(api.config);
	if (accounts.length === 0) {
		api.logger.debug?.("telex tool: No enabled Telex accounts, skipping");
		return;
	}

	const defaultAccount = accounts[0];
	const defaultTools = resolveToolsConfig(defaultAccount.tools);
	const anyEnabled = Object.values(defaultTools).some(Boolean);
	if (!anyEnabled) {
		api.logger.debug?.("telex tool: All actions disabled, skipping");
		return;
	}

	api.registerTool(
		(ctx) => {
			const accountId = ctx.agentAccountId;
			// Resolve the request-scoped account once so action enablement and the
			// client come from the same account (not a mix of default + request).
			const resolveTarget = (): {
				client: TelexClient;
				account: ResolvedTelexAccount;
			} | null => {
				const candidate = accountId
					? resolveTelexAccount({ cfg: api.config!, accountId })
					: defaultAccount;
				const account = accountId && candidate.configured ? candidate : defaultAccount;
				const client = resolveTelexClient(account);
				return client ? { client, account } : null;
			};

			return {
				name: "telex",
				label: "Telex",
				description:
					"Telex operations. NOT for sending - use the message tool to reply. Actions: search_identities (fuzzy find users/bots by name or email), get_identities (exact resolve by id and/or email), update_identity (edit the bot's own display name and/or description), list_conversations (chats + channels, abridged; filter with kind=1 for channels only), get_conversation_info (details by id), create_channel (new channel owned by the bot; members by id and/or email), rename_conversation (retitle a channel or non-default chat), update_conversation_settings (allow or deny channel members an action, and replace the announcement; the owner and admins are never restricted), delete_conversation (delete a channel), list_members (conversation members), add_members (add members to a channel by id and/or email), update_member_role (member, admin, or owner to hand the channel over), remove_members (remove members from a channel by identity id and/or email), get_conversation_messages (a conversation's message history, chronological), answer_interaction (answer an <interaction> listing message_id and interaction_id; one call per message).",
				parameters: TelexToolSchema,
				async execute(_toolCallId, params) {
					// Tool-search dispatch reaches execute without validating input against the schema.
					const p = params as TelexToolParams;
					try {
						const target = resolveTarget();
						if (!target) {
							return json({
								error: `Telex client not available${accountId ? ` for account ${accountId}` : ""}`,
							});
						}
						const { client } = target;
						const toolsCfg = resolveToolsConfig(target.account.tools);

						switch (p.action) {
							case "search_identities":
								if (!toolsCfg.searchIdentities)
									return json({
										error: "searchIdentities is disabled in config",
									});
								return json({
									identities: (
										await client.searchIdentities(p.query, p.limit)
									).map(describeIdentity),
								});
							case "get_identities": {
								if (!toolsCfg.getIdentities)
									return json({ error: "getIdentities is disabled in config" });
								const ids = p.ids ?? [];
								const emails = p.emails ?? [];
								if (ids.length === 0 && emails.length === 0)
									return json({ error: "provide at least one id or email" });
								return json({
									identities: (await client.getIdentities(ids, emails)).map(
										describeIdentity,
									),
								});
							}
							case "update_identity":
								if (!toolsCfg.updateIdentity)
									return json({ error: "updateIdentity is disabled in config" });
								return json({
									identity: describeIdentity(
										await client.updateIdentity({
											displayName: p.display_name,
											description: p.description,
										}),
									),
								});
							case "list_conversations": {
								if (!toolsCfg.listConversations)
									return json({
										error: "listConversations is disabled in config",
									});
								const res = await client.listConversations({
									kind: p.kind,
									offset: p.offset,
									limit: p.limit,
								});
								return json({
									conversations: res.conversations.map(describeConversationBrief),
									total: res.total,
								});
							}
							case "get_conversation_info":
								if (!toolsCfg.getConversationInfo)
									return json({
										error: "getConversationInfo is disabled in config",
									});
								return json({
									conversation: describeConversation(
										await client.getConversation(p.conversation_id, true),
									),
								});
							case "create_channel": {
								if (!toolsCfg.createChannel)
									return json({ error: "createChannel is disabled in config" });
								const resolved = await resolveMemberIds(
									client,
									p.identity_ids,
									p.emails,
								);
								if ("error" in resolved) return json(resolved);
								return json({
									conversation: describeConversation(
										await client.createChannel(p.title, resolved.ids),
									),
								});
							}
							case "rename_conversation":
								if (!toolsCfg.renameConversation)
									return json({
										error: "renameConversation is disabled in config",
									});
								return json({
									conversation: describeConversationBrief(
										await client.renameConversation(p.conversation_id, p.title),
									),
								});
							case "update_conversation_settings": {
								if (!toolsCfg.updateConversationSettings)
									return json({
										error: "updateConversationSettings is disabled in config",
									});
								const allow = p.allow ?? [];
								const deny = p.deny ?? [];
								const announcement = p.announcement;
								if (
									allow.length === 0 &&
									deny.length === 0 &&
									typeof announcement !== "string"
								)
									return json({
										error: "provide a permission to allow or deny, or an announcement",
									});
								const unknown = [...allow, ...deny].filter(
									(name) => !(name in TelexChannelPermission),
								);
								if (unknown.length > 0)
									return json({
										error: `unknown permissions: ${unknown.join(", ")}`,
									});
								const settings: { flags?: number; announcement?: string } = {};
								if (allow.length > 0 || deny.length > 0) {
									const mask = (names: TelexChannelPermissionName[]) =>
										names.reduce(
											(acc, name) => acc | TelexChannelPermission[name],
											0,
										);
									const current = await client.getConversation(
										p.conversation_id,
										true,
									);
									settings.flags =
										((current.flags ?? 0) | mask(deny)) & ~mask(allow);
								}
								if (typeof announcement === "string")
									settings.announcement = announcement;
								return json({
									conversation: describeConversation(
										await client.updateConversationSettings(
											p.conversation_id,
											settings,
										),
									),
								});
							}
							case "delete_conversation":
								if (!toolsCfg.deleteConversation)
									return json({
										error: "deleteConversation is disabled in config",
									});
								await client.deleteConversation(p.conversation_id);
								return json({ deleted: p.conversation_id });
							case "list_members": {
								if (!toolsCfg.listMembers)
									return json({ error: "listMembers is disabled in config" });
								const members = await client.listMembers(p.conversation_id);
								const identities = await client.resolveIdentities(
									members.map((m) => m.identity_id),
								);
								return json({
									members: members.map((m) => describeMember(m, identities)),
								});
							}
							case "add_members": {
								if (!toolsCfg.addMembers)
									return json({ error: "addMembers is disabled in config" });
								const resolved = await resolveMemberIds(
									client,
									p.identity_ids,
									p.emails,
								);
								if ("error" in resolved) return json(resolved);
								if (resolved.ids.length === 0)
									return json({
										error: "provide at least one identity_id or email",
									});
								const members = await client.addMembers(
									p.conversation_id,
									resolved.ids,
								);
								const identities = await client.resolveIdentities(
									members.map((m) => m.identity_id),
								);
								return json({
									members: members.map((m) => describeMember(m, identities)),
								});
							}
							case "update_member_role": {
								if (!toolsCfg.updateMemberRole)
									return json({
										error: "updateMemberRole is disabled in config",
									});
								const role = TelexMemberRoleByName[p.role ?? ""];
								if (role === undefined)
									return json({ error: "role must be member, admin or owner" });
								const resolved = await resolveOneIdentityId(
									client,
									p.identity_id,
									p.email,
								);
								if ("error" in resolved) return json(resolved);
								return json({
									conversation: describeConversation(
										await client.updateMemberRole(
											p.conversation_id,
											resolved.id,
											role,
										),
									),
								});
							}
							case "remove_members": {
								if (!toolsCfg.removeMembers)
									return json({ error: "removeMembers is disabled in config" });
								const resolved = await resolveMemberIds(
									client,
									p.identity_ids,
									p.emails,
								);
								if ("error" in resolved) return json(resolved);
								if (resolved.ids.length === 0)
									return json({
										error: "provide at least one identity_id or email",
									});
								await client.removeMembers(p.conversation_id, resolved.ids);
								return json({ requested: resolved.ids });
							}
							case "get_conversation_messages": {
								if (!toolsCfg.getConversationMessages)
									return json({
										error: "getConversationMessages is disabled in config",
									});
								const conversation = await client.getConversation(
									p.conversation_id,
								);
								const direct = conversation.kind === TelexConversationKind.CHAT;
								const messages = await client.listMessages({
									conversationId: p.conversation_id,
									beforeSeq: p.before_seq,
									afterSeq: p.after_seq,
									limit: p.limit,
								});
								return json({
									messages: messages.map((m) =>
										describeMessage(m, client.getSelfId(), direct),
									),
								});
							}
							case "answer_interaction": {
								if (!toolsCfg.answerInteraction)
									return json({
										error: "answerInteraction is disabled in config",
									});
								if (p.answers.length === 0)
									return json({ error: "provide at least one answer" });
								const message = await client.answerInteraction(
									p.message_id,
									p.answers,
								);
								return json({
									message: {
										id: message.id,
										conversation_id: message.conversation_id,
										seq: message.seq,
									},
								});
							}
							default:
								return json({
									error: `Unknown action: ${String((p as Record<string, unknown>).action)}`,
								});
						}
					} catch (err) {
						const detail = apiErrorDetail(err);
						return json({
							error: err instanceof Error ? err.message : String(err),
							...(detail ? { detail } : {}),
						});
					}
				},
			};
		},
		{ name: "telex" },
	);

	api.logger.info?.("telex tool: Registered");
}
