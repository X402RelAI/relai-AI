import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createSetupTool,
  createDiscoverTool,
  createApiInfoTool,
  createCallTool,
} from "./src/tools.js";
import { relaiConfigSchema, parseConfig } from "./src/config.js";

const plugin = {
  id: "plugin-openclaw",
  name: "RelAI Marketplace",
  description:
    "Browse and call paid APIs on the RelAI marketplace. Handles agent key setup, API discovery, and metered API calls.",

  configSchema: relaiConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);

    api.registerTool(createSetupTool(api, config), {
      name: "relai_setup",
    });

    api.registerTool(createDiscoverTool(api, config), {
      name: "relai_discover",
    });

    api.registerTool(createApiInfoTool(api, config), {
      name: "relai_api_info",
    });

    api.registerTool(createCallTool(api, config), {
      name: "relai_call",
    });

    api.logger.info(
      `RelAI marketplace plugin loaded (api=${config.baseUrl}, timeout=${config.requestTimeoutMs}ms)`,
    );
  },
};

export default plugin;
