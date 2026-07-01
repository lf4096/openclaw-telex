import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["index.ts", "setup-entry.ts"],
	format: ["esm"],
	target: "node22",
	platform: "node",
	outDir: "dist",
	bundle: true,
	splitting: false,
	sourcemap: false,
	dts: false,
	clean: true,
	treeshake: true,
	minify: true,
	external: ["openclaw", /^openclaw\//, "@sinclair/typebox", "zod"],
});
