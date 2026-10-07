import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveTelexAccount } from "./accounts.js";
import { shouldSuppressLocalTelexApprovalPrompt } from "./approval.js";
import { type TelexClient, resolveTelexClient } from "./client.js";
import { getTelexRuntime } from "./runtime.js";
import { TELEX_TEXT_CHUNK_LIMIT, sendTelexMessage } from "./send.js";
import { closeTelexStreams } from "./stream.js";
import { normalizeTelexTarget } from "./targets.js";

async function prepareSend(params: {
	cfg: OpenClawConfig;
	to: string;
	accountId?: string | null;
	method: string;
}): Promise<{ client: TelexClient; conversationId: string }> {
	const account = resolveTelexAccount({ cfg: params.cfg, accountId: params.accountId });
	const client = resolveTelexClient(account);
	if (!client) {
		throw new Error(`Telex client not available for account ${account.accountId}`);
	}
	const conversationId = normalizeTelexTarget(params.to);
	if (!conversationId) {
		throw new Error(`Telex ${params.method}: empty target`);
	}
	await closeTelexStreams(account.accountId, { conversationId });
	return { client, conversationId };
}

const chunkMarkdown = (text: string, limit: number) =>
	getTelexRuntime().channel.text.chunkMarkdownText(text, limit);

export const telexOutbound: ChannelOutboundAdapter = {
	deliveryMode: "direct",
	chunker: chunkMarkdown,
	chunkerMode: "markdown",
	textChunkLimit: TELEX_TEXT_CHUNK_LIMIT,
	shouldSuppressLocalPayloadPrompt: shouldSuppressLocalTelexApprovalPrompt,

	// Telex messages carry a block array, so the whole payload (text + every attachment)
	// is rendered as one multi-block message rather than separate text/media sends.
	sendPayload: async ({ cfg, to, payload, replyToId, accountId }) => {
		const { client, conversationId } = await prepareSend({
			cfg,
			to,
			accountId,
			method: "sendPayload",
		});
		const { trimmedText, mediaUrls } = resolveSendableOutboundReplyParts(payload);
		const message = await sendTelexMessage({
			client,
			conversationId,
			text: trimmedText,
			mediaUrls,
			quoteId: replyToId ?? undefined,
			chunk: chunkMarkdown,
		});
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},

	// Core's message-tool / cross-channel media path delivers plain attachments via
	// sendMedia (one call per media unit), not sendPayload; route each through the same
	// multi-block send so Telex reads as media-capable (deliver.ts supportsMedia).
	sendMedia: async ({ cfg, to, text, mediaUrl, replyToId, accountId }) => {
		const { client, conversationId } = await prepareSend({
			cfg,
			to,
			accountId,
			method: "sendMedia",
		});
		const message = await sendTelexMessage({
			client,
			conversationId,
			text,
			mediaUrls: mediaUrl ? [mediaUrl] : [],
			quoteId: replyToId ?? undefined,
			chunk: chunkMarkdown,
		});
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},

	sendText: async ({ cfg, to, text, replyToId, accountId }) => {
		const { client, conversationId } = await prepareSend({
			cfg,
			to,
			accountId,
			method: "sendText",
		});
		const message = await sendTelexMessage({
			client,
			conversationId,
			text,
			quoteId: replyToId ?? undefined,
		});
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},
};
