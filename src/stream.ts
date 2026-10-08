import type { AssembledInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import {
	createDraftStreamLoop,
	isChannelProgressDraftWorkToolName,
	resolveChannelPreviewStreamMode,
	resolveChannelStreamingPreviewCommandText,
	resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-outbound";
import { type TelexClient, isMessageUnwritable } from "./client.js";
import type { Logger } from "./log.js";
import { TELEX_MESSAGE_MAX_BYTES, messageBlocks, textBlock } from "./send.js";
import {
	type TelexBlock,
	TelexBlockType,
	type TelexConfig,
	TelexMessageStatus,
	TelexToolStatus,
} from "./types.js";

type ReplyOptions = NonNullable<AssembledInboundReply["replyOptions"]>;
// Newer runtimes forward the items they hide from channel progress, flagged; older ones drop
// them before the callback.
type ItemEvent = Parameters<NonNullable<ReplyOptions["onItemEvent"]>>[0] & {
	hideFromChannelProgress?: boolean;
	suppressChannelProgress?: boolean;
};
type DispatchRun = NonNullable<Parameters<NonNullable<ReplyOptions["onAgentRunStart"]>>[2]>;

const START_DELAY_MS = 1500;
const THROTTLE_MS = 1000;
const TOOL_TEXT_MAX_CHARS = 2000;
// The margin covers the per-block fields the server adds.
const MESSAGE_BUDGET_BYTES = TELEX_MESSAGE_MAX_BYTES - 64 * 1024;
const COMPACTION_TOOL = "compaction";

type TelexStreamReply = {
	text: string;
	mediaUrls: string[];
	quoteId?: string;
};

type TelexReplyDelivery = "appended" | "separate";

export type TelexStream = {
	replyOptions: ReplyOptions;
	appendReply: (reply: TelexStreamReply) => Promise<TelexReplyDelivery>;
	interrupt: () => Promise<void>;
	endTurn: () => Promise<void>;
};

type ThinkingSegment = { kind: "thinking"; text: string; sentLength: number; closed: boolean };

type CommentarySegment = { kind: "commentary"; text: string; sent: boolean };

type ToolSegment = {
	kind: "tool";
	id: string;
	name: string;
	status: number;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	sentStatus?: number;
	sentInput?: Record<string, unknown>;
	sentOutput?: Record<string, unknown>;
};

type ReplySegment = { kind: "reply"; blocks: TelexBlock[]; quoteId?: string; sent: boolean };

type Segment = ThinkingSegment | CommentarySegment | ToolSegment | ReplySegment;

type Frame = { blocks: TelexBlock[]; bytes: number; commit: () => void };

type RunState = {
	message?: TelexStreamMessage;
	failed: boolean;
	agentRunStarted: boolean;
	dispatchRun?: DispatchRun;
	compactionId?: string;
	carriedTools?: ToolSegment[];
	outcome?: "completed" | "failed";
	// Reasoning arrives as a snapshot of the whole assistant message's thinking so far.
	snapshot: string;
	snapshotStale: boolean;
};

type MessageContext = {
	client: TelexClient;
	conversationId: string;
	log: Logger;
	onFailure: () => void;
};

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function truncate(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS)}...` : text;
}

function toolStatus(status: string | undefined): number {
	if (status === "completed") return TelexToolStatus.SUCCESS;
	if (status === "skipped") return TelexToolStatus.ABORTED;
	return TelexToolStatus.ERROR;
}

function dispatchRunStatus(run: DispatchRun): number {
	switch (run.getResult().terminalOutcome?.reason) {
		case undefined:
		case "completed":
			return TelexMessageStatus.COMPLETED;
		case "superseded":
		case "cancelled":
		case "aborted":
			return TelexMessageStatus.ABORTED;
		default:
			return TelexMessageStatus.ERROR;
	}
}

function newRun(): RunState {
	return { failed: false, agentRunStarted: false, snapshot: "", snapshotStale: false };
}

function runStatus(run: RunState): number {
	return run.outcome === "failed" ? TelexMessageStatus.ERROR : TelexMessageStatus.COMPLETED;
}

// Runs started with dispatch options (tool commands, ACP) report their outcome through those
// options, never through onAgentRunTerminalOutcome; an agent runner's run that ends without an
// outcome was stopped.
function endStatus(run: RunState): number {
	if (run.outcome !== undefined) return runStatus(run);
	if (run.dispatchRun) return dispatchRunStatus(run.dispatchRun);
	return run.agentRunStarted ? TelexMessageStatus.ABORTED : TelexMessageStatus.COMPLETED;
}

class TelexStreamMessage {
	private readonly ctx: MessageContext;
	private readonly segments: Segment[] = [];
	private readonly loop: ReturnType<typeof createDraftStreamLoop<boolean>>;
	private state: "pending" | "open" | "failed" | "closed" = "pending";
	private timer?: ReturnType<typeof setTimeout>;
	private messageId?: string;
	private quoteId?: string;
	private quoteSent = false;
	private sentBytes = 0;
	private lastSentType?: number;
	private saturated = false;
	private writable = true;
	private fallback?: Promise<void>;

	constructor(ctx: MessageContext, tools: ToolSegment[]) {
		this.ctx = ctx;
		this.segments.push(...tools);
		this.loop = createDraftStreamLoop<boolean>({
			throttleMs: THROTTLE_MS,
			coalesceInFlight: true,
			isStopped: () => this.state !== "open",
			sendOrEditStreamMessage: () => this.sendProgress(),
			emptyValue: false,
			isEmpty: (value) => !value,
			onBackgroundFlushError: (err) => this.fail(err),
		});
	}

	appendThinking(text: string): void {
		const last = this.segments.at(-1);
		if (last?.kind === "thinking" && !last.closed) last.text += text;
		else this.segments.push({ kind: "thinking", text, sentLength: 0, closed: false });
		this.touch();
	}

	appendCommentary(text: string): void {
		this.segments.push({ kind: "commentary", text, sent: false });
		this.touch();
	}

	runningTools(): ToolSegment[] {
		return this.segments
			.filter(
				(segment): segment is ToolSegment =>
					segment.kind === "tool" && segment.status === TelexToolStatus.IN_PROGRESS,
			)
			.map(({ id, name, status, input }) => ({ kind: "tool", id, name, status, input }));
	}

	closeThinking(): void {
		const last = this.segments.at(-1);
		if (last?.kind === "thinking") last.closed = true;
	}

	startTool(id: string, name: string, detail: string | undefined): void {
		const segment = this.tool(id);
		if (!segment) {
			this.segments.push({
				kind: "tool",
				id,
				name,
				status: TelexToolStatus.IN_PROGRESS,
				...(detail ? { input: { detail } } : {}),
			});
		} else if (detail && segment.input?.detail !== detail) {
			segment.input = { detail };
		} else {
			return;
		}
		this.touch();
	}

	endTool(id: string, name: string, status: number, summary: string | undefined): void {
		const segment = this.tool(id);
		if (!segment) {
			this.segments.push({
				kind: "tool",
				id,
				name,
				status,
				...(summary ? { output: { summary } } : {}),
			});
		} else {
			segment.status = status;
			if (summary && segment.output?.summary !== summary) segment.output = { summary };
		}
		this.touch();
	}

	accepts(bytes: number): boolean {
		if (this.state === "failed" || this.state === "closed") return false;
		return this.sentBytes + this.nextFrame().bytes + bytes <= MESSAGE_BUDGET_BYTES;
	}

	appendReply(blocks: TelexBlock[], quoteId: string | undefined): boolean {
		if (blocks.length === 0) return true;
		if (!this.accepts(jsonBytes(blocks))) return false;
		// A message takes one quote; a later reply naming another joins without it.
		if (quoteId) this.quoteId ??= quoteId;
		this.segments.push({ kind: "reply", blocks, quoteId, sent: false });
		this.touch();
		return true;
	}

	async end(params: { status: number; runEnded: boolean }): Promise<void> {
		this.clearTimer();
		if (params.runEnded) {
			for (const segment of this.segments) {
				if (segment.kind === "tool" && segment.status === TelexToolStatus.IN_PROGRESS) {
					segment.status = TelexToolStatus.ABORTED;
				}
			}
		}
		try {
			if (this.state === "open") await this.loop.flush();
			if (this.state !== "failed") await this.sendFinalFrame(params.status, params.runEnded);
		} catch (err) {
			this.fail(err);
		}
		this.loop.stop();
		const failed = this.state === "failed";
		this.state = "closed";
		if (!failed) return;
		await this.fallback;
		if (this.messageId && this.writable) await this.sendEnd(this.messageId, params.status);
	}

	private tool(id: string): ToolSegment | undefined {
		return this.segments.find(
			(segment): segment is ToolSegment => segment.kind === "tool" && segment.id === id,
		);
	}

	private touch(): void {
		if (this.state === "open") {
			this.loop.update(true);
		} else if (this.state === "pending" && !this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				if (this.state !== "pending") return;
				this.state = "open";
				this.loop.update(true);
			}, START_DELAY_MS);
		}
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private nextFrame(): Frame {
		if (!this.saturated) {
			const frame = this.frame("all");
			if (this.sentBytes + frame.bytes <= MESSAGE_BUDGET_BYTES) return frame;
			this.saturated = true;
			this.ctx.log.warn("stream size budget reached; progress stops", {
				conversationId: this.ctx.conversationId,
				messageId: this.messageId,
			});
		}
		return this.frame("replies");
	}

	// Telex concatenates adjacent text blocks of one type: a thinking suffix, kept in segment order,
	// extends its own block, and any other text block that follows one of its type opens with a
	// blank line.
	private frame(scope: "all" | "replies"): Frame {
		const blocks: TelexBlock[] = [];
		const commits: (() => void)[] = [];
		let lastType = this.lastSentType;
		const separate = (block: TelexBlock): TelexBlock =>
			block.text !== undefined && block.type === lastType
				? { ...block, text: `\n\n${block.text}` }
				: block;
		for (const segment of this.segments) {
			if (scope === "replies" && segment.kind !== "reply") continue;
			if (segment.kind === "reply") {
				if (segment.sent) continue;
				const [first, ...rest] = segment.blocks;
				blocks.push(separate(first), ...rest);
				lastType = segment.blocks.at(-1)?.type;
				commits.push(() => {
					segment.sent = true;
				});
				continue;
			}
			if (segment.kind === "thinking") {
				const length = segment.text.length;
				if (length <= segment.sentLength) continue;
				const block = {
					type: TelexBlockType.THINKING,
					text: segment.text.slice(segment.sentLength),
				};
				blocks.push(segment.sentLength === 0 ? separate(block) : block);
				lastType = TelexBlockType.THINKING;
				commits.push(() => {
					segment.sentLength = length;
				});
				continue;
			}
			if (segment.kind === "commentary") {
				if (segment.sent) continue;
				blocks.push(separate(textBlock(segment.text)));
				lastType = TelexBlockType.TEXT;
				commits.push(() => {
					segment.sent = true;
				});
				continue;
			}
			const { status, input, output } = segment;
			if (segment.sentStatus === undefined) {
				lastType = TelexBlockType.TOOL;
				blocks.push({
					type: TelexBlockType.TOOL,
					tool: {
						id: segment.id,
						name: segment.name,
						status,
						...(input ? { input } : {}),
						...(output ? { output } : {}),
					},
				});
			} else if (
				status !== segment.sentStatus ||
				input !== segment.sentInput ||
				output !== segment.sentOutput
			) {
				blocks.push({
					type: TelexBlockType.TOOL,
					tool: {
						id: segment.id,
						status,
						...(input !== segment.sentInput ? { input } : {}),
						...(output !== segment.sentOutput ? { output } : {}),
					},
				});
			} else {
				continue;
			}
			commits.push(() => {
				segment.sentStatus = status;
				segment.sentInput = input;
				segment.sentOutput = output;
			});
		}
		const bytes = blocks.length > 0 ? jsonBytes(blocks) : 0;
		return {
			blocks,
			bytes,
			commit: () => {
				for (const commit of commits) commit();
				this.lastSentType = lastType;
				this.sentBytes += bytes;
			},
		};
	}

	private async sendProgress(): Promise<void> {
		const frame = this.nextFrame();
		if (frame.blocks.length === 0) return;
		await this.sendFrame(frame, TelexMessageStatus.IN_PROGRESS);
	}

	private async sendFinalFrame(status: number, runEnded: boolean): Promise<void> {
		const hasReply = this.segments.some((segment) => segment.kind === "reply");
		if (!this.messageId && !hasReply && runEnded) return;
		const frame = this.nextFrame();
		if (!this.messageId && frame.blocks.length === 0) return;
		await this.sendFrame(frame, status);
	}

	private async sendFrame(frame: Frame, status: number): Promise<void> {
		const { client, conversationId } = this.ctx;
		const { blocks } = frame;
		const quoteId = this.quoteSent ? undefined : this.quoteId;
		const message = await client.sendMessage(
			this.messageId
				? { messageId: this.messageId, quoteId, blocks, status }
				: { conversationId, quoteId, blocks, status },
		);
		this.messageId ??= message.id;
		if (quoteId) this.quoteSent = true;
		frame.commit();
	}

	// Frames carry no idempotency key: retrying one whose response was lost would duplicate its
	// text, so the first failure stops progress for the turn.
	private fail(err: unknown): void {
		if (this.state !== "pending" && this.state !== "open") return;
		this.state = "failed";
		this.writable = !isMessageUnwritable(err);
		this.loop.stop();
		this.ctx.onFailure();
		this.ctx.log.warn("stream frame failed; progress stops", {
			conversationId: this.ctx.conversationId,
			messageId: this.messageId,
			err: String(err),
		});
		this.fallback = this.sendUnsentReplies();
	}

	private async sendUnsentReplies(): Promise<void> {
		const { client, conversationId, log } = this.ctx;
		for (const segment of this.segments) {
			if (segment.kind !== "reply" || segment.sent) continue;
			segment.sent = true;
			await client
				.sendMessage({ conversationId, quoteId: segment.quoteId, blocks: segment.blocks })
				.catch((err) => {
					log.warn("stream reply fallback failed", { conversationId, err: String(err) });
				});
		}
	}

	private async sendEnd(messageId: string, status: number): Promise<void> {
		await this.ctx.client.sendMessage({ messageId, blocks: [], status }).catch((err) => {
			this.ctx.log.warn("stream fallback end failed", {
				conversationId: this.ctx.conversationId,
				messageId,
				err: String(err),
			});
		});
	}
}

type StreamTarget = { conversationId: string } | { peerId: string };

const openStreams = new Map<string, Set<TelexStream>>();

function streamKey(accountId: string, target: StreamTarget): string {
	return JSON.stringify(
		"conversationId" in target
			? [accountId, "conversation", target.conversationId]
			: [accountId, "peer", target.peerId],
	);
}

// An open message must stay the bot's latest in its conversation: a Telex message keeps the
// position it was created at, so anything sent while it is open would land below content
// streamed into it later.
export async function closeTelexStreams(accountId: string, target: StreamTarget): Promise<void> {
	const streams = openStreams.get(streamKey(accountId, target));
	if (!streams) return;
	await Promise.all([...streams].map((stream) => stream.interrupt()));
}

export function createTelexStream(params: {
	client: TelexClient;
	accountId: string;
	conversationId: string;
	defaultChatPeerId?: string;
	config: TelexConfig;
	log: Logger;
}): TelexStream | undefined {
	const { client, accountId, conversationId, config, log } = params;
	if (resolveChannelPreviewStreamMode(config, "progress") === "off") return undefined;
	const toolProgress = resolveChannelStreamingPreviewToolProgress(config, true, "progress");
	const commandText = resolveChannelStreamingPreviewCommandText(config, "raw");
	const keys = [
		streamKey(accountId, { conversationId }),
		...(params.defaultChatPeerId
			? [streamKey(accountId, { peerId: params.defaultChatPeerId })]
			: []),
	];
	// Verbose mode posts tool summaries and commentary as payloads of their own; tool and
	// commentary blocks too would show each twice.
	let verboseProgressActive = () => false;
	let compactions = 0;
	const turnRun = newRun();
	let run: RunState | undefined = turnRun;

	const message = (): TelexStreamMessage | undefined => {
		const owner = run;
		if (!owner || owner.message || owner.failed) return owner?.message;
		owner.message = new TelexStreamMessage(
			{
				client,
				conversationId,
				log,
				onFailure: () => {
					owner.failed = true;
				},
			},
			owner.carriedTools ?? [],
		);
		owner.carriedTools = undefined;
		return owner.message;
	};
	// A message closed mid-run leaves its running tools as they are: the run goes on, and a card's
	// tool is waiting for its answer. They reopen at the head of the next message, where their
	// outcome lands next to their input.
	const closeMidRun = async () => {
		const closed = run?.message;
		if (!run || !closed) return;
		run.message = undefined;
		run.carriedTools = closed.runningTools();
		await closed.end({ status: runStatus(run), runEnded: false });
	};
	const register = () => {
		for (const key of keys) {
			const streams = openStreams.get(key) ?? new Set<TelexStream>();
			streams.add(stream);
			openStreams.set(key, streams);
		}
	};
	const unregister = () => {
		for (const key of keys) {
			const streams = openStreams.get(key);
			streams?.delete(stream);
			if (streams?.size === 0) openStreams.delete(key);
		}
	};
	const endRun = async (ended: RunState | undefined) => {
		if (!ended || ended !== run) return;
		run = undefined;
		unregister();
		await ended.message?.end({ status: endStatus(ended), runEnded: true });
	};
	const isWorkTool = (name: string | undefined): name is string =>
		toolProgress && !verboseProgressActive() && isChannelProgressDraftWorkToolName(name);

	const onItemEvent = (event: ItemEvent): void => {
		if (!run) return;
		if (event.kind === "preamble") {
			if (event.hideFromChannelProgress || event.suppressChannelProgress) return;
			// Embedded runs snapshot the commentary through "update" frames up to "end"; CLI runs send
			// it whole, with no phase.
			if (event.phase !== undefined && event.phase !== "end") return;
			if (event.progressText && !verboseProgressActive()) {
				message()?.appendCommentary(event.progressText);
			}
			return;
		}
		if (event.kind !== "tool") return;
		if (event.phase === "start") {
			// A tool call ends the assistant message; the next snapshot may belong to a new one.
			run.snapshotStale = true;
			run.message?.closeThinking();
		}
		if (event.hideFromChannelProgress || event.suppressChannelProgress) return;
		if (!event.toolCallId || !isWorkTool(event.name)) return;
		if (event.phase === "end") {
			message()?.endTool(
				event.toolCallId,
				event.name,
				toolStatus(event.status),
				truncate(event.summary),
			);
		} else if (event.phase === "start" || event.phase === "update") {
			const detail = commandText !== "raw" && event.commandBearing ? undefined : event.meta;
			message()?.startTool(event.toolCallId, event.name, truncate(detail));
		}
	};

	const stream: TelexStream = {
		replyOptions: {
			suppressDefaultToolProgressMessages: true,
			preserveProgressCallbackStartOrder: true,
			progressPreambleEnabled: true,
			commentaryPayloadsEnabled: true,
			shouldDeliverCommentaryPayloads: () => verboseProgressActive(),
			onVerboseProgressVisibility: (isActive) => {
				verboseProgressActive = isActive;
			},
			onAgentRunStart: (_runId, _token, options) => {
				if (!run) return;
				if (options) run.dispatchRun = options;
				else run.agentRunStarted = true;
			},
			onReasoningStream: ({ text, requiresReasoningProgressOptIn }) => {
				// Flagged reasoning, which only CLI runners send, was not filtered by the session's
				// reasoning level, so it is not shown.
				if (!text || !run || requiresReasoningProgressOptIn) return;
				let suffix: string;
				if (text.startsWith(run.snapshot)) {
					suffix = text.slice(run.snapshot.length);
				} else if (run.snapshotStale) {
					suffix = text;
				} else {
					// The thinking was rewritten in place.
					return;
				}
				run.snapshot = text;
				run.snapshotStale = false;
				if (suffix) message()?.appendThinking(suffix);
			},
			onReasoningEnd: () => {
				run?.message?.closeThinking();
			},
			onAssistantMessageStart: () => {
				if (!run) return;
				run.snapshot = "";
				run.snapshotStale = false;
				run.message?.closeThinking();
			},
			onItemEvent,
			onCompactionStart: () => {
				if (!run) return;
				compactions += 1;
				run.compactionId = `${COMPACTION_TOOL}:${compactions}`;
				message()?.startTool(run.compactionId, COMPACTION_TOOL, undefined);
			},
			// Newer runtimes report whether the compaction completed; older ones pass nothing.
			onCompactionEnd: (payload?: { completed?: boolean }) => {
				if (!run?.compactionId) return;
				const status =
					payload?.completed === false ? TelexToolStatus.ERROR : TelexToolStatus.SUCCESS;
				message()?.endTool(run.compactionId, COMPACTION_TOOL, status, undefined);
				run.compactionId = undefined;
			},
			onAgentRunTerminalOutcome: (value) => {
				if (run) run.outcome = value;
			},
			// A queued run drains through the callbacks of the last turn that queued one, often
			// after that turn's dispatch returned. It is a new reply: it ends whatever this stream
			// still holds and streams into a message of its own.
			onQueuedFollowupAdmitted: async () => {
				await endRun(run);
				run = newRun();
				register();
			},
			onQueuedFollowupSettled: () => endRun(run),
		},
		appendReply: async (reply) => {
			const target = message();
			const text = reply.text.trim();
			if (target?.accepts(text ? jsonBytes(textBlock(text)) : 0)) {
				const blocks = await messageBlocks(client, text, reply.mediaUrls);
				if (target.appendReply(blocks, reply.quoteId)) return "appended";
			}
			await closeMidRun();
			return "separate";
		},
		interrupt: closeMidRun,
		endTurn: () => endRun(turnRun),
	};

	register();
	return stream;
}
