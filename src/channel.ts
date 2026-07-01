import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-plugin-common";
import {
	type ChannelPlugin,
	DEFAULT_ACCOUNT_ID,
	type OpenClawConfig,
	buildChannelConfigSchema,
} from "openclaw/plugin-sdk/core";
import {
	listTelexAccountIds,
	resolveDefaultTelexAccountId,
	resolveTelexAccount,
} from "./accounts.js";
import { resolveTelexClient } from "./client.js";
import { TelexConfigSchema } from "./config-schema.js";
import { telexOutbound } from "./outbound.js";
import { probeTelex } from "./probe.js";
import { textBlock } from "./send.js";
import { resolveTelexOutboundSessionRoute } from "./session-route.js";
import { telexSetupWizard } from "./setup-surface.js";
import { looksLikeTelexId, normalizeTelexTarget } from "./targets.js";
import type { ResolvedTelexAccount, TelexConfig } from "./types.js";

const meta = {
	id: "telex",
	label: "Telex",
	selectionLabel: "Telex (plugin)",
	blurb: "Voyager Telex messaging integration.",
	docsPath: "/channels/telex",
	aliases: [],
	order: 75,
	quickstartAllowFrom: true,
};

export const telexPlugin: ChannelPlugin<ResolvedTelexAccount> = {
	id: "telex",
	meta,
	pairing: {
		idLabel: "identityId",
		normalizeAllowEntry: createPairingPrefixStripper(/^(telex|tx):/i),
		notifyApproval: async ({ cfg, id }) => {
			const accountId = resolveDefaultTelexAccountId(cfg);
			const account = resolveTelexAccount({ cfg, accountId });
			const client = resolveTelexClient(account);
			if (!client) return;
			await client.sendMessage({ peerId: id, blocks: [textBlock(PAIRING_APPROVED_MESSAGE)] });
		},
	},
	capabilities: {
		chatTypes: ["direct", "channel"],
		polls: false,
		threads: false,
		media: true,
		reactions: false,
		edit: false,
		reply: false,
	},
	reload: { configPrefixes: ["channels.telex"] },
	configSchema: buildChannelConfigSchema(TelexConfigSchema),
	config: {
		listAccountIds: (cfg) => listTelexAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveTelexAccount({ cfg, accountId }),
		defaultAccountId: (cfg) => resolveDefaultTelexAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			const isDefault = accountId === DEFAULT_ACCOUNT_ID;
			if (isDefault) {
				return {
					...cfg,
					channels: { ...cfg.channels, telex: { ...cfg.channels?.telex, enabled } },
				};
			}
			const telexCfg = cfg.channels?.telex as TelexConfig | undefined;
			return {
				...cfg,
				channels: {
					...cfg.channels,
					telex: {
						...telexCfg,
						accounts: {
							...telexCfg?.accounts,
							[accountId]: { ...telexCfg?.accounts?.[accountId], enabled },
						},
					},
				},
			};
		},
		deleteAccount: ({ cfg, accountId }) => {
			const isDefault = accountId === DEFAULT_ACCOUNT_ID;
			if (isDefault) {
				const next = { ...cfg } as OpenClawConfig;
				const nextChannels = { ...cfg.channels } as Record<string, unknown>;
				nextChannels.telex = undefined;
				const hasOtherChannels = Object.values(nextChannels).some((v) => v !== undefined);
				next.channels = hasOtherChannels ? nextChannels : undefined;
				return next;
			}
			const telexCfg = cfg.channels?.telex as TelexConfig | undefined;
			const accounts = { ...telexCfg?.accounts };
			delete accounts[accountId];
			return {
				...cfg,
				channels: {
					...cfg.channels,
					telex: {
						...telexCfg,
						accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
					},
				},
			};
		},
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.baseUrl,
		}),
		resolveAllowFrom: ({ cfg, accountId }) => {
			const account = resolveTelexAccount({ cfg, accountId });
			return (account.config?.allowFrom ?? []).map((entry) => String(entry));
		},
		formatAllowFrom: ({ allowFrom }) =>
			allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
	},
	security: {
		collectWarnings: ({ cfg, accountId }) => {
			const account = resolveTelexAccount({ cfg, accountId });
			const dmPolicy = account.config?.dmPolicy ?? "allowlist";
			if (dmPolicy !== "open") return [];
			return [
				`- Telex[${account.accountId}]: dmPolicy="open" lets any identity message the bot. Set channels.telex.dmPolicy to "allowlist" or "pairing" to restrict senders.`,
			];
		},
	},
	setup: {
		resolveAccountId: () => DEFAULT_ACCOUNT_ID,
		applyAccountConfig: ({ cfg, accountId }) => {
			const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
			if (isDefault) {
				return {
					...cfg,
					channels: { ...cfg.channels, telex: { ...cfg.channels?.telex, enabled: true } },
				};
			}
			const telexCfg = cfg.channels?.telex as TelexConfig | undefined;
			return {
				...cfg,
				channels: {
					...cfg.channels,
					telex: {
						...telexCfg,
						accounts: {
							...telexCfg?.accounts,
							[accountId]: { ...telexCfg?.accounts?.[accountId], enabled: true },
						},
					},
				},
			};
		},
	},
	setupWizard: telexSetupWizard,
	messaging: {
		normalizeTarget: (raw) => normalizeTelexTarget(raw) ?? undefined,
		resolveOutboundSessionRoute: (params) => resolveTelexOutboundSessionRoute(params),
		targetResolver: {
			looksLikeId: looksLikeTelexId,
			hint: "<conversation_id> (16-char hex)",
		},
	},
	outbound: telexOutbound,
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null,
		},
		buildChannelSummary: ({ snapshot }) => ({
			configured: snapshot.configured ?? false,
			running: snapshot.running ?? false,
			lastStartAt: snapshot.lastStartAt ?? null,
			lastStopAt: snapshot.lastStopAt ?? null,
			lastError: snapshot.lastError ?? null,
			probe: snapshot.probe,
			lastProbeAt: snapshot.lastProbeAt ?? null,
		}),
		probeAccount: ({ account }) =>
			probeTelex({ apiKey: account.apiKey, baseUrl: account.baseUrl }),
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			baseUrl: account.baseUrl,
			running: runtime?.running ?? false,
			lastStartAt: runtime?.lastStartAt ?? null,
			lastStopAt: runtime?.lastStopAt ?? null,
			lastError: runtime?.lastError ?? null,
			probe,
		}),
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = resolveTelexAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
			ctx.setStatus({ accountId: ctx.accountId });
			ctx.log?.info(`starting telex[${ctx.accountId}] (subscribe -> ${account.baseUrl})`);
			const { monitorTelexProvider } = await import("./monitor.js");
			return monitorTelexProvider({
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal,
				accountId: ctx.accountId,
			});
		},
	},
};
