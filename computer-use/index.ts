/**
 * computer-use (pi-ex): desktop automation tools (screenshot/mouse/keyboard),
 * migrated from pi-ex core's ComputerUseIntegration.
 *
 * Registers nothing on unsupported platforms (Hyprland/Wayland + grim/
 * ydotool/wtype/hyprctl required) or when computerUse.enabled=false.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getForkHost } from "@earendil-works/pi-coding-agent";
import { ComputerUseIntegration, isComputerUseSupported } from "./lib/integration.ts";

export default function (pi: ExtensionAPI) {
	if (!isComputerUseSupported()) return;

	const integration = new ComputerUseIntegration();
	const tools = integration.getToolDefinitions();

	pi.on("session_start", (_event, ctx) => {
		const host = getForkHost(ctx.sessionManager);
		if (host && !host.settingsManager.getComputerUseEnabled()) return;
		for (const definition of tools) {
			pi.registerTool(definition);
		}
	});
}
