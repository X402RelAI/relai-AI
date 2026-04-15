import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseConfig } from "./src/config.js";
import { buildTools } from "./src/tools/index.js";

export default definePluginEntry({
  id: "plugin-openclaw",
  name: "RelAI Marketplace",
  description:
    "Browse and call paid APIs on the RelAI marketplace, and manage your own monetised APIs (create, price, analytics, bridge).",

  register(api) {
    const config = parseConfig(api.pluginConfig);

    for (const tool of buildTools(config)) {
      api.registerTool(tool);
    }

    api.logger.info(
      `RelAI marketplace plugin loaded (api=${config.baseUrl}, timeout=${config.requestTimeoutMs}ms)`,
    );
  },
});
