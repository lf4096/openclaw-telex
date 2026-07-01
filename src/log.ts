import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

type Meta = Record<string, unknown>;

export type Logger = {
	debug: (message: string, meta?: Meta) => void;
	info: (message: string, meta?: Meta) => void;
	warn: (message: string, meta?: Meta) => void;
	error: (message: string, meta?: Meta) => void;
};

const cache = new Map<string, Logger>();

// createSubsystemLogger feeds the gateway's file + console sinks (visible in
// `openclaw logs` / journald) and preserves meta; a plain runtime-env
// getChildLogger does not surface from channel-plugin code.
export function logger(module: string): Logger {
	const hit = cache.get(module);
	if (hit) return hit;
	const log = createSubsystemLogger(`telex/${module}`);
	cache.set(module, log);
	return log;
}
