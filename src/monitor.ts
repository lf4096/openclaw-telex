import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { listEnabledTelexAccounts, resolveTelexAccount } from "./accounts.js";
import { handleTelexMessage } from "./bot.js";
import { type TelexClient, resolveTelexClient } from "./client.js";
import { logger } from "./log.js";
import type { ResolvedTelexAccount, TelexMessage } from "./types.js";

export type MonitorTelexOpts = {
	config?: OpenClawConfig;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
	accountId?: string;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
// The server sends a periodic keepalive frame, so silence beyond this window means a half-open
// connection (server gone / silently dropped). Reconnect to recover; gaps are backfilled via
// list-messages on reconnect. Kept above the server keepalive interval to avoid false reconnects.
const STALE_TIMEOUT_MS = 60_000;
const BACKFILL_LIMIT = 100;
const MAX_BACKFILL_PAGES = 50;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Serialize work per conversation so same-conversation messages keep order and
// never run two agent turns on one session at once; different conversations stay
// concurrent. Live frames and reconnect backfill share these queues.
const conversationQueues = new Map<string, Promise<void>>();

function enqueue(key: string, fn: () => Promise<void>): void {
	const prev = conversationQueues.get(key) ?? Promise.resolve();
	const next = prev
		.then(fn)
		.catch((err) => logger("inbound").error("queued task failed", { key, err: String(err) }));
	conversationQueues.set(key, next);
	void next.finally(() => {
		if (conversationQueues.get(key) === next) conversationQueues.delete(key);
	});
}

type DispatchParams = {
	cfg: OpenClawConfig;
	account: ResolvedTelexAccount;
	client: TelexClient;
	runtime?: RuntimeEnv;
};

function dispatchMessage(params: DispatchParams & { message: TelexMessage }): void {
	enqueue(`${params.account.accountId}:${params.message.conversation_id}`, () =>
		handleTelexMessage(params),
	);
}

// Pages list-messages(after_seq) back to the watermark so an arbitrarily large
// gap is fully recovered (one page returns only the newest BACKFILL_LIMIT), then
// returns the gap in ascending seq order.
async function fetchGap(
	client: TelexClient,
	conversationId: string,
	afterSeq: number,
): Promise<TelexMessage[]> {
	const collected = new Map<number, TelexMessage>();
	let beforeSeq: number | undefined;
	for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
		const messages = await client.listMessages({
			conversationId,
			afterSeq,
			beforeSeq,
			limit: BACKFILL_LIMIT,
		});
		if (messages.length === 0) break;
		for (const message of messages) collected.set(message.seq, message);
		const oldest = messages[0].seq; // list-messages returns ascending seq
		if (messages.length < BACKFILL_LIMIT || oldest <= afterSeq + 1) break;
		beforeSeq = oldest;
		if (page === MAX_BACKFILL_PAGES - 1) {
			logger("backfill").warn("backfill page cap hit, older gap messages skipped", {
				conversationId,
				afterSeq,
			});
		}
	}
	return [...collected.values()].sort((a, b) => a.seq - b.seq);
}

async function backfillConversation(
	params: DispatchParams & { conversationId: string; afterSeq: number },
): Promise<void> {
	const { cfg, account, client, runtime, conversationId, afterSeq } = params;
	const gap = await fetchGap(client, conversationId, afterSeq);
	for (const message of gap) {
		await handleTelexMessage({ cfg, account, client, runtime, message });
	}
}

// Seeds a backfill task at the head of each seen conversation's queue. Called
// synchronously when the connection goes live (the readiness frame), so per
// conversation the gap is enqueued before any live frame for it can be.
function startBackfill(params: DispatchParams): void {
	const { client, account } = params;
	for (const { conversationId, afterSeq } of client.getBackfillTargets()) {
		enqueue(`${account.accountId}:${conversationId}`, () =>
			backfillConversation({ ...params, conversationId, afterSeq }),
		);
	}
}

async function connectSingleAccount(params: {
	cfg: OpenClawConfig;
	account: ResolvedTelexAccount;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
}): Promise<void> {
	const { cfg, account, runtime, abortSignal } = params;
	const { accountId } = account;
	const log = logger("subscribe");

	const client = resolveTelexClient(account);
	if (!client) {
		throw new Error(`Telex client not available for account "${accountId}"`);
	}

	let backoff = INITIAL_BACKOFF_MS;

	while (!abortSignal?.aborted) {
		const attempt = new AbortController();
		const onOuterAbort = () => attempt.abort();
		abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

		let staleTimer: ReturnType<typeof setTimeout> | undefined;
		const armStale = () => {
			if (staleTimer) clearTimeout(staleTimer);
			staleTimer = setTimeout(() => {
				log.warn("stream silent, reconnecting", { accountId, timeoutMs: STALE_TIMEOUT_MS });
				attempt.abort();
			}, STALE_TIMEOUT_MS);
		};

		let triggeredBackfill = false;
		try {
			log.info("connecting", { accountId, baseUrl: account.baseUrl });
			armStale();
			await client.subscribe(attempt.signal, (event) => {
				armStale();
				backoff = INITIAL_BACKOFF_MS;
				// The server flushes a readiness frame (no message) once the
				// subscription is live; seed backfill only after that, so we never
				// miss events arriving between snapshot and live tail. Seeding is
				// synchronous, so per conversation the gap is queued ahead of live.
				if (!triggeredBackfill) {
					triggeredBackfill = true;
					log.info("stream live", { accountId });
					startBackfill({ cfg, account, client, runtime });
				}
				if (event.message) {
					log.debug("frame", {
						accountId,
						conversationId: event.message.conversation_id,
						seq: event.message.seq,
						senderId: event.message.sender_id,
						status: event.message.status,
						flags: event.message.flags,
					});
					dispatchMessage({
						cfg,
						account,
						client,
						runtime,
						message: event.message,
					});
				}
			});
			log.info("stream closed by server", { accountId });
		} catch (err) {
			if (abortSignal?.aborted || attempt.signal.aborted) {
				// Aborted for shutdown or stale-reconnect; fall through to loop guard.
			} else {
				const status = (err as { httpStatus?: number })?.httpStatus;
				if (status === 401 || status === 403) {
					throw new Error(
						`Telex subscribe rejected (HTTP ${status}) for account "${accountId}": check apiKey`,
					);
				}
				log.error("subscribe error", { accountId, err: String(err) });
			}
		} finally {
			if (staleTimer) clearTimeout(staleTimer);
			abortSignal?.removeEventListener("abort", onOuterAbort);
		}

		if (abortSignal?.aborted) break;
		log.info("reconnecting", { accountId, backoffMs: backoff });
		await sleep(backoff, abortSignal);
		backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
	}
}

export async function monitorTelexProvider(opts: MonitorTelexOpts = {}): Promise<void> {
	const cfg = opts.config;
	if (!cfg) {
		throw new Error("Config is required for Telex monitor");
	}

	const log = logger("subscribe");

	if (opts.accountId) {
		const account = resolveTelexAccount({ cfg, accountId: opts.accountId });
		if (!account.enabled || !account.configured) {
			throw new Error(`Telex account "${opts.accountId}" not configured or disabled`);
		}
		return connectSingleAccount({
			cfg,
			account,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal,
		});
	}

	const accounts = listEnabledTelexAccounts(cfg);
	if (accounts.length === 0) {
		throw new Error("No enabled Telex accounts configured");
	}

	log.info("starting accounts", {
		count: accounts.length,
		accountIds: accounts.map((a) => a.accountId),
	});

	await Promise.all(
		accounts.map((account) =>
			connectSingleAccount({
				cfg,
				account,
				runtime: opts.runtime,
				abortSignal: opts.abortSignal,
			}),
		),
	);
}
