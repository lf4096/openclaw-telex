import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveTelexAccount } from "./accounts.js";
import { type TelexClient, resolveTelexClient } from "./client.js";
import { getTelexRuntime } from "./runtime.js";
import { TELEX_TEXT_CHUNK_LIMIT, sendTelexMessage } from "./send.js";
import { normalizeTelexTarget } from "./targets.js";

function requireClient(cfg: OpenClawConfig, accountId?: string): TelexClient {
	const account = resolveTelexAccount({ cfg, accountId });
	const client = resolveTelexClient(account);
	if (!client) {
		throw new Error(`Telex client not available for account ${account.accountId}`);
	}
	return client;
}

const chunkMarkdown = (text: string, limit: number) =>
	getTelexRuntime().channel.text.chunkMarkdownText(text, limit);

export const telexOutbound: ChannelOutboundAdapter = {
	deliveryMode: "direct",
	chunker: chunkMarkdown,
	chunkerMode: "markdown",
	textChunkLimit: TELEX_TEXT_CHUNK_LIMIT,

	// Telex messages carry a block array, so the whole payload (text + every attachment)
	// is rendered as one multi-block message rather than separate text/media sends.
	sendPayload: async ({ cfg, to, payload, accountId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const conversationId = normalizeTelexTarget(to);
		if (!conversationId) {
			throw new Error("Telex sendPayload: empty target");
		}
		const { trimmedText, mediaUrls } = resolveSendableOutboundReplyParts(payload);
		const message = await sendTelexMessage({
			client,
			conversationId,
			text: trimmedText,
			mediaUrls,
			chunk: chunkMarkdown,
		});
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},

	// Core's message-tool / cross-channel media path delivers plain attachments via
	// sendMedia (one call per media unit), not sendPayload; route each through the same
	// multi-block send so Telex reads as media-capable (deliver.ts supportsMedia).
	sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const conversationId = normalizeTelexTarget(to);
		if (!conversationId) {
			throw new Error("Telex sendMedia: empty target");
		}
		const message = await sendTelexMessage({
			client,
			conversationId,
			text,
			mediaUrls: mediaUrl ? [mediaUrl] : [],
			chunk: chunkMarkdown,
		});
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},

	sendText: async ({ cfg, to, text, accountId }) => {
		const client = requireClient(cfg, accountId ?? undefined);
		const conversationId = normalizeTelexTarget(to);
		if (!conversationId) {
			throw new Error("Telex sendText: empty target");
		}
		const message = await sendTelexMessage({ client, conversationId, text });
		return { channel: "telex", messageId: message?.id ?? "", chatId: conversationId };
	},
};
