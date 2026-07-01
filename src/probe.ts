import { getTelexClient } from "./client.js";
import type { TelexProbeResult } from "./types.js";

export async function probeTelex(params?: {
	apiKey?: string;
	baseUrl?: string;
}): Promise<TelexProbeResult> {
	if (!params?.apiKey || !params?.baseUrl) {
		return { ok: false, error: "missing credentials (apiKey, baseUrl)" };
	}

	try {
		const client = getTelexClient(params.apiKey, params.baseUrl);
		const start = Date.now();
		await client.getIdentities([], []);
		return { ok: true, latencyMs: Date.now() - start };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
