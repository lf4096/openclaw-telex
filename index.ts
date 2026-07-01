import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { telexPlugin } from "./src/channel.js";
import { setTelexRuntime } from "./src/runtime.js";
import { registerTelexTool } from "./src/tool.js";

export default defineChannelPluginEntry({
	id: "telex",
	name: "Telex",
	description: "Telex channel plugin",
	plugin: telexPlugin,
	setRuntime: setTelexRuntime,
	registerFull: (api) => registerTelexTool(api),
});
