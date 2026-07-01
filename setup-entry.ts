import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { telexPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(telexPlugin);
