import path from "node:path";
import { defineConfig } from "vitest/config";

const piEx = path.resolve(__dirname, "../../pi-ex/packages");

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": path.join(piEx, "coding-agent/src/index.ts"),
			"@earendil-works/pi-agent-core/node": path.join(piEx, "agent/src/node.ts"),
			"@earendil-works/pi-agent-core": path.join(piEx, "agent/src/index.ts"),
			"@earendil-works/pi-ai/providers/all": path.join(piEx, "ai/src/providers/all.ts"),
			"@earendil-works/pi-ai/compat": path.join(piEx, "ai/src/compat.ts"),
			"@earendil-works/pi-ai/oauth": path.join(piEx, "ai/src/oauth.ts"),
			"@earendil-works/pi-ai": path.join(piEx, "ai/src/index.ts"),
		},
	},
	test: {
		include: [__dirname + "/**/*.test.ts"],
		testTimeout: 15000,
	},
});
