import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import {
	CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
	type ChannelApprovalKind,
	type ChannelApprovalNativeRuntimeAdapter,
	type PendingApprovalView,
	createChannelApprovalNativeRuntimeAdapter,
	resolveApprovalOverGateway,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import {
	buildChannelApprovalNativeTargetKey,
	resolveApprovalRequestChannelAccountId,
	shouldSuppressLocalNativeExecApprovalPrompt,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
	ExecApprovalDecision,
	ExecApprovalRequest,
	PluginApprovalRequest,
	SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { listTelexAccountIds, resolveTelexAccount } from "./accounts.js";
import { type TelexClient, resolveTelexClient } from "./client.js";
import { type AnsweredDetails, expireInteractions } from "./interactive.js";
import { logger } from "./log.js";
import { textBlock } from "./send.js";
import {
	type TelexBlock,
	TelexBlockType,
	TelexConversationKind,
	TelexInteractionButtonStyle,
	TelexInteractionMode,
	TelexInteractionStatus,
} from "./types.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

const APPROVAL_INTERACTION_ID = "approval";

// OpenClaw styles allow-once "success" and allow-always "primary"; Telex fills one button.
const STYLES: Record<string, number> = {
	success: TelexInteractionButtonStyle.PRIMARY,
	danger: TelexInteractionButtonStyle.DANGER,
};

type CardEntry = {
	accountId: string;
	messageId: string;
	approvalId: string;
	approvalKind: ChannelApprovalKind;
	decisions: ExecApprovalDecision[];
	taken: boolean;
};

const cards = new Map<string, CardEntry>();

function clientFor(cfg: OpenClawConfig, accountId?: string | null): TelexClient | null {
	const account = resolveTelexAccount({ cfg, accountId });
	return account.enabled && account.configured ? resolveTelexClient(account) : null;
}

// The bot's owner is its only approver.
function ownerId(cfg: OpenClawConfig, accountId?: string | null): string | null {
	return clientFor(cfg, accountId)?.getOwnerId() ?? null;
}

function isOwner(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
	senderId?: string | null;
}) {
	const owner = ownerId(params.cfg, params.accountId);
	return Boolean(owner && params.senderId === owner);
}

function isEnabled(params: { cfg: OpenClawConfig; accountId?: string | null }): boolean {
	return Boolean(ownerId(params.cfg, params.accountId));
}

function shouldHandle(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
	request: ApprovalRequest;
}): boolean {
	const accountId = resolveTelexAccount({
		cfg: params.cfg,
		accountId: params.accountId,
	}).accountId;
	return (
		isEnabled(params) &&
		resolveApprovalRequestChannelAccountId({
			cfg: params.cfg,
			request: params.request,
			channel: "telex",
		}) === accountId
	);
}

function approvalText(view: PendingApprovalView): string {
	const lines = [`**${view.title}**`];
	if (view.description) lines.push(view.description);
	if (view.approvalKind === "exec") {
		const fence = "`".repeat(
			Math.max(3, ...(view.commandText.match(/`+/g) ?? []).map((s) => s.length + 1)),
		);
		lines.push(`${fence}\n${view.commandText}\n${fence}`);
	}
	if (view.approvalKind === "system-agent") lines.push(view.operationSummary);
	for (const item of view.metadata) lines.push(`- ${item.label}: ${item.value}`);
	return lines.join("\n\n");
}

function approvalBlocks(view: PendingApprovalView, owner: string): TelexBlock[] {
	return [
		textBlock(approvalText(view)),
		{
			type: TelexBlockType.INTERACTION,
			interaction: {
				id: APPROVAL_INTERACTION_ID,
				mode: TelexInteractionMode.BUTTON,
				options: view.actions.map((action, index) => ({
					id: `o${index}`,
					label: action.label,
					...(STYLES[action.style] ? { style: STYLES[action.style] } : {}),
				})),
				answerer_ids: [owner],
				deadline: new Date(view.expiresAtMs).toISOString(),
			},
		},
	];
}

function expire(client: TelexClient, messageId: string): Promise<void> {
	return expireInteractions(client, messageId, [APPROVAL_INTERACTION_ID]);
}

async function ownerChatTarget(
	cfg: OpenClawConfig,
	accountId: string | null | undefined,
	request: ApprovalRequest,
): Promise<string | null> {
	const client = clientFor(cfg, accountId);
	const owner = client?.getOwnerId();
	if (!client || !owner) return null;
	const origin = request.request.turnSourceTo;
	if (request.request.turnSourceChannel !== "telex" || !origin) return owner;
	const conversation = await client.getConversation(origin).catch(() => undefined);
	const isOwnerChat =
		conversation?.kind === TelexConversationKind.CHAT && conversation.peer_id === owner;
	return isOwnerChat ? origin : owner;
}

async function retireCard(params: { cfg: OpenClawConfig; entry: CardEntry }): Promise<void> {
	const client = clientFor(params.cfg, params.entry.accountId);
	if (client && !params.entry.taken) await expire(client, params.entry.messageId);
}

const telexApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
	TelexBlock[],
	{ to: string },
	CardEntry,
	string
>({
	eventKinds: ["exec", "plugin", "system-agent"],
	availability: {
		isConfigured: isEnabled,
		shouldHandle,
	},
	presentation: {
		buildPendingPayload: ({ cfg, accountId, view }) => {
			const owner = ownerId(cfg, accountId);
			if (!owner) throw new Error("Telex bot owner unknown");
			return approvalBlocks(view, owner);
		},
		buildResolvedResult: () => ({ kind: "clear-actions" }),
		buildExpiredResult: () => ({ kind: "clear-actions" }),
	},
	transport: {
		prepareTarget: ({ plannedTarget }) => ({
			dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
			target: { to: plannedTarget.target.to },
		}),
		deliverPending: async ({
			cfg,
			accountId,
			preparedTarget,
			request,
			approvalKind,
			view,
			pendingPayload: blocks,
		}) => {
			const account = resolveTelexAccount({ cfg, accountId });
			const client = resolveTelexClient(account);
			if (!client) return null;
			const message = await client.sendMessage(
				preparedTarget.to === client.getOwnerId()
					? { peerId: preparedTarget.to, blocks }
					: { conversationId: preparedTarget.to, blocks },
			);
			return {
				accountId: account.accountId,
				messageId: message.id,
				approvalId: request.id,
				approvalKind,
				decisions: view.actions.map((action) => action.decision),
				taken: false,
			};
		},
	},
	interactions: {
		bindPending: ({ entry }) => {
			cards.set(entry.messageId, entry);
			return entry.messageId;
		},
		unbindPending: ({ binding }) => {
			cards.delete(binding);
		},
		clearPendingActions: retireCard,
		cancelDelivered: retireCard,
	},
	observe: {
		onDeliveryError: ({ error, request }) => {
			logger("outbound").error("approval card delivery failed", {
				approvalId: request.id,
				err: String(error),
			});
		},
	},
});

export const telexApprovalCapability = createApproverRestrictedNativeApprovalCapability({
	channel: "telex",
	channelLabel: "Telex",
	listAccountIds: listTelexAccountIds,
	hasApprovers: isEnabled,
	isExecAuthorizedSender: isOwner,
	isNativeDeliveryEnabled: isEnabled,
	resolveNativeDeliveryMode: () => "dm",
	requireMatchingTurnSourceChannel: true,
	resolveOriginTarget: ({ request }) =>
		request.request.turnSourceChannel === "telex" && request.request.turnSourceTo
			? { to: request.request.turnSourceTo }
			: null,
	resolveApproverDmTargets: async ({ cfg, accountId, request }) => {
		const to = await ownerChatTarget(cfg, accountId, request);
		return to ? [{ to, accountId }] : [];
	},
	notifyOriginWhenDmOnly: true,
	nativeRuntime: telexApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
});

// Only the owner gets the card; OpenClaw tells the requesting conversation where it went.
export const shouldSuppressLocalTelexApprovalPrompt: NonNullable<
	ChannelOutboundAdapter["shouldSuppressLocalPayloadPrompt"]
> = (params) =>
	shouldSuppressLocalNativeExecApprovalPrompt({
		...params,
		isNativeDeliveryEnabled: isEnabled,
		requireApprovalConfigEnabled: false,
		enforceForwardingMode: false,
	});

// The approval runtime reads the owner once, when it starts.
export function registerTelexApprovalRuntime(params: {
	channelRuntime?: ChannelRuntimeSurface;
	accountId: string;
	client: TelexClient;
	abortSignal?: AbortSignal;
}): boolean {
	if (!params.client.getOwnerId()) return false;
	registerChannelRuntimeContext({
		channelRuntime: params.channelRuntime,
		channelId: "telex",
		accountId: params.accountId,
		capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
		context: {},
		abortSignal: params.abortSignal,
	});
	return true;
}

export async function handleTelexApprovalAnswer(params: {
	cfg: OpenClawConfig;
	client: TelexClient;
	details: AnsweredDetails;
}): Promise<boolean> {
	const { cfg, client, details } = params;
	const card = cards.get(details.message_id ?? "");
	if (!card) return false;
	const interaction = details.interactions?.find((i) => i.id === APPROVAL_INTERACTION_ID);
	const answer = interaction?.answer ?? {};
	const decision = card.decisions[Number(answer.option_ids?.[0]?.slice(1))];
	const senderId = answer.answerer_id ?? "";
	if (interaction?.status !== TelexInteractionStatus.ANSWERED || !decision) {
		await expire(client, card.messageId);
		return true;
	}
	// Resolving the approval clears the card's actions, which would expire it.
	card.taken = true;
	let applied = false;
	try {
		({ applied } = await resolveApprovalOverGateway({
			cfg,
			approvalId: card.approvalId,
			approvalKind: card.approvalKind,
			decision,
			channel: "telex",
			accountId: card.accountId,
			senderId,
		}));
	} catch (err) {
		if (!isApprovalNotFoundError(err)) {
			card.taken = false;
			throw err;
		}
	}
	card.taken = applied;
	if (!applied) await expire(client, card.messageId);
	return true;
}
