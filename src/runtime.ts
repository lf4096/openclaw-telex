import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setTelexRuntime(next: PluginRuntime) {
	runtime = next;
}

export function getTelexRuntime(): PluginRuntime {
	if (!runtime) {
		throw new Error("Telex runtime not initialized");
	}
	return runtime;
}
