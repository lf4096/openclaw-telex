import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { listEnabledTelexAccounts, resolveTelexAccount } from "./accounts.js";
import { type TelexClient, resolveTelexClient } from "./client.js";
import {
	describeConversation,
	describeIdentity,
	describeMember,
	describeMessage,
} from "./tool-format.js";
import { type TelexToolParams, TelexToolSchema } from "./tool-schema.js";
import type { ResolvedTelexAccount, TelexToolsConfig } from "./types.js";

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
		listConversations: cfg?.listConversations ?? true,
		getConversationInfo: cfg?.getConversationInfo ?? true,
		listMembers: cfg?.listMembers ?? true,
		getConversationMessages: cfg?.getConversationMessages ?? true,
	};
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
					"Telex operations. Actions: search_identities (fuzzy find users/bots by name or email), get_identities (exact resolve by id and/or email), list_conversations (chats + channels; filter with kind=1 for channels only), get_conversation_info (details by id), list_members (conversation members), get_conversation_messages (a conversation's message history, chronological).",
				parameters: TelexToolSchema,
				async execute(_toolCallId, params) {
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
									conversations: res.conversations.map(describeConversation),
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
							case "get_conversation_messages":
								if (!toolsCfg.getConversationMessages)
									return json({
										error: "getConversationMessages is disabled in config",
									});
								return json({
									messages: (
										await client.listMessages({
											conversationId: p.conversation_id,
											beforeSeq: p.before_seq,
											afterSeq: p.after_seq,
											limit: p.limit,
										})
									).map(describeMessage),
								});
							default:
								return json({
									error: `Unknown action: ${String((p as Record<string, unknown>).action)}`,
								});
						}
					} catch (err) {
						return json({ error: err instanceof Error ? err.message : String(err) });
					}
				},
			};
		},
		{ name: "telex" },
	);

	api.logger.info?.("telex tool: Registered");
}
