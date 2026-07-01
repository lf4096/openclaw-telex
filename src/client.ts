import { logger } from "./log.js";
import type {
	TelexBlock,
	TelexConversation,
	TelexIdentityBrief,
	TelexMedia,
	TelexMember,
	TelexMessage,
	TelexSubscribeEvent,
} from "./types.js";

const HTTP_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 60_000;
const SENT_IDS_MAX = 2_000;
const IDENTITY_CACHE_MAX = 2_000;
const CONVERSATION_CACHE_MAX = 2_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const OPENAPI_PREFIX = "/voyager/v1/openapi/telex";

export type SendMessageParams = {
	conversationId?: string;
	peerId?: string;
	messageId?: string;
	blocks: TelexBlock[];
	mentionIds?: string[];
	status?: number;
};

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	while (map.size > max) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

// Entity caches (conversations, identities) expire entries after CACHE_TTL_MS on
// top of the LRU bound, so a long-lived client re-fetches renamed titles,
// membership counts, display names, etc. instead of serving them forever.
type CacheEntry<V> = { value: V; expiresAt: number };

function readCache<V>(map: Map<string, CacheEntry<V>>, key: string): V | undefined {
	const entry = map.get(key);
	if (!entry) return undefined;
	if (entry.expiresAt <= Date.now()) {
		map.delete(key);
		return undefined;
	}
	return entry.value;
}

function writeCache<V>(map: Map<string, CacheEntry<V>>, key: string, value: V, max: number): void {
	lruSet(map, key, { value, expiresAt: Date.now() + CACHE_TTL_MS }, max);
}

// Runs fetch with an abort-based timeout, always clearing the timer. Callers own
// body decoding and error shaping on the returned Response.
export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

export class TelexClient {
	private apiKey: string;
	private baseUrl: string;

	// Echo suppression: the subscribe stream fans every conversation member's
	// messages back to that member, so the bot receives its own sends. selfId is
	// armed from config (botId) and refreshed from every send response; sent ids
	// cover the brief window before selfId is first learned.
	private selfId: string | null;
	private sentMessageIds = new Map<string, true>();

	// Per-conversation backfill watermark. `settled` is the highest seq seen in a
	// terminal state; `pending` holds in-progress seqs not yet completed. The
	// backfill cursor is clamped below any pending seq, since a streaming message
	// keeps its seq across IN_PROGRESS -> COMPLETED: advancing past it would make a
	// reconnect's list-messages(after_seq) skip the completed form (forward-only
	// stream never replays it).
	private cursors = new Map<string, { settled: number; pending: Set<number> }>();

	// Highest seq per conversation that entered an agent turn. When a mention lands
	// in a requireMention channel, the gap since this seq is backfilled as context.
	private lastTurnSeq = new Map<string, number>();

	// Inbound delivery is at-least-once: a reconnect backfill can re-deliver a
	// message the live stream already produced, so dispatch is deduped by id.
	private processedMessageIds = new Map<string, true>();

	private conversationCache = new Map<string, CacheEntry<TelexConversation>>();
	private identityCache = new Map<string, CacheEntry<TelexIdentityBrief>>();

	constructor(apiKey: string, baseUrl: string, botId?: string) {
		this.apiKey = apiKey;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.selfId = botId?.trim() || null;
	}

	private async apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetchWithTimeout(
			`${this.baseUrl}${path}`,
			{
				method,
				headers: {
					"x-api-key": this.apiKey,
					"Content-Type": "application/json",
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			},
			HTTP_TIMEOUT_MS,
		);
		const text = await res.text();
		const data = text ? JSON.parse(text) : {};
		if (!res.ok) {
			const code = (data as { code?: number }).code;
			const message = (data as { message?: string }).message ?? `HTTP ${res.status}`;
			throw Object.assign(new Error(`Telex API error: ${message}`), {
				httpStatus: res.status,
				code,
			});
		}
		return data as T;
	}

	private get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
		const qs = new URLSearchParams();
		for (const [key, value] of Object.entries(params ?? {})) {
			if (value !== undefined && value !== "") qs.set(key, String(value));
		}
		const query = qs.toString();
		return this.apiCall<T>("GET", `${OPENAPI_PREFIX}${path}${query ? `?${query}` : ""}`);
	}

	private post<T>(path: string, body: unknown): Promise<T> {
		return this.apiCall<T>("POST", `${OPENAPI_PREFIX}${path}`, body);
	}

	async sendMessage(params: SendMessageParams): Promise<TelexMessage> {
		const data: Record<string, unknown> = { blocks: params.blocks };
		if (params.mentionIds && params.mentionIds.length > 0) data.mention_ids = params.mentionIds;
		const body: Record<string, unknown> = { data };
		if (params.conversationId) body.conversation_id = params.conversationId;
		if (params.peerId) body.peer_id = params.peerId;
		if (params.messageId) body.message_id = params.messageId;
		if (params.status !== undefined) body.status = params.status;

		const { message } = await this.post<{ message: TelexMessage }>("/send-message", body);
		this.recordSent(message);
		return message;
	}

	async setActivity(conversationId: string, status: string): Promise<void> {
		await this.post("/set-activity", { conversation_id: conversationId, status });
	}

	// Files use plain HTTP (gin) endpoints, not the grpc-gateway JSON ones: upload
	// is multipart, download streams bytes. Both authenticate with the same api key.
	async uploadFile(name: string, mime: string, bytes: Uint8Array): Promise<TelexMedia> {
		const form = new FormData();
		form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), name);
		const res = await fetchWithTimeout(
			`${this.baseUrl}${OPENAPI_PREFIX}/upload-file`,
			{
				method: "POST",
				headers: { "x-api-key": this.apiKey },
				body: form,
			},
			FILE_TIMEOUT_MS,
		);
		const text = await res.text();
		const data = text ? JSON.parse(text) : {};
		if (!res.ok) {
			const message = (data as { message?: string }).message ?? `HTTP ${res.status}`;
			throw Object.assign(new Error(`Telex upload error: ${message}`), {
				httpStatus: res.status,
			});
		}
		return data as TelexMedia;
	}

	async downloadFile(params: {
		fileId: string;
		conversationId?: string;
		messageId?: string;
	}): Promise<{ buffer: Buffer; contentType: string }> {
		const qs = new URLSearchParams({ file_id: params.fileId });
		if (params.conversationId) qs.set("conversation_id", params.conversationId);
		if (params.messageId) qs.set("message_id", params.messageId);
		const res = await fetchWithTimeout(
			`${this.baseUrl}${OPENAPI_PREFIX}/download-file?${qs}`,
			{ headers: { "x-api-key": this.apiKey } },
			FILE_TIMEOUT_MS,
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw Object.assign(new Error(`Telex download error: HTTP ${res.status} ${detail}`), {
				httpStatus: res.status,
			});
		}
		const contentType = res.headers.get("content-type") ?? "application/octet-stream";
		const buffer = Buffer.from(await res.arrayBuffer());
		return { buffer, contentType };
	}

	// forceRefresh bypasses the cache read (the agent tool wants live data); the
	// fetched value still refreshes the cache for the hot inbound path.
	async getConversation(
		conversationId: string,
		forceRefresh = false,
	): Promise<TelexConversation> {
		if (!forceRefresh) {
			const cached = readCache(this.conversationCache, conversationId);
			if (cached) return cached;
		}
		const { conversation } = await this.get<{ conversation: TelexConversation }>(
			"/get-conversation",
			{ conversation_id: conversationId },
		);
		writeCache(this.conversationCache, conversationId, conversation, CONVERSATION_CACHE_MAX);
		return conversation;
	}

	async listConversations(params?: {
		kind?: number;
		offset?: number;
		limit?: number;
	}): Promise<{ conversations: TelexConversation[]; total: number }> {
		const res = await this.get<{ conversations?: TelexConversation[]; total?: number }>(
			"/list-conversations",
			{ kind: params?.kind, offset: params?.offset, limit: params?.limit },
		);
		return { conversations: res.conversations ?? [], total: res.total ?? 0 };
	}

	async listMembers(conversationId: string): Promise<TelexMember[]> {
		const res = await this.get<{ members?: TelexMember[] }>("/list-members", {
			conversation_id: conversationId,
		});
		return res.members ?? [];
	}

	async listMessages(params: {
		conversationId: string;
		beforeSeq?: number;
		afterSeq?: number;
		limit?: number;
	}): Promise<TelexMessage[]> {
		const res = await this.get<{ messages?: TelexMessage[] }>("/list-messages", {
			conversation_id: params.conversationId,
			before_seq: params.beforeSeq,
			after_seq: params.afterSeq,
			limit: params.limit,
		});
		return res.messages ?? [];
	}

	async searchIdentities(query: string, limit?: number): Promise<TelexIdentityBrief[]> {
		const res = await this.get<{ identities?: TelexIdentityBrief[] }>("/search-identities", {
			query,
			limit,
		});
		return res.identities ?? [];
	}

	// Exact-match lookup by id and/or email; caches results by id. Unknown
	// ids/emails are simply absent from the response.
	async getIdentities(ids: string[], emails: string[]): Promise<TelexIdentityBrief[]> {
		const res = await this.post<{ identities?: TelexIdentityBrief[] }>(
			"/batch-get-identities",
			{
				ids,
				emails,
			},
		);
		const identities = res.identities ?? [];
		for (const identity of identities) {
			writeCache(this.identityCache, identity.id, identity, IDENTITY_CACHE_MAX);
		}
		return identities;
	}

	// Resolves identities by id, serving cache hits and batching the misses.
	async resolveIdentities(ids: string[]): Promise<Map<string, TelexIdentityBrief>> {
		const out = new Map<string, TelexIdentityBrief>();
		const missing: string[] = [];
		for (const id of ids) {
			const hit = readCache(this.identityCache, id);
			if (hit) out.set(id, hit);
			else missing.push(id);
		}
		if (missing.length > 0) {
			for (const identity of await this.getIdentities(missing, [])) {
				out.set(identity.id, identity);
			}
		}
		return out;
	}

	async resolveIdentity(id: string): Promise<TelexIdentityBrief | undefined> {
		return (await this.resolveIdentities([id])).get(id);
	}

	async subscribe(
		abortSignal: AbortSignal,
		onEvent: (event: TelexSubscribeEvent) => void,
	): Promise<void> {
		const res = await fetch(`${this.baseUrl}${OPENAPI_PREFIX}/subscribe`, {
			headers: { "x-api-key": this.apiKey, Accept: "application/json" },
			signal: abortSignal,
		});
		if (res.status !== 200 || !res.body) {
			const detail = await res.text().catch(() => "");
			throw Object.assign(new Error(`Telex subscribe failed: HTTP ${res.status} ${detail}`), {
				httpStatus: res.status,
			});
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const nl = buffer.indexOf("\n");
				if (nl < 0) break;
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				// grpc-gateway wraps each server-streaming frame as {"result": <Response>}
				// and a terminal stream error as {"error": {...}}.
				let parsed: { result?: TelexSubscribeEvent; error?: { message?: string } };
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (parsed.error) {
					throw new Error(
						`Telex subscribe stream error: ${parsed.error.message ?? "unknown"}`,
					);
				}
				if (parsed.result) onEvent(parsed.result);
			}
		}
	}

	recordSent(message: TelexMessage): void {
		if (message.sender_id) this.selfId = message.sender_id;
		if (message.id) lruSet(this.sentMessageIds, message.id, true, SENT_IDS_MAX);
	}

	// Arm selfId from config when the client was constructed without a botId and no
	// send has learned it yet. A learned selfId (from recordSent) always wins.
	armSelfId(botId?: string): void {
		if (this.selfId) return;
		const trimmed = botId?.trim();
		if (trimmed) this.selfId = trimmed;
	}

	isOwnMessage(message: TelexMessage): boolean {
		if (this.selfId && message.sender_id === this.selfId) return true;
		return this.sentMessageIds.has(message.id);
	}

	// Whether this bot is mentioned: @all, or its own id in mention_ids. Derived
	// from message data (best-effort: self id may be unknown before the first send).
	isSelfMentioned(message: TelexMessage): boolean {
		if (message.data?.mention_all) return true;
		if (!this.selfId) return false;
		return message.data?.mention_ids?.includes(this.selfId) ?? false;
	}

	// Records every observed frame against the backfill watermark. `terminal` is
	// true for COMPLETED/ERROR/ABORTED (the seq will not change again); IN_PROGRESS
	// frames mark the seq pending so the cursor stays below it until it settles.
	noteMessage(conversationId: string, seq: number, terminal: boolean): void {
		let entry = this.cursors.get(conversationId);
		if (!entry) {
			// Floor at seq-1: history below the first frame we observed is
			// pre-subscription and must never be backfilled.
			entry = { settled: seq - 1, pending: new Set() };
			this.cursors.set(conversationId, entry);
		}
		if (terminal) {
			if (seq > entry.settled) entry.settled = seq;
			entry.pending.delete(seq);
		} else {
			entry.pending.add(seq);
		}
	}

	// Per-conversation `after_seq` for reconnect backfill: the highest settled seq,
	// clamped below the lowest still-pending seq so no in-progress message is skipped.
	getBackfillTargets(): Array<{ conversationId: string; afterSeq: number }> {
		const out: Array<{ conversationId: string; afterSeq: number }> = [];
		for (const [conversationId, entry] of this.cursors) {
			let afterSeq = entry.settled;
			for (const seq of entry.pending) afterSeq = Math.min(afterSeq, seq - 1);
			out.push({ conversationId, afterSeq });
		}
		return out;
	}

	noteTurnSeq(conversationId: string, seq: number): void {
		if (seq > (this.lastTurnSeq.get(conversationId) ?? 0)) {
			this.lastTurnSeq.set(conversationId, seq);
		}
	}

	getLastTurnSeq(conversationId: string): number | undefined {
		return this.lastTurnSeq.get(conversationId);
	}

	// Returns true the first time a message id is seen (and records it), false on
	// a duplicate. Only completed messages should be marked, so streaming frames
	// that share an id are not consumed before the final frame is dispatched.
	markProcessed(messageId: string): boolean {
		if (this.processedMessageIds.has(messageId)) return false;
		lruSet(this.processedMessageIds, messageId, true, SENT_IDS_MAX);
		return true;
	}
}

const clientCache = new Map<string, TelexClient>();

export function getTelexClient(apiKey: string, baseUrl: string, botId?: string): TelexClient {
	const key = `${baseUrl}:${apiKey}`;
	let client = clientCache.get(key);
	if (!client) {
		client = new TelexClient(apiKey, baseUrl, botId);
		clientCache.set(key, client);
	} else if (botId) {
		// A cached client (e.g. seeded by a botId-less probe) adopts a later botId.
		client.armSelfId(botId);
	}
	return client;
}

export function resolveTelexClient(params: {
	apiKey?: string;
	baseUrl?: string;
	botId?: string;
}): TelexClient | null {
	if (!params.apiKey || !params.baseUrl) return null;
	return getTelexClient(params.apiKey, params.baseUrl, params.botId);
}
