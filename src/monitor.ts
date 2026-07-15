import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { listEnabledTelexAccounts, resolveTelexAccount } from "./accounts.js";
import { handleTelexMessage } from "./bot.js";
import { type TelexClient, isAuthError, isConversationGone, resolveTelexClient } from "./client.js";
import { logger } from "./log.js";
import type { ResolvedTelexAccount, TelexConversation, TelexMessage } from "./types.js";
import { TelexMessageStatus } from "./types.js";

export type MonitorTelexOpts = {
	config?: OpenClawConfig;
	runtime?: RuntimeEnv;
	abortSignal?: AbortSignal;
	accountId?: string;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
// Keep this above the server keepalive interval to avoid false reconnects.
const STALE_TIMEOUT_MS = 60_000;
const PAGE = 100;
const POISON_MAX_ATTEMPTS = 3;
const MARK_DEBOUNCE_MS = 3_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const REPAIR_LAZY_MS = 30_000;
const REPAIR_BACKOFF_MAX_MS = 600_000;

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

// The per-conversation serial executor: live frames, repair, and marking share
// per-conversation ordering without blocking other chats.
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

const markTimers = new Map<string, ReturnType<typeof setTimeout>>();
const repairTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; due: number }>();
// Accounts whose monitor loop has exited: their timers and queued tasks must
// not touch state or issue RPCs anymore.
const stoppedAccounts = new Set<string>();

function dropTimers(key: string): void {
	const mark = markTimers.get(key);
	if (mark) clearTimeout(mark);
	markTimers.delete(key);
	const repair = repairTimers.get(key);
	if (repair) clearTimeout(repair.timer);
	repairTimers.delete(key);
}

// Keep-first debounce: an armed timer is never reset, so marks land every
// ~3s under continuous traffic instead of being postponed indefinitely.
function scheduleMark(params: DispatchParams, conversationId: string): void {
	const { account, client } = params;
	const key = `${account.accountId}:${conversationId}`;
	if (stoppedAccounts.has(account.accountId)) return;
	if (markTimers.has(key)) return;
	markTimers.set(
		key,
		setTimeout(() => {
			markTimers.delete(key);
			enqueue(key, async () => {
				if (stoppedAccounts.has(account.accountId)) return;
				try {
					await client.syncReadCursor(conversationId);
				} catch (err) {
					if (isConversationGone(err)) {
						client.dropConversation(conversationId);
						dropTimers(key);
						return;
					}
					// Transient (or a halted-account condition surfaced loudly): the next
					// settle's debounce, repair's inline marking, or the sweep retries.
					const log = logger("backfill");
					if (isAuthError(err))
						log.error("mark-read rejected: check key scopes", {
							conversationId,
							err: String(err),
						});
					else log.warn("mark-read failed", { conversationId, err: String(err) });
				}
			});
		}, MARK_DEBOUNCE_MS),
	);
}

function scheduleRepair(params: DispatchParams, conversationId: string, delay: number): void {
	const key = `${params.account.accountId}:${conversationId}`;
	if (stoppedAccounts.has(params.account.accountId)) return;
	const due = Date.now() + delay;
	const existing = repairTimers.get(key);
	if (existing) {
		// Lazy/backoff requests keep the first armed timer (or a hole under
		// steady traffic would reset the backoff every frame); only an
		// immediate request (connect/sweep/seeding) preempts, and only when
		// strictly earlier.
		if (delay > 0 || existing.due <= due) return;
		clearTimeout(existing.timer);
		repairTimers.delete(key);
	}
	const timer = setTimeout(() => {
		repairTimers.delete(key);
		const backoff = Math.min(
			REPAIR_BACKOFF_MAX_MS,
			Math.max(delay, REPAIR_LAZY_MS) * BACKOFF_MULTIPLIER,
		);
		enqueue(key, async () => {
			if (stoppedAccounts.has(params.account.accountId)) return;
			try {
				if (await repairWindow(params, conversationId)) {
					scheduleRepair(params, conversationId, backoff);
				}
			} catch (err) {
				if (isConversationGone(err)) {
					params.client.dropConversation(conversationId);
					dropTimers(key);
					return;
				}
				if (isAuthError(err)) {
					logger("backfill").error("repair rejected: check key scopes", {
						conversationId,
						err: String(err),
					});
					return; // state kept; the sweep retries hourly
				}
				logger("backfill").warn("repair failed, backing off", {
					conversationId,
					err: String(err),
				});
				scheduleRepair(params, conversationId, backoff);
			}
		});
	}, delay);
	repairTimers.set(key, { timer, due });
}

// One dual-bound repair window: mark first (the watermark may already cover the
// lag), read [cursor+1, cursor+PAGE], settle each row; a foreign in_progress row
// stops the watermark but not the dispatch of later rows. Returns whether lag
// remains.
async function repairWindow(params: DispatchParams, conversationId: string): Promise<boolean> {
	const { client } = params;
	const log = logger("backfill");
	// gone/auth are fatal to the window; a transient mark failure is logged and
	// the read proceeds (the watermark simply lags until the next mark).
	const markInline = () =>
		client.syncReadCursor(conversationId).catch((err) => {
			if (isConversationGone(err) || isAuthError(err)) throw err;
			log.warn("inline mark failed", { conversationId, err: String(err) });
		});
	await markInline();
	if (!client.isLagging(conversationId)) return false;
	const base = client.getCursor(conversationId);
	const window = await client.listMessages({
		conversationId,
		afterSeq: base,
		beforeSeq: base + PAGE + 1,
		limit: PAGE,
	});
	window.forEach((message, i) => {
		if (message.seq !== base + 1 + i) {
			throw new Error(`non-contiguous repair window at seq ${message.seq}`);
		}
	});
	for (const message of window) {
		if (client.isDisposed(conversationId, message.seq)) continue;
		if (message.status === TelexMessageStatus.IN_PROGRESS) {
			if (client.isOwnMessage(message)) client.settle(conversationId, message.seq);
			continue;
		}
		if (client.poisonCount(conversationId, message.seq) >= POISON_MAX_ATTEMPTS) {
			client.settle(conversationId, message.seq);
			continue;
		}
		try {
			await handleTelexMessage({ ...params, message });
		} catch (err) {
			// Conversation-gone / configuration errors are classified by the
			// scheduler, not counted as poison.
			if (isConversationGone(err) || isAuthError(err)) throw err;
			notePoisonFailure(client, conversationId, message, err);
			throw new Error(`handle failed at seq ${message.seq}: ${String(err)}`);
		}
		client.settle(conversationId, message.seq);
	}
	await markInline();
	return client.isLagging(conversationId);
}

// The give-up log fires exactly on the failure that reaches the cap; the skip
// paths that later settle the seq stay silent.
function notePoisonFailure(
	client: TelexClient,
	conversationId: string,
	message: TelexMessage,
	err: unknown,
): void {
	const count = client.bumpPoison(conversationId, message.seq);
	const log = logger("inbound");
	if (count >= POISON_MAX_ATTEMPTS) {
		log.error("giving up on message after repeated failures", {
			conversationId,
			messageId: message.id,
			seq: message.seq,
			attempts: count,
			err: String(err),
		});
	} else {
		log.warn("handle failed; repair will retry", {
			conversationId,
			messageId: message.id,
			seq: message.seq,
			attempts: count,
			err: String(err),
		});
	}
}

// The frame path: seed unknown conversations (the frame itself dispatches first,
// repair covers the backlog before it), dedup by seq, settle or poison-count.
async function processFrame(params: DispatchParams & { message: TelexMessage }): Promise<void> {
	const { account, client, message } = params;
	const conversationId = message.conversation_id;
	if (stoppedAccounts.has(account.accountId)) return;
	let seeded = false;
	if (!client.isSeeded(conversationId)) {
		let conversation: TelexConversation;
		try {
			conversation = await client.getConversation(conversationId, true);
		} catch (err) {
			if (isAuthError(err)) {
				logger("inbound").error("seeding rejected: check key scopes", {
					conversationId,
					err: String(err),
				});
				return;
			}
			logger("inbound").warn("seeding failed, frame dropped (sweep recovers)", {
				conversationId,
				err: String(err),
			});
			return;
		}
		client.seedConversation(
			conversationId,
			conversation.membership?.read_seq ?? 0,
			conversation.last_seq ?? 0,
		);
		seeded = true;
		if (client.isLagging(conversationId)) {
			// The early returns below (in_progress, duplicate) must not skip
			// the backlog just discovered by seeding.
			scheduleRepair(params, conversationId, 0);
		}
	}
	if (message.status === TelexMessageStatus.IN_PROGRESS) return;
	if (client.isDisposed(conversationId, message.seq)) return;
	if (client.poisonCount(conversationId, message.seq) >= POISON_MAX_ATTEMPTS) {
		client.settle(conversationId, message.seq);
		scheduleMark(params, conversationId);
	} else {
		try {
			await handleTelexMessage(params);
			client.settle(conversationId, message.seq);
			scheduleMark(params, conversationId);
		} catch (err) {
			if (isConversationGone(err)) {
				client.dropConversation(conversationId);
				dropTimers(`${account.accountId}:${conversationId}`);
				return;
			}
			if (isAuthError(err)) {
				logger("inbound").error("handle rejected: check key scopes", {
					conversationId,
					err: String(err),
				});
				client.observeSeq(conversationId, message.seq);
				return;
			}
			notePoisonFailure(client, conversationId, message, err);
			client.observeSeq(conversationId, message.seq);
			scheduleRepair(params, conversationId, seeded ? 0 : REPAIR_LAZY_MS);
			return;
		}
	}
	client.observeSeq(conversationId, message.seq);
	if (client.isLagging(conversationId)) {
		scheduleRepair(params, conversationId, seeded ? 0 : REPAIR_LAZY_MS);
	}
}

function dispatchMessage(params: DispatchParams & { message: TelexMessage }): void {
	enqueue(`${params.account.accountId}:${params.message.conversation_id}`, () =>
		processFrame(params),
	);
}

// One full-listing reconciliation (connect step 2+3 and the sweep): adopt each
// membership's read_seq, schedule repair where lagging, and drop conversations
// that were known before the listing began but are absent from its complete
// result. Rounds are chained per account: a caller colliding with an in-flight
// round still gets its own fresh listing afterwards (a readiness request must
// not be satisfied by a snapshot that predates the new subscription). Per-
// conversation state changes are applied on each conversation's executor.
// Returns false when the listing failed.
const reconcileChains = new Map<string, Promise<boolean>>();

function reconcile(params: DispatchParams): Promise<boolean> {
	const { account } = params;
	const prev = reconcileChains.get(account.accountId) ?? Promise.resolve(true);
	const next = prev.then(
		() => runReconcile(params),
		() => runReconcile(params),
	);
	reconcileChains.set(account.accountId, next);
	return next;
}

async function runReconcile(params: DispatchParams): Promise<boolean> {
	const { account, client } = params;
	if (stoppedAccounts.has(account.accountId)) return true;
	try {
		const knownAtStart = new Set(client.knownConversations());
		const { conversations } = await client.listConversations({});
		for (const conversation of conversations) {
			enqueue(`${account.accountId}:${conversation.id}`, async () => {
				if (stoppedAccounts.has(account.accountId)) return;
				client.seedConversation(
					conversation.id,
					conversation.membership?.read_seq ?? 0,
					conversation.last_seq ?? 0,
				);
				if (client.isLagging(conversation.id)) scheduleRepair(params, conversation.id, 0);
			});
		}
		const listed = new Set(conversations.map((c) => c.id));
		for (const id of knownAtStart) {
			if (!listed.has(id)) {
				enqueue(`${account.accountId}:${id}`, async () => {
					if (stoppedAccounts.has(account.accountId)) return;
					client.dropConversation(id);
					dropTimers(`${account.accountId}:${id}`);
				});
			}
		}
		return true;
	} catch (err) {
		if (isAuthError(err)) {
			logger("backfill").error("listing rejected: check key scopes", {
				accountId: account.accountId,
				err: String(err),
			});
		} else {
			logger("backfill").warn("conversation listing failed", {
				accountId: account.accountId,
				err: String(err),
			});
		}
		return false;
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
	const dispatchParams: DispatchParams = { cfg, account, client, runtime };

	stoppedAccounts.delete(accountId);
	const sweep = setInterval(() => void reconcile(dispatchParams), SWEEP_INTERVAL_MS);
	let backoff = INITIAL_BACKOFF_MS;

	try {
		while (!abortSignal?.aborted) {
			const attempt = new AbortController();
			const onOuterAbort = () => attempt.abort();
			abortSignal?.addEventListener("abort", onOuterAbort, { once: true });

			let staleTimer: ReturnType<typeof setTimeout> | undefined;
			const armStale = () => {
				if (staleTimer) clearTimeout(staleTimer);
				staleTimer = setTimeout(() => {
					log.warn("stream silent, reconnecting", {
						accountId,
						timeoutMs: STALE_TIMEOUT_MS,
					});
					attempt.abort();
				}, STALE_TIMEOUT_MS);
			};

			let reconciled = false;
			try {
				log.info("connecting", { accountId, baseUrl: account.baseUrl });
				await client.ensureSelfId().catch((err) => {
					// Never blocks the stream: seeding arms the identity from
					// membership rows before any dispatch.
					if (isAuthError(err)) {
						log.error(
							"get-identity rejected: check key scopes; identity will be armed from membership rows",
							{
								accountId,
								err: String(err),
							},
						);
					} else {
						log.warn(
							"get-identity failed; identity will be armed from membership rows",
							{
								accountId,
								err: String(err),
							},
						);
					}
				});
				armStale();
				await client.subscribe(attempt.signal, (event) => {
					armStale();
					backoff = INITIAL_BACKOFF_MS;
					// The first frame is the server's readiness signal: the subscription
					// is live, so reconciling now cannot miss messages in between.
					if (!reconciled) {
						reconciled = true;
						log.info("stream live", { accountId });
						void reconcile(dispatchParams).then((ok) => {
							// Retry on the next frame rather than waiting for a reconnect.
							if (!ok) reconciled = false;
						});
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
						dispatchMessage({ ...dispatchParams, message: event.message });
					}
				});
				log.info("stream closed by server", { accountId });
			} catch (err) {
				if (abortSignal?.aborted || attempt.signal.aborted) {
					// Expected shutdown or stale reconnect.
				} else if (isAuthError(err)) {
					throw new Error(
						`Telex subscribe rejected for account "${accountId}": check apiKey and scopes (${String(err)})`,
					);
				} else {
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
	} finally {
		clearInterval(sweep);
		stoppedAccounts.add(accountId);
		for (const key of [...markTimers.keys(), ...repairTimers.keys()]) {
			if (key.startsWith(`${accountId}:`)) dropTimers(key);
		}
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
