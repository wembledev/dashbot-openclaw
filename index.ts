import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk"

import { dashbotPlugin } from "./src/channel.js"
import { setDashbotRuntime } from "./src/runtime.js"

const plugin = {
  id: "dashbot",
  name: "DashBot",
  description: "DashBot dashboard channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDashbotRuntime(api.runtime)
    api.registerChannel({ plugin: dashbotPlugin })
  },
}

export default plugin
