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

type ApiError = { httpStatus?: number; apiMessage?: string };

// 403 carries both "insufficient scope" (a key configuration error) and
// "not a member" (conversation-level); branch on the stable body code. In-stream
// error frames carry only the body code, so classification must not require a
// status match.
export function isConversationGone(err: unknown): boolean {
	const { apiMessage } = err as ApiError;
	return apiMessage === "not_a_member" || apiMessage === "conversation_not_found";
}

export function isAuthError(err: unknown): boolean {
	const { httpStatus, apiMessage } = err as ApiError;
	if (httpStatus === 401) return true;
	return (
		apiMessage === "insufficient_scope" ||
		apiMessage === "invalid_api_key" ||
		apiMessage === "api_key_empty"
	);
}

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

	// Sent ids cover self-echoes before a send response reveals selfId.
	private selfId: string | null;
	private sentMessageIds = new Map<string, true>();

	// Per-conversation message-sync state: cursor = local cache of the server
	// read_seq (everything at or below it is settled), settled = the disposed
	// seqs above it, poison = handle failure counts.
	private sync = new Map<
		string,
		{ cursor: number; settled: Set<number>; maxSeen: number; poison: Map<number, number> }
	>();

	// Require-mention channels backfill context from the last agent turn.
	private lastTurnSeq = new Map<string, number>();

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
				apiMessage: (data as { message?: string }).message,
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
		const body: Record<string, unknown> = { data: { blocks: params.blocks } };
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

	// Marking: push the watermark (the contiguous settled prefix from the cursor)
	// to the server, then adopt the effective cursor it returns.
	async syncReadCursor(conversationId: string): Promise<void> {
		const state = this.sync.get(conversationId);
		if (!state) return;
		let watermark = state.cursor;
		while (state.settled.has(watermark + 1)) watermark++;
		if (watermark <= state.cursor) return;
		const res = await this.post<{ read_seq?: number }>("/mark-read", {
			conversation_id: conversationId,
			read_seq: watermark,
		});
		this.updateCursor(conversationId, res.read_seq ?? watermark);
	}

	// Multipart upload bypasses grpc-gateway JSON.
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
				code: (data as { code?: number }).code,
				apiMessage: (data as { message?: string }).message,
			});
		}
		return data as TelexMedia;
	}

	// The encrypted file id is the download capability.
	fileDownloadUrl(fileId: string): string {
		return `${this.baseUrl}${OPENAPI_PREFIX}/download-file?file_id=${encodeURIComponent(fileId)}`;
	}

	async downloadFile(fileId: string): Promise<{ buffer: Buffer; contentType: string }> {
		const res = await fetchWithTimeout(this.fileDownloadUrl(fileId), {}, FILE_TIMEOUT_MS);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			let apiMessage: string | undefined;
			try {
				apiMessage = (JSON.parse(detail) as { message?: string }).message;
			} catch {
				// Non-JSON error body; classification falls back to the status.
			}
			throw Object.assign(new Error(`Telex download error: HTTP ${res.status} ${detail}`), {
				httpStatus: res.status,
				apiMessage,
			});
		}
		const contentType = res.headers.get("content-type") ?? "application/octet-stream";
		const buffer = Buffer.from(await res.arrayBuffer());
		return { buffer, contentType };
	}

	// Tool reads bypass stale cache entries but still refresh them for inbound use.
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
		// The caller's own membership row names the bot's identity: arming here
		// covers keys that cannot call get-identity, before any dispatch.
		this.armSelfId(conversation.membership?.identity_id);
		// Any authoritative read tightens seeded sync state (e.g. a tool read
		// revealing messages the lossy stream dropped).
		if (this.sync.has(conversationId)) {
			this.updateCursor(conversationId, conversation.membership?.read_seq ?? 0);
			this.observeSeq(conversationId, conversation.last_seq ?? 0);
		}
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
		const conversations = res.conversations ?? [];
		this.armSelfId(
			conversations.find((c) => c.membership?.identity_id)?.membership?.identity_id,
		);
		return { conversations, total: res.total ?? 0 };
	}

	async createChannel(title: string, identityIds: string[]): Promise<TelexConversation> {
		const { conversation } = await this.post<{ conversation: TelexConversation }>(
			"/create-channel",
			{ title, identity_ids: identityIds },
		);
		return conversation;
	}

	async listMembers(conversationId: string): Promise<TelexMember[]> {
		const res = await this.get<{ members?: TelexMember[] }>("/list-members", {
			conversation_id: conversationId,
		});
		return res.members ?? [];
	}

	async addMembers(conversationId: string, identityIds: string[]): Promise<TelexMember[]> {
		const res = await this.post<{ members?: TelexMember[] }>("/add-members", {
			conversation_id: conversationId,
			identity_ids: identityIds,
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
			let apiMessage: string | undefined;
			try {
				apiMessage = (JSON.parse(detail) as { message?: string }).message;
			} catch {
				// Non-JSON error body; classification falls back to the status.
			}
			throw Object.assign(new Error(`Telex subscribe failed: HTTP ${res.status} ${detail}`), {
				httpStatus: res.status,
				apiMessage,
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
				let parsed: {
					result?: TelexSubscribeEvent;
					error?: { message?: string; code?: number };
				};
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				if (parsed.error) {
					throw Object.assign(
						new Error(
							`Telex subscribe stream error: ${parsed.error.message ?? "unknown"}`,
						),
						{ apiMessage: parsed.error.message, code: parsed.error.code },
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

	// Never replace a selfId learned from a send response.
	armSelfId(botId?: string): void {
		if (this.selfId) return;
		const trimmed = botId?.trim();
		if (trimmed) this.selfId = trimmed;
	}

	// Without it, backfilled own messages dispatch as inbound and channel
	// mentions are settled as ineligible until the first send reveals the id.
	async ensureSelfId(): Promise<void> {
		if (this.selfId) return;
		const { identity } = await this.get<{ identity?: { id?: string } }>("/get-identity");
		if (identity?.id) this.selfId = identity.id;
	}

	isOwnMessage(message: TelexMessage): boolean {
		if (this.selfId && message.sender_id === this.selfId) return true;
		return this.sentMessageIds.has(message.id);
	}

	// Direct mentions are unavailable until selfId is known.
	isSelfMentioned(message: TelexMessage): boolean {
		if (message.data?.mention_all) return true;
		if (!this.selfId) return false;
		return message.data?.mention_ids?.includes(this.selfId) ?? false;
	}

	isSeeded(conversationId: string): boolean {
		return this.sync.has(conversationId);
	}

	seedConversation(conversationId: string, cursor: number, maxSeen: number): void {
		let state = this.sync.get(conversationId);
		if (!state) {
			state = { cursor: 0, settled: new Set(), maxSeen: 0, poison: new Map() };
			this.sync.set(conversationId, state);
		}
		this.updateCursor(conversationId, cursor);
		state.maxSeen = Math.max(state.maxSeen, maxSeen);
	}

	// The single entry point for cursor updates: advance, then prune both tables.
	updateCursor(conversationId: string, value: number): void {
		const state = this.sync.get(conversationId);
		if (!state || value <= state.cursor) return;
		state.cursor = value;
		for (const seq of state.settled) {
			if (seq <= value) state.settled.delete(seq);
		}
		for (const seq of state.poison.keys()) {
			if (seq <= value) state.poison.delete(seq);
		}
	}

	getCursor(conversationId: string): number {
		return this.sync.get(conversationId)?.cursor ?? 0;
	}

	isDisposed(conversationId: string, seq: number): boolean {
		const state = this.sync.get(conversationId);
		return !state || seq <= state.cursor || state.settled.has(seq);
	}

	settle(conversationId: string, seq: number): void {
		const state = this.sync.get(conversationId);
		if (!state) return;
		if (seq > state.cursor) state.settled.add(seq);
		state.maxSeen = Math.max(state.maxSeen, seq);
	}

	observeSeq(conversationId: string, seq: number): void {
		const state = this.sync.get(conversationId);
		if (state) state.maxSeen = Math.max(state.maxSeen, seq);
	}

	isLagging(conversationId: string): boolean {
		const state = this.sync.get(conversationId);
		return state ? state.cursor < state.maxSeen : false;
	}

	// Returns the new count; the caller logs the give-up exactly when it reaches N.
	bumpPoison(conversationId: string, seq: number): number {
		const state = this.sync.get(conversationId);
		if (!state || seq <= state.cursor) return 0;
		const count = (state.poison.get(seq) ?? 0) + 1;
		state.poison.set(seq, count);
		return count;
	}

	poisonCount(conversationId: string, seq: number): number {
		return this.sync.get(conversationId)?.poison.get(seq) ?? 0;
	}

	knownConversations(): string[] {
		return [...this.sync.keys()];
	}

	dropConversation(conversationId: string): void {
		this.sync.delete(conversationId);
		this.lastTurnSeq.delete(conversationId);
	}

	noteTurnSeq(conversationId: string, seq: number): void {
		if (seq > (this.lastTurnSeq.get(conversationId) ?? 0)) {
			this.lastTurnSeq.set(conversationId, seq);
		}
	}

	getLastTurnSeq(conversationId: string): number | undefined {
		return this.lastTurnSeq.get(conversationId);
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
