import {
	type ChannelSetupDmPolicy,
	type ChannelSetupWizard,
	DEFAULT_ACCOUNT_ID,
	type OpenClawConfig,
	createStandardChannelSetupStatus,
	createTopLevelChannelDmPolicy,
	mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
import { probeTelex } from "./probe.js";
import type { TelexConfig } from "./types.js";

const channel = "telex" as const;
const DEFAULT_BASE_URL = "https://voyager.ingarena.net";

function getTelexCfg(cfg: OpenClawConfig): TelexConfig | undefined {
	return cfg.channels?.telex as TelexConfig | undefined;
}

function parseAllowFromInput(raw: string): string[] {
	return raw
		.split(/[\n,;]+/g)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

async function promptTelexAllowFrom(params: {
	cfg: OpenClawConfig;
	prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
	const { cfg, prompter } = params;
	const existing = getTelexCfg(cfg)?.allowFrom ?? [];
	await prompter.note(
		[
			"Allowlist Telex DMs by identity id or email.",
			"Examples:",
			"- 0a1b2c3d4e5f6071 (identity id, 16-char hex)",
			"- alice@company.com",
		].join("\n"),
		"Telex allowlist",
	);

	while (true) {
		const entry = await prompter.text({
			message: "Telex allowFrom (identity ids or emails)",
			placeholder: "alice@company.com, 0a1b2c3d4e5f6071",
			initialValue: existing[0] ? String(existing[0]) : undefined,
			validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
		});
		const parts = parseAllowFromInput(String(entry));
		if (parts.length === 0) {
			await prompter.note("Enter at least one user.", "Telex allowlist");
			continue;
		}
		const unique = mergeAllowFromEntries(
			existing.map((v) => String(v)),
			parts,
		);
		return {
			...cfg,
			channels: { ...cfg.channels, telex: { ...cfg.channels?.telex, allowFrom: unique } },
		} as OpenClawConfig;
	}
}

const telexDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
	label: "Telex",
	channel,
	policyKey: "channels.telex.dmPolicy",
	allowFromKey: "channels.telex.allowFrom",
	getCurrent: (cfg) => getTelexCfg(cfg as OpenClawConfig)?.dmPolicy ?? "allowlist",
	promptAllowFrom: async ({ cfg, prompter }) =>
		promptTelexAllowFrom({ cfg: cfg as OpenClawConfig, prompter }),
});

async function promptCredentials(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
	currentBaseUrl: string,
): Promise<{ apiKey: string; baseUrl: string }> {
	const apiKey = String(
		await prompter.text({
			message: "Enter Telex bot API key (x-api-key)",
			validate: (value) => (value?.trim() ? undefined : "Required"),
		}),
	).trim();
	const baseUrl = String(
		await prompter.text({
			message: "Voyager API base URL",
			initialValue: currentBaseUrl || DEFAULT_BASE_URL,
			validate: (value) => {
				const v = String(value ?? "").trim();
				if (!v) return "Required";
				if (!v.startsWith("http://") && !v.startsWith("https://"))
					return "Must be an http(s) URL";
				return undefined;
			},
		}),
	).trim();
	return { apiKey, baseUrl };
}

async function noteTelexCredentialHelp(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
	await prompter.note(
		[
			"1) Open Voyager Telex and register a bot (Settings -> Bots -> Register).",
			"2) Copy the one-time plaintext API key shown on registration.",
			"3) The base URL is your Voyager host (default https://voyager.ingarena.net).",
		].join("\n"),
		"Telex credentials",
	);
}

export const telexSetupWizard: ChannelSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "Telex",
		configuredLabel: "configured",
		unconfiguredLabel: "needs an API key",
		configuredHint: "configured",
		unconfiguredHint: "needs api key",
		configuredScore: 2,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => Boolean(getTelexCfg(cfg)?.apiKey?.trim()),
	}),
	credentials: [],
	finalize: async ({ cfg, prompter, forceAllowFrom }) => {
		let next = cfg;
		const telexCfg = getTelexCfg(next);
		const hasApiKey = Boolean(telexCfg?.apiKey?.trim());
		const currentBaseUrl = telexCfg?.baseUrl?.trim() || DEFAULT_BASE_URL;

		let apiKey: string | null = null;
		let baseUrl = currentBaseUrl;

		if (!hasApiKey) {
			await noteTelexCredentialHelp(prompter);
			({ apiKey, baseUrl } = await promptCredentials(prompter, currentBaseUrl));
		} else {
			const keep = await prompter.confirm({
				message: "Telex API key already configured. Keep it?",
				initialValue: true,
			});
			if (!keep) {
				({ apiKey, baseUrl } = await promptCredentials(prompter, currentBaseUrl));
			}
		}

		if (apiKey) {
			next = {
				...next,
				channels: {
					...next.channels,
					telex: {
						...next.channels?.telex,
						enabled: true,
						apiKey,
						baseUrl,
						dmPolicy: telexCfg?.dmPolicy ?? "allowlist",
					},
				},
			} as OpenClawConfig;

			const probe = await probeTelex({ apiKey, baseUrl }).catch((err) => ({
				ok: false as const,
				error: String(err),
			}));
			await prompter.note(
				probe.ok
					? `Connected successfully (latency: ${probe.latencyMs}ms)`
					: `Connection failed: ${probe.error ?? "unknown error"}`,
				"Telex connection test",
			);
		}

		const groupPolicyChoice = await prompter.select({
			message: "Channel policy",
			options: [
				{ value: "disabled", label: "Disabled - ignore all channel messages (default)" },
				{ value: "allowlist", label: "Allowlist - respond only in specific channels" },
				{ value: "open", label: "Open - respond in all channels the bot joins" },
			],
			initialValue: getTelexCfg(next)?.groupPolicy ?? "disabled",
		});
		const groupPolicy = String(groupPolicyChoice) as "disabled" | "allowlist" | "open";
		next = {
			...next,
			channels: { ...next.channels, telex: { ...next.channels?.telex, groupPolicy } },
		} as OpenClawConfig;

		if (groupPolicy === "allowlist") {
			const existingGroups = getTelexCfg(next)?.groupAllowFrom ?? [];
			const groupInput = await prompter.text({
				message: "Allowed channel (conversation) ids (comma-separated)",
				placeholder: "0a1b2c3d4e5f6071, 1122334455667788",
				initialValue: existingGroups.length > 0 ? existingGroups.join(", ") : undefined,
				validate: (value) =>
					String(value ?? "").trim() ? undefined : "Enter at least one channel id",
			});
			next = {
				...next,
				channels: {
					...next.channels,
					telex: {
						...next.channels?.telex,
						groupAllowFrom: parseAllowFromInput(String(groupInput)),
					},
				},
			} as OpenClawConfig;
		}

		if (groupPolicy !== "disabled") {
			const wantSenderFilter = await prompter.confirm({
				message: "Restrict which users can trigger the bot in channels? (sender allowlist)",
				initialValue: true,
			});
			if (wantSenderFilter) {
				const existingSenders = getTelexCfg(next)?.groupSenderAllowFrom ?? [];
				const senderInput = await prompter.text({
					message: "Sender allowlist (identity ids or emails, comma-separated)",
					placeholder: "alice@company.com, 0a1b2c3d4e5f6071",
					initialValue:
						existingSenders.length > 0 ? existingSenders.join(", ") : undefined,
					validate: (value) =>
						String(value ?? "").trim() ? undefined : "Enter at least one user",
				});
				next = {
					...next,
					channels: {
						...next.channels,
						telex: {
							...next.channels?.telex,
							groupSenderAllowFrom: parseAllowFromInput(String(senderInput)),
						},
					},
				} as OpenClawConfig;
			}
		}

		const processingIndicator = await prompter.select({
			message: "Processing indicator",
			options: [
				{
					value: "activity",
					label: "Activity - show a processing status while working (default)",
				},
				{ value: "off", label: "Off - no processing indicator" },
			],
			initialValue: getTelexCfg(next)?.processingIndicator ?? "activity",
		});
		next = {
			...next,
			channels: {
				...next.channels,
				telex: {
					...next.channels?.telex,
					processingIndicator: String(processingIndicator),
				},
			},
		} as OpenClawConfig;

		if (forceAllowFrom) {
			next = await promptTelexAllowFrom({ cfg: next, prompter });
		}

		return { cfg: next };
	},
	dmPolicy: telexDmPolicy,
	disable: (cfg) => ({
		...cfg,
		channels: { ...cfg.channels, telex: { ...cfg.channels?.telex, enabled: false } },
	}),
};
