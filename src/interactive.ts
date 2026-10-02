import {
	cancelPendingAgentQuestionForSession,
	claimPendingAgentQuestionAnswer,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
	type MessagePresentation,
	normalizeMessagePresentation,
	renderPresentationForDelivery,
	resolveMessagePresentationButtonAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelexClient } from "./client.js";
import { logger } from "./log.js";
import { textBlock } from "./send.js";
import {
	type ResolvedTelexAccount,
	type TelexBlock,
	TelexBlockType,
	TelexConversationKind,
	type TelexInteraction,
	TelexInteractionMode,
	type TelexInteractionOption,
	TelexInteractionStatus,
	type TelexMessage,
	TelexMessageFlag,
	labelMap,
	telexTimeMs,
} from "./types.js";

const ANSWERED_EVENT = "interaction_answered";
const QUESTION_INTERACTION_ID = "question";

type TelexCard = {
	blocks: TelexBlock[];
	questionId: string;
	optionValues: string[];
};

type Prompt = {
	questionId: string;
	optionValues: string[];
	sessionKey: string;
	expiresAt: number;
};

const prompts = new Map<string, Prompt>();

function remember(messageId: string, prompt: Prompt): void {
	const now = Date.now();
	for (const [id, waiting] of prompts) {
		if (waiting.expiresAt <= now) prompts.delete(id);
	}
	prompts.set(messageId, prompt);
}

function take(messageId: string): Prompt | undefined {
	const prompt = prompts.get(messageId);
	prompts.delete(messageId);
	return prompt;
}

// The first text block is the question; the next is the option list and the typed-reply guidance.
// A question's link is background for it, not an answer.
function renderTelexCard(
	payload: ReplyPayload,
	presentation: MessagePresentation,
): TelexCard | null {
	const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
	const question = presentation.blocks.find((block) => block.type === "text");
	if (!questionId || question?.type !== "text") return null;
	const links: TelexBlock[] = [];
	const options: TelexInteractionOption[] = [];
	const optionValues: string[] = [];
	let freeText = false;
	for (const block of presentation.blocks) {
		if (block.type !== "buttons") continue;
		for (const button of block.buttons) {
			const action = resolveMessagePresentationButtonAction(button);
			if (action?.type === "url") {
				links.push(textBlock(`[${button.label}](${action.url})`));
			} else if (action?.type === "question" && "optionValue" in action) {
				options.push({ id: `o${optionValues.length}`, label: button.label });
				optionValues.push(action.optionValue);
			} else if (action?.type === "question") {
				freeText = true;
			} else {
				return null;
			}
		}
	}
	if (options.length === 0) return null;
	const interaction: TelexInteraction = {
		id: QUESTION_INTERACTION_ID,
		mode: TelexInteractionMode.SELECT,
		questions: [
			{ text: question.text, options, ...(freeText ? { allow_free_text: true } : {}) },
		],
	};
	return {
		blocks: [...links, { type: TelexBlockType.INTERACTION, interaction }],
		questionId,
		optionValues,
	};
}

export async function renderTelexReply(
	payload: ReplyPayload,
): Promise<{ card: TelexCard | null; text?: string }> {
	const presentation = normalizeMessagePresentation(payload.presentation);
	if (!presentation) return { card: null };
	const { text } = await renderPresentationForDelivery({}, payload);
	return { card: renderTelexCard(payload, presentation), text };
}

// In a Channel limited to some senders only they may answer, and Telex takes only members as
// answerers; a Chat has one other member.
async function answererIdsFor(
	client: TelexClient,
	account: ResolvedTelexAccount,
	conversationId: string,
): Promise<string[]> {
	const allowed = (account.config.groupSenderAllowFrom ?? []).map((entry) => entry.trim());
	if (allowed.length === 0 || allowed.includes("*")) return [];
	const conversation = await client.getConversation(conversationId);
	if (conversation.kind !== TelexConversationKind.CHANNEL) return [];
	const emails = allowed.filter((entry) => entry.includes("@"));
	const ids = allowed.filter((entry) => entry && !entry.includes("@"));
	if (emails.length > 0) {
		ids.push(...(await client.getIdentities([], emails)).map((identity) => identity.id));
	}
	const members = new Set((await client.listMembers(conversationId)).map((m) => m.identity_id));
	const listed = [...new Set(ids)].filter((id) => members.has(id));
	if (listed.length === 0) throw new Error("groupSenderAllowFrom matches no channel member");
	return listed;
}

export async function closeInteraction(
	client: TelexClient,
	messageId: string,
	interactionId: string,
): Promise<void> {
	try {
		await client.closeInteraction(messageId, interactionId);
	} catch (err) {
		logger("outbound").warn("interaction close failed", { messageId, err: String(err) });
	}
}

export async function sendTelexCard(params: {
	client: TelexClient;
	account: ResolvedTelexAccount;
	conversationId: string;
	sessionKey: string;
	card: TelexCard;
	quoteId?: string;
}): Promise<TelexMessage | undefined> {
	const { client, account, conversationId, sessionKey, card, quoteId } = params;
	let message: TelexMessage;
	try {
		const answererIds = await answererIdsFor(client, account, conversationId);
		const blocks = card.blocks.map((block) =>
			block.interaction && answererIds.length > 0
				? { ...block, interaction: { ...block.interaction, answerer_ids: answererIds } }
				: block,
		);
		message = await client.sendMessage({ conversationId, quoteId, blocks });
	} catch (err) {
		logger("outbound").warn("question card refused", {
			accountId: account.accountId,
			conversationId,
			err: String(err),
		});
		return undefined;
	}
	remember(message.id, {
		questionId: card.questionId,
		optionValues: card.optionValues,
		sessionKey,
		expiresAt: telexTimeMs(
			message.data.blocks.find((block) => block.interaction)?.interaction?.deadline,
		),
	});
	questionGatewayRuntime.registerChannelDelivery({
		questionId: card.questionId,
		deliveryId: `telex:${account.accountId}:${message.id}`,
		finalize: async () => {
			if (take(message.id))
				await closeInteraction(client, message.id, QUESTION_INTERACTION_ID);
		},
	});
	return message;
}

export type AnsweredDetails = {
	message_id?: string;
	asker_id?: string;
	interaction?: TelexInteraction;
};

export function answeredDetails(
	message: TelexMessage,
	selfId: string | null,
): AnsweredDetails | undefined {
	if (!selfId || (message.flags & TelexMessageFlag.EVENT) === 0) return undefined;
	// A fork copies the events of its source.
	if ((message.flags & TelexMessageFlag.FORK_PREFIX) !== 0) return undefined;
	const event = message.data.blocks.find((block) => block.type === TelexBlockType.EVENT)?.event;
	const details = event?.details as AnsweredDetails | undefined;
	if (event?.kind !== ANSWERED_EVENT || details?.asker_id !== selfId) return undefined;
	return details;
}

async function acceptAnswer(
	cfg: OpenClawConfig,
	prompt: Prompt,
	interaction: TelexInteraction,
): Promise<boolean> {
	const senderId = interaction.answerer_id ?? "";
	const answer = interaction.questions[0]?.answer ?? {};
	const { sessionKey } = prompt;
	if (interaction.status === TelexInteractionStatus.SKIPPED) {
		return cancelPendingAgentQuestionForSession({ sessionKey, resolvedBy: senderId });
	}
	const optionValue = prompt.optionValues[Number(answer.option_ids?.[0]?.slice(1))];
	if (optionValue) {
		const result = await questionGatewayRuntime.resolveOption({
			cfg,
			questionId: prompt.questionId,
			optionValue,
			senderId,
			clientDisplayName: "Telex question",
		});
		return result.status === "answered";
	}
	const text = answer.text?.trim();
	return text ? claimPendingAgentQuestionAnswer({ sessionKey, text }) : false;
}

// An answer the runtime did not take closes the card, so it does not read as accepted.
export async function handleTelexAnswer(params: {
	cfg: OpenClawConfig;
	client: TelexClient;
	details: AnsweredDetails;
}): Promise<void> {
	const { cfg, client, details } = params;
	const messageId = details.message_id ?? "";
	const interaction = details.interaction;
	if (!interaction) return;
	// Resolving the question runs its finalize, which would close the card.
	const prompt = take(messageId);
	if (!prompt) {
		if (interaction.status === TelexInteractionStatus.ANSWERED) {
			await closeInteraction(client, messageId, interaction.id);
		}
		return;
	}
	let accepted: boolean;
	try {
		accepted = await acceptAnswer(cfg, prompt, interaction);
	} catch (err) {
		prompts.set(messageId, prompt);
		throw err;
	}
	if (!accepted) await closeInteraction(client, messageId, interaction.id);
}

const interactionStatusLabel = labelMap(TelexInteractionStatus);

function interactionMarkup(
	messageId: string,
	interaction: TelexInteraction,
	selfId: string | null,
	asked: boolean,
): string {
	const recorded = interaction.status ?? TelexInteractionStatus.OPEN;
	const status =
		recorded === TelexInteractionStatus.OPEN &&
		interaction.deadline &&
		telexTimeMs(interaction.deadline) <= Date.now()
			? TelexInteractionStatus.EXPIRED
			: recorded;
	const answererIds = interaction.answerer_ids ?? [];
	const answerable =
		status === TelexInteractionStatus.OPEN &&
		((selfId !== null && answererIds.includes(selfId)) || (asked && answererIds.length === 0));
	const attrs: [string, string | number][] = answerable
		? [
				["message_id", messageId],
				["interaction_id", interaction.id],
			]
		: [];
	attrs.push(["status", interactionStatusLabel[status] ?? status]);
	if (interaction.answerer_id) attrs.push(["answerer", interaction.answerer_id]);
	const lines = [`<interaction ${markupAttrs(attrs)}>`];
	for (const question of interaction.questions) {
		const flags: [string, string][] = [];
		if (answerable && question.multi_select) flags.push(["multi_select", "true"]);
		if (answerable && question.allow_free_text) flags.push(["free_text", "true"]);
		lines.push(flags.length > 0 ? `<question ${markupAttrs(flags)}>` : "<question>");
		if (question.text) lines.push(question.text);
		const labels = new Map<string, string>();
		for (const option of question.options ?? []) {
			labels.set(option.id, option.label);
			let line = answerable ? `- ${option.id}: ${option.label}` : `- ${option.label}`;
			if (option.description) line += ` (${option.description})`;
			lines.push(line);
		}
		const answer = question.answer ?? {};
		const chosen = (answer.option_ids ?? []).map((id) => labels.get(id) ?? id);
		if (answer.text) chosen.push(answer.text);
		if (chosen.length > 0) lines.push(`answer: ${chosen.join(", ")}`);
		lines.push("</question>");
	}
	lines.push("</interaction>");
	return lines.join("\n");
}

function markupAttrs(attrs: [string, string | number][]): string {
	return attrs.map(([key, value]) => `${key}="${value}"`).join(" ");
}

// A Chat message asks its other member; a Channel message asks the members it mentions.
// Telex refuses answers on a fork's copy, and the agent's own question is for the person it asked.
export function messageInteractionMarkup(
	message: TelexMessage,
	interaction: TelexInteraction,
	selfId: string | null,
	direct: boolean,
): string {
	if (
		selfId === null ||
		message.sender_id === selfId ||
		(message.flags & TelexMessageFlag.FORK_PREFIX) !== 0
	) {
		return interactionMarkup(message.id, interaction, null, false);
	}
	const asked =
		direct ||
		Boolean(message.data.mention_all) ||
		(message.data.mention_ids ?? []).includes(selfId);
	return interactionMarkup(message.id, interaction, selfId, asked);
}
