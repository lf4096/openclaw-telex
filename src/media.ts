import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { resolveMediaBufferPath } from "openclaw/plugin-sdk/media-store";
import { type TelexClient, fetchWithTimeout } from "./client.js";
import { logger } from "./log.js";
import { getTelexRuntime } from "./runtime.js";
import { type TelexBlock, TelexBlockType, type TelexMedia } from "./types.js";

// Telex caps a single upload at 20 MiB server-side; bound inbound saves likewise.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function mediaPlaceholder(block: TelexBlock): string {
	const name = block.media?.name;
	switch (block.type) {
		case TelexBlockType.IMAGE:
			return `[image${name ? `: ${name}` : ""}]`;
		case TelexBlockType.VIDEO:
			return `[video${name ? `: ${name}` : ""}]`;
		case TelexBlockType.AUDIO:
			return `[audio${name ? `: ${name}` : ""}]`;
		default:
			return `[file${name ? `: ${name}` : ""}]`;
	}
}

function mediaKind(blockType: number): InboundMediaFacts["kind"] {
	if (blockType === TelexBlockType.IMAGE) return "image";
	if (blockType === TelexBlockType.VIDEO) return "video";
	return "document";
}

// Downloads a media block's bytes via the OpenAPI download-file endpoint and
// stages them in the shared media store, which assigns a unique id/path so two
// files with the same name never collide. Returns null on any failure so a bad
// attachment never blocks the rest of the message.
export async function resolveInboundMedia(params: {
	client: TelexClient;
	block: TelexBlock;
	conversationId: string;
	messageId: string;
}): Promise<InboundMediaFacts | null> {
	const { client, block, conversationId, messageId } = params;
	const fileId = block.media?.file_id;
	if (!fileId) return null;
	const log = logger("media");
	const core = getTelexRuntime();

	try {
		const { buffer, contentType } = await client.downloadFile({
			fileId,
			conversationId,
			messageId,
		});
		let mime = block.media?.mime || contentType;
		if (!mime || mime === "application/octet-stream") {
			const detected = await core.media.detectMime({ buffer });
			if (detected) mime = detected;
		}
		const saved = await core.channel.media.saveMediaBuffer(
			buffer,
			mime || "application/octet-stream",
			"inbound",
			MAX_FILE_BYTES,
			block.media?.name,
		);
		log.info("media downloaded", { fileId, path: saved.path });
		return { path: saved.path, contentType: saved.contentType, kind: mediaKind(block.type) };
	} catch (err) {
		log.error("media download failed", { fileId, err: String(err) });
		return null;
	}
}

const MEDIA_STORE_URI_RE = /^media:\/\/([\w-]+)\/([^/]+)$/i;

async function resolveLocalMediaPath(mediaUrl: string): Promise<string> {
	const storeRef = MEDIA_STORE_URI_RE.exec(mediaUrl);
	if (storeRef) {
		try {
			return await resolveMediaBufferPath(storeRef[2], storeRef[1]);
		} catch {
			throw new Error(`Media file not found: ${mediaUrl}`);
		}
	}
	return mediaUrl.startsWith("~")
		? path.join(os.homedir(), mediaUrl.slice(1))
		: mediaUrl.replace(/^file:\/\//, "");
}

async function fetchRemoteMedia(url: string): Promise<{ buffer: Buffer; name: string }> {
	const res = await fetchWithTimeout(url, {}, 30_000);
	if (!res.ok) throw new Error(`Failed to fetch media from ${url}: HTTP ${res.status}`);
	const buffer = Buffer.from(await res.arrayBuffer());
	return { buffer, name: path.basename(new URL(url).pathname) || "file" };
}

function readLocalMedia(resolved: string): { buffer: Buffer; name: string } {
	if (!fs.existsSync(resolved)) throw new Error(`Media file not found: ${resolved}`);
	return { buffer: fs.readFileSync(resolved), name: path.basename(resolved) };
}

// Loads an outbound media reference (media store uri, local path, or http url)
// into bytes for upload, detecting a mime type and enforcing the size cap.
export async function prepareOutboundMedia(
	mediaUrl: string,
): Promise<{ bytes: Buffer; name: string; mime: string }> {
	const core = getTelexRuntime();
	const isRemote = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
	const { buffer, name } = isRemote
		? await fetchRemoteMedia(mediaUrl)
		: readLocalMedia(await resolveLocalMediaPath(mediaUrl));

	if (buffer.length > MAX_FILE_BYTES) {
		throw new Error(
			`Media too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`,
		);
	}

	const mime =
		(await core.media.detectMime({ buffer }).catch(() => undefined)) ||
		"application/octet-stream";
	return { bytes: buffer, name: name.slice(0, 200), mime };
}

export function mediaBlock(media: TelexMedia): TelexBlock {
	const mime = media.mime ?? "";
	const type = mime.startsWith("image/")
		? TelexBlockType.IMAGE
		: mime.startsWith("video/")
			? TelexBlockType.VIDEO
			: mime.startsWith("audio/")
				? TelexBlockType.AUDIO
				: TelexBlockType.FILE;
	return { type, media };
}
