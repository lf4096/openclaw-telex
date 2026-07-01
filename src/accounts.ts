import {
	DEFAULT_ACCOUNT_ID,
	type OpenClawConfig,
	normalizeAccountId,
} from "openclaw/plugin-sdk/core";
import type { ResolvedTelexAccount, TelexAccountConfig, TelexConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://voyager.ingarena.net";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
	const accounts = (cfg.channels?.telex as TelexConfig)?.accounts;
	if (!accounts || typeof accounts !== "object") {
		return [];
	}
	return Object.keys(accounts).filter(Boolean);
}

export function listTelexAccountIds(cfg: OpenClawConfig): string[] {
	const ids = listConfiguredAccountIds(cfg);
	if (ids.length === 0) {
		return [DEFAULT_ACCOUNT_ID];
	}
	return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelexAccountId(cfg: OpenClawConfig): string {
	const ids = listTelexAccountIds(cfg);
	if (ids.includes(DEFAULT_ACCOUNT_ID)) {
		return DEFAULT_ACCOUNT_ID;
	}
	return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
	cfg: OpenClawConfig,
	accountId: string,
): TelexAccountConfig | undefined {
	const accounts = (cfg.channels?.telex as TelexConfig)?.accounts;
	if (!accounts || typeof accounts !== "object") {
		return undefined;
	}
	return accounts[accountId];
}

function mergeTelexAccountConfig(cfg: OpenClawConfig, accountId: string): TelexConfig {
	const telexCfg = cfg.channels?.telex as TelexConfig | undefined;
	const { accounts: _ignored, ...base } = telexCfg ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return { ...base, ...account } as TelexConfig;
}

export function resolveTelexAccount(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
}): ResolvedTelexAccount {
	const accountId = normalizeAccountId(params.accountId);
	const telexCfg = params.cfg.channels?.telex as TelexConfig | undefined;

	const baseEnabled = telexCfg?.enabled !== false;
	const merged = mergeTelexAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const apiKey = merged.apiKey?.trim() || undefined;
	const baseUrl = merged.baseUrl?.trim() || DEFAULT_BASE_URL;
	const botId = merged.botId?.trim() || undefined;

	return {
		accountId,
		enabled,
		configured: Boolean(apiKey),
		apiKey,
		baseUrl,
		botId,
		tools: merged.tools,
		config: merged,
	};
}

export function listEnabledTelexAccounts(cfg: OpenClawConfig): ResolvedTelexAccount[] {
	return listTelexAccountIds(cfg)
		.map((accountId) => resolveTelexAccount({ cfg, accountId }))
		.filter((account) => account.enabled && account.configured);
}
