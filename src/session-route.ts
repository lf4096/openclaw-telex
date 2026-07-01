import {
	type ChannelOutboundSessionRouteParams,
	buildChannelOutboundSessionRoute,
	stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/core";
import { resolveTelexAccount } from "./accounts.js";
import { resolveTelexClient } from "./client.js";
import { TelexConversationKind } from "./types.js";

// A Telex conversation id does not encode chat vs channel, so derive the kind via
// getConversation (cache-first, fetches + caches on miss). On lookup failure
// (unknown id / API error) fall back to "channel" (isolated session).
async function resolveChatType(
	params: ChannelOutboundSessionRouteParams,
	conversationId: string,
): Promise<"direct" | "channel"> {
	const account = resolveTelexAccount({ cfg: params.cfg, accountId: params.accountId });
	const client = resolveTelexClient(account);
	if (!client) return "channel";
	const conversation = await client.getConversation(conversationId).catch(() => undefined);
	return conversation?.kind === TelexConversationKind.CHAT ? "direct" : "channel";
}

export async function resolveTelexOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
	const trimmed = stripChannelTargetPrefix(params.target, "telex");
	if (!trimmed) {
		return null;
	}

	const chatType = await resolveChatType(params, trimmed);

	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "telex",
		accountId: params.accountId,
		peer: { kind: chatType, id: trimmed },
		chatType,
		from: `telex:${trimmed}`,
		to: trimmed,
	});
}
