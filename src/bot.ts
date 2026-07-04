import type { AssembledInboundReply, InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
	DM_GROUP_ACCESS_REASON,
	resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { checkGroupAccess, isTelexSenderAllowed } from "./access.js";
import type { TelexClient } from "./client.js";
import { logger } from "./log.js";
import { mediaPlaceholder, resolveInboundMedia } from "./media.js";
import { getTelexRuntime } from "./runtime.js";
import { sendTelexMessage } from "./send.js";
import {
	type ResolvedTelexAccount,
	TelexBlockType,
	TelexConversationKind,
	type TelexIdentityBrief,
	type TelexMessage,
	TelexMessageFlag,
	TelexMessageStatus,
} from "./types.js";
import { telexTimeMs } from "./types.js";

// Telex activity status expires after 5s server-side; refresh under that to keep it lit.
const TYPING_KEEPALIVE_MS = 3000;
// Shallow bootstrap; parentSessionKey inheritance carries the full transcript.
const FORK_HISTORY_LIMIT = 50;
// Cap on non-mention messages injected as context when a mention lands after a gap.
const MISSED_CONTEXT_LIMIT = 50;

// Extracts the relayable text and auto-downloads media blocks into the shared
// media store so the agent can see images/files. Placeholders are used as the
// text only when the message has no actual text (mirrors how other channels
// surface attachment-only messages).
async function extractMessageContent(
	client: TelexClient,
	message: TelexMessage,
): Promise<{ text: string; media: InboundMediaFacts[] }> {
	const textParts: string[] = [];
	const placeholders: string[] = [];
	const media: InboundMediaFacts[] = [];

	for (const block of message.data.blocks) {
		switch (block.type) {
			case TelexBlockType.TEXT:
				if (block.text?.trim()) textParts.push(block.text);
				break;
			case TelexBlockType.IMAGE:
			case TelexBlockType.VIDEO:
			case TelexBlockType.AUDIO:
			case TelexBlockType.FILE: {
				placeholders.push(mediaPlaceholder(block));
				const facts = await resolveInboundMedia({
					client,
					block,
					conversationId: message.conversation_id,
					messageId: message.id,
				});
				if (facts) media.push(facts);
				break;
			}
			// THINKING/TOOL/EVENT blocks carry no user-authored content to relay.
		}
	}

	let text = textParts.join("\n");
	if (!text && placeholders.length > 0) text = placeholders.join(" ");
	return { text, media };
}

function senderDisplay(senderId: string, identity?: TelexIdentityBrief): string {
	if (!identity) return senderId;
	const name = identity.display_name || senderId;
	return identity.email ? `${name} (${identity.email})` : name;
}

function historyMessageText(message: TelexMessage): string {
	const parts: string[] = [];
	for (const block of message.data.blocks) {
		switch (block.type) {
			case TelexBlockType.TEXT:
				if (block.text?.trim()) parts.push(block.text);
				break;
			case TelexBlockType.IMAGE:
			case TelexBlockType.VIDEO:
			case TelexBlockType.AUDIO:
			case TelexBlockType.FILE:
				parts.push(mediaPlaceholder(block));
				break;
		}
	}
	return parts.join("\n");
}

// Formats prior messages into thread context (ordered transcript, own messages
// attributed to the assistant); shared by fork bootstrap and mention backfill.
async function formatHistoryMessages(
	cfg: OpenClawConfig,
	client: TelexClient,
	messages: TelexMessage[],
): Promise<{ starterBody: string; historyBody: string } | undefined> {
	if (messages.length === 0) return undefined;
	const core = getTelexRuntime();
	const identities = await client.resolveIdentities(
		messages.filter((m) => !client.isOwnMessage(m)).map((m) => m.sender_id),
	);
	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
	const parts: string[] = [];
	for (const message of messages) {
		const text = historyMessageText(message);
		if (!text) continue;
		const own = client.isOwnMessage(message);
		parts.push(
			core.channel.reply.formatAgentEnvelope({
				channel: "Telex",
				from: own
					? "Assistant"
					: `${senderDisplay(message.sender_id, identities.get(message.sender_id))} (user)`,
				timestamp: new Date(telexTimeMs(message.create_time)),
				envelope: envelopeOptions,
				body: text,
			}),
		);
	}
	if (parts.length === 0) return undefined;
	return { starterBody: parts[0], historyBody: parts.join("\n\n") };
}

async function buildForkHistory(params: {
	cfg: OpenClawConfig;
	client: TelexClient;
	conversationId: string;
}): Promise<{ starterBody: string; historyBody: string } | undefined> {
	const { cfg, client, conversationId } = params;
	const messages = (await client.listMessages({ conversationId, limit: FORK_HISTORY_LIMIT }))
		.filter(
			(m) =>
				(m.flags & TelexMessageFlag.FORK_PREFIX) !== 0 &&
				m.status === TelexMessageStatus.COMPLETED,
		)
		.sort((a, b) => a.seq - b.seq);
	return formatHistoryMessages(cfg, client, messages);
}

// When a mention lands in a requireMention channel after non-mention messages were
// skipped, fetch that gap (exclusive of the last turn's seq and the trigger) so the
// agent receives the intervening conversation as thread context instead of losing it.
async function buildMissedChannelHistory(params: {
	cfg: OpenClawConfig;
	client: TelexClient;
	conversationId: string;
	afterSeq: number;
	beforeSeq: number;
}): Promise<{ starterBody: string; historyBody: string } | undefined> {
	const { cfg, client, conversationId, afterSeq, beforeSeq } = params;
	const messages = (
		await client.listMessages({
			conversationId,
			afterSeq,
			beforeSeq,
			limit: MISSED_CONTEXT_LIMIT,
		})
	)
		.filter(
			(m) =>
				m.status === TelexMessageStatus.COMPLETED &&
				(m.flags & TelexMessageFlag.EVENT) === 0 &&
				(m.flags & TelexMessageFlag.FORK_PREFIX) === 0 &&
				!client.isOwnMessage(m),
		)
		.sort((a, b) => a.seq - b.seq);
	return formatHistoryMessages(cfg, client, messages);
}

export async function handleTelexMessage(params: {
	cfg: OpenClawConfig;
	account: ResolvedTelexAccount;
	client: TelexClient;
	runtime?: RuntimeEnv;
	message: TelexMessage;
}): Promise<void> {
	const { cfg, account, client, runtime, message } = params;
	const log = logger("inbound");
	const { accountId } = account;
	const base = {
		accountId,
		conversationId: message.conversation_id,
		messageId: message.id,
		seq: message.seq,
		senderId: message.sender_id,
	};

	// Record every frame against the backfill watermark before any early return.
	// The OpenAPI stream only delivers settled messages; the IN_PROGRESS guard stays
	// as a safety net so a stray streaming frame can't advance the cursor past it.
	client.noteMessage(
		message.conversation_id,
		message.seq,
		message.status !== TelexMessageStatus.IN_PROGRESS,
	);

	if (client.isOwnMessage(message)) {
		log.debug("skip: own message", base);
		return;
	}
	if (message.status !== TelexMessageStatus.COMPLETED) {
		log.debug("skip: status not completed", { ...base, status: message.status });
		return;
	}
	if ((message.flags & TelexMessageFlag.EVENT) !== 0) {
		log.debug("skip: event", base);
		return;
	}
	// Copied pre-fork history; seeded as context downstream, never a new turn.
	if ((message.flags & TelexMessageFlag.FORK_PREFIX) !== 0) {
		log.debug("skip: fork prefix", base);
		return;
	}
	// Dedup completed messages so a backfill that overlaps the live stream never
	// replies twice. Done after the status gate so streaming frames sharing an id
	// do not consume it before the final frame.
	if (!client.markProcessed(message.id)) {
		log.debug("skip: duplicate", base);
		return;
	}

	log.info("received", { ...base, flags: message.flags });

	const conversation = await client.getConversation(message.conversation_id);
	const isChannel = conversation.kind === TelexConversationKind.CHANNEL;
	const mentioned = client.isSelfMentioned(message);

	const senderIdentity = await client.resolveIdentity(message.sender_id).catch(() => undefined);
	const senderEmail = senderIdentity?.email || undefined;
	const senderName = senderDisplay(message.sender_id, senderIdentity);

	if (isChannel) {
		const access = checkGroupAccess({
			groupPolicy: account.config.groupPolicy ?? "disabled",
			groupAllowFrom: account.config.groupAllowFrom,
			groupSenderAllowFrom: account.config.groupSenderAllowFrom,
			conversationId: message.conversation_id,
			senderId: message.sender_id,
			senderEmail,
		});
		if (!access.allowed) {
			log.warn("access denied", { ...base, reason: access.reason });
			return;
		}
		if ((account.config.groupRequireMention ?? true) && !mentioned) {
			log.debug("skip: mention required", base);
			return;
		}
	} else {
		const allowed = await resolveDmAccess({
			cfg,
			account,
			client,
			senderId: message.sender_id,
			senderEmail,
			conversationId: message.conversation_id,
		});
		if (!allowed) {
			log.warn("access denied", { ...base, reason: "dm_policy" });
			return;
		}
	}

	const { text: messageText, media: mediaList } = await extractMessageContent(client, message);
	if (!messageText && mediaList.length === 0) {
		log.info("skip: empty message", base);
		return;
	}

	// Under requireMention the skipped non-mention messages never reached the session;
	// when a mention finally lands, backfill that gap so the agent has the context.
	let missedHistory: { starterBody: string; historyBody: string } | undefined;
	if (isChannel) {
		if (account.config.groupRequireMention ?? true) {
			const lastSeq = client.getLastTurnSeq(message.conversation_id);
			if (lastSeq !== undefined && message.seq > lastSeq + 1) {
				missedHistory = await buildMissedChannelHistory({
					cfg,
					client,
					conversationId: message.conversation_id,
					afterSeq: lastSeq,
					beforeSeq: message.seq,
				}).catch((err) => {
					log.warn("missed-context backfill failed", { ...base, err: String(err) });
					return undefined;
				});
			}
		}
		client.noteTurnSeq(message.conversation_id, message.seq);
	}

	await dispatchTelexTurn({
		cfg,
		account,
		client,
		runtime,
		conversationId: message.conversation_id,
		chatType: isChannel ? "channel" : "direct",
		senderId: message.sender_id,
		senderName,
		messageId: message.id,
		mentioned,
		timestampMs: telexTimeMs(message.create_time),
		messageText,
		mediaList,
		forkOfConversationId: conversation.fork_of_conversation_id || undefined,
		missedHistory,
	}).catch((err) => {
		log.error("dispatch failed", {
			accountId,
			conversationId: message.conversation_id,
			err: String(err),
		});
	});
}

// Resolves DM access (open / allowlist / pairing) and issues a pairing challenge
// when required, mirroring the shared channel policy + pairing flow.
async function resolveDmAccess(params: {
	cfg: OpenClawConfig;
	account: ResolvedTelexAccount;
	client: TelexClient;
	senderId: string;
	senderEmail?: string;
	conversationId: string;
}): Promise<boolean> {
	const { cfg, account, client, senderId, senderEmail, conversationId } = params;
	const log = logger("inbound");
	const core = getTelexRuntime();
	const accountId = account.accountId;

	const dmPolicy = account.config.dmPolicy ?? "allowlist";
	const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));

	const pairing = createChannelPairingController({ core, channel: "telex", accountId });
	const storeAllowFrom =
		dmPolicy === "pairing" ? await pairing.readAllowFromStore().catch(() => []) : [];

	const accessDecision = resolveDmGroupAccessWithLists({
		isGroup: false,
		dmPolicy,
		groupPolicy: "disabled",
		allowFrom: configAllowFrom,
		groupAllowFrom: [],
		storeAllowFrom,
		isSenderAllowed: (list) => isTelexSenderAllowed(senderId, senderEmail, list),
	});

	if (accessDecision.decision === "pairing") {
		const result = await pairing.issueChallenge({
			senderId,
			senderIdLine: `Your Telex identity id: ${senderId}`,
			meta: senderEmail ? { email: senderEmail } : undefined,
			onCreated: ({ code }) =>
				log.info("pairing challenge issued", { accountId, senderId, code }),
			sendPairingReply: async (text) => {
				await sendTelexMessage({ client, conversationId, text });
			},
			onReplyError: (err) =>
				log.warn("pairing reply failed", { accountId, senderId, err: String(err) }),
		});
		if (!result.created) log.info("pairing pending", { accountId, senderId });
		return false;
	}

	if (accessDecision.decision !== "allow") {
		const reason =
			accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED
				? "dm policy disabled"
				: "sender not in allowlist";
		log.warn("dm access denied", { accountId, senderId, reason });
		return false;
	}

	return true;
}

type TelexDelivery = AssembledInboundReply["delivery"];

function buildTelexDelivery(params: {
	client: TelexClient;
	conversationId: string;
	chunkText: (text: string, limit: number) => string[];
	log: ReturnType<typeof logger>;
	accountId: string;
}): TelexDelivery {
	const { client, conversationId, chunkText, log, accountId } = params;
	return {
		deliver: async (payload) => {
			const { trimmedText, mediaUrls, hasContent } =
				resolveSendableOutboundReplyParts(payload);
			if (!hasContent) return;
			log.info("deliver", { accountId, conversationId, mediaCount: mediaUrls.length });
			await sendTelexMessage({
				client,
				conversationId,
				text: trimmedText,
				mediaUrls,
				chunk: chunkText,
			});
		},
	};
}

async function dispatchTelexTurn(params: {
	cfg: OpenClawConfig;
	account: ResolvedTelexAccount;
	client: TelexClient;
	runtime?: RuntimeEnv;
	conversationId: string;
	chatType: "direct" | "channel";
	senderId: string;
	senderName: string;
	messageId: string;
	mentioned: boolean;
	timestampMs: number;
	messageText: string;
	mediaList: InboundMediaFacts[];
	forkOfConversationId?: string;
	missedHistory?: { starterBody: string; historyBody: string };
}): Promise<void> {
	const { cfg, account, client, conversationId, chatType, senderId, senderName, messageId } =
		params;
	const log = logger("inbound");
	const core = getTelexRuntime();
	const accountId = account.accountId;
	const isChannel = chatType === "channel";

	const route = core.channel.routing.resolveAgentRoute({
		cfg,
		channel: "telex",
		accountId,
		peer: { kind: chatType, id: conversationId },
	});
	const storePath = resolveStorePath(undefined, { agentId: route.agentId });

	// A forked chat inherits the parent conversation's session; the pre-fork
	// history copied into it bootstraps the agent on the first turn.
	let parentSessionKey: string | undefined;
	let forkHistory: { starterBody: string; historyBody: string } | undefined;
	if (params.forkOfConversationId) {
		parentSessionKey = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "telex",
			accountId,
			peer: { kind: "direct", id: params.forkOfConversationId },
		}).sessionKey;
		if (!readSessionUpdatedAt({ storePath, sessionKey: route.sessionKey })) {
			forkHistory = await buildForkHistory({ cfg, client, conversationId }).catch((err) => {
				log.warn("fork history build failed", {
					accountId,
					conversationId,
					err: String(err),
				});
				return undefined;
			});
		}
	}

	const preview = params.messageText.replace(/\s+/g, " ").slice(0, 160);
	core.system.enqueueSystemEvent(
		isChannel
			? `Telex[${accountId}] Channel(${conversationId}) from ${senderName}: ${preview}`
			: `Telex[${accountId}] DM from ${senderName}: ${preview}`,
		{
			sessionKey: route.sessionKey,
			contextKey: `telex:${conversationId}:${messageId}`,
		},
	);

	const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
	const envelopeBody = core.channel.reply.formatAgentEnvelope({
		channel: "Telex",
		from: senderId,
		timestamp: new Date(params.timestampMs),
		envelope: envelopeOptions,
		body: `${senderName}: ${params.messageText}`,
	});

	const threadHistory = forkHistory ?? params.missedHistory;

	const ctxPayload = core.channel.inbound.buildContext({
		channel: "telex",
		accountId,
		messageId,
		timestamp: params.timestampMs,
		from: `telex:${senderId}`,
		sender: { id: senderId, name: senderName },
		conversation: {
			kind: chatType,
			id: conversationId,
			routePeer: { kind: chatType, id: conversationId },
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey,
			...(parentSessionKey ? { parentSessionKey } : {}),
		},
		reply: {
			to: conversationId,
			originatingTo: conversationId,
		},
		message: {
			body: envelopeBody,
			bodyForAgent: params.messageText,
			rawBody: params.messageText,
			commandBody: params.messageText,
		},
		access: {
			commands: { authorized: true },
			mentions: { canDetectMention: isChannel, wasMentioned: params.mentioned },
		},
		media: params.mediaList.length > 0 ? params.mediaList : undefined,
		supplemental: threadHistory ? { thread: threadHistory } : undefined,
	});

	const processingIndicator = account.config.processingIndicator ?? "activity";
	const chunkText = (text: string, limit: number) =>
		core.channel.text.chunkMarkdownText(text, limit);

	const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
		cfg,
		agentId: route.agentId,
		channel: "telex",
		accountId,
		typing:
			processingIndicator === "activity"
				? {
						start: () => client.setActivity(conversationId, "processing"),
						onStartError: (err) =>
							log.warn("typing failed", {
								accountId,
								conversationId,
								err: String(err),
							}),
						keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
						maxDurationMs: 0,
					}
				: undefined,
	});

	const turn: AssembledInboundReply = {
		cfg,
		channel: "telex",
		accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath,
		ctxPayload,
		recordInboundSession: core.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher:
			core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: buildTelexDelivery({
			client,
			conversationId,
			chunkText,
			log: logger("outbound"),
			accountId,
		}),
		replyPipeline,
		replyOptions: { onModelSelected, disableBlockStreaming: true },
		record: {
			onRecordError: (err) =>
				log.warn("record session failed", { accountId, err: String(err) }),
		},
		messageId,
	};

	log.info("dispatching to agent", { accountId, conversationId, sessionKey: route.sessionKey });
	const result = await core.channel.inbound.dispatchReply(turn);
	log.info("dispatch complete", { accountId, conversationId, dispatched: result.dispatched });
}
