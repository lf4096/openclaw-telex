import type { TelexClient } from "./client.js";
import { logger } from "./log.js";
import { mediaBlock, prepareOutboundMedia } from "./media.js";
import { type TelexBlock, TelexBlockType, type TelexMessage } from "./types.js";

// Telex caps a message's serialized `data` at 1 MiB (telex-openapi.md "Limits"); the chunker
// counts characters, so chunk well under that to leave headroom for worst-case multi-byte text
// (CJK ~3 B/char) plus JSON/block overhead. Long text-only replies are split at this size.
export const TELEX_TEXT_CHUNK_LIMIT = 200_000;

export function textBlock(text: string): TelexBlock {
	return { type: TelexBlockType.TEXT, text };
}

// Uploads an outbound media reference to a block, or a short text note if the upload
// fails, so one bad attachment never drops the rest of the message.
async function outboundMediaBlock(client: TelexClient, mediaUrl: string): Promise<TelexBlock> {
	try {
		const media = await prepareOutboundMedia(mediaUrl);
		const uploaded = await client.uploadFile(media.name, media.mime, media.bytes);
		return mediaBlock(uploaded);
	} catch (err) {
		logger("outbound").error("media upload failed", { mediaUrl, err: String(err) });
		return textBlock(`[attachment unavailable: ${String(err)}]`);
	}
}

// Sends an outbound Telex message (agent reply or proactive send such as a cron job).
// A Telex message carries an ordered block array, so the text and every attachment ride
// in ONE message ([text, media, media, ...]). Text-only content is split across messages
// when a chunker is supplied (long agent output). Returns the last message sent.
export async function sendTelexMessage(params: {
	client: TelexClient;
	conversationId: string;
	text?: string;
	mediaUrls?: string[];
	chunk?: (text: string, limit: number) => string[];
}): Promise<TelexMessage | undefined> {
	const { client, conversationId, chunk } = params;
	const text = params.text?.trim() ?? "";
	const mediaUrls = params.mediaUrls ?? [];

	if (mediaUrls.length === 0) {
		const parts = chunk ? chunk(text, TELEX_TEXT_CHUNK_LIMIT) : [text];
		let last: TelexMessage | undefined;
		for (const part of parts) {
			if (part.trim()) {
				last = await client.sendMessage({ conversationId, blocks: [textBlock(part)] });
			}
		}
		return last;
	}

	const blocks: TelexBlock[] = [];
	if (text) blocks.push(textBlock(text));
	for (const mediaUrl of mediaUrls) {
		blocks.push(await outboundMediaBlock(client, mediaUrl));
	}
	return client.sendMessage({ conversationId, blocks });
}
