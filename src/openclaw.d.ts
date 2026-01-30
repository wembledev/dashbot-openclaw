declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    runtime: unknown
    registerChannel(registration: { plugin: unknown }): void
  }

  export function emptyPluginConfigSchema(): {
    safeParse(value: unknown): { success: boolean; data?: unknown }
    jsonSchema: Record<string, unknown>
  }
}
