import type { DashbotConfig, CableMessage } from "./types.js"
import { DashbotConnection } from "./connection.js"
import { createOutbound } from "./outbound.js"
import { getDashbotRuntime } from "./runtime.js"
import { StatusReporter } from "./status-reporter.js"

const DEFAULT_ACCOUNT_ID = "default"

// Resolved account from config
export interface DashbotAccount {
  accountId: string
  name: string
  enabled: boolean
  url: string
  token: string
  config: { url: string; token: string; enabled?: boolean }
}

// OpenClaw gateway context passed to startAccount
export interface GatewayContext {
  cfg: Record<string, unknown>
  accountId: string
  account: DashbotAccount
  runtime: Record<string, unknown>
  abortSignal: AbortSignal
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void }
  getStatus: () => Record<string, unknown>
  setStatus: (next: Record<string, unknown>) => void
}

// Kept for backward compatibility with tests
export interface ChannelContext {
  config: DashbotConfig
  runtime: {
    handleIncomingMessage(message: {
      channelId: string
      text: string
      senderId: string
      metadata?: Record<string, unknown>
    }): void
  }
}

function getDashbotChannelConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const channels = cfg.channels as Record<string, unknown> | undefined
  return (channels?.dashbot as Record<string, unknown>) ?? {}
}

function resolveAccount(cfg: Record<string, unknown>, accountId: string): DashbotAccount {
  const channelCfg = getDashbotChannelConfig(cfg)

  let source: Record<string, unknown>
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const accounts = (channelCfg.accounts ?? {}) as Record<string, unknown>
    source = (accounts[accountId] ?? {}) as Record<string, unknown>
  } else {
    source = channelCfg
  }

  return {
    accountId,
    name: accountId === DEFAULT_ACCOUNT_ID ? "DashBot" : `DashBot (${accountId})`,
    enabled: source.enabled !== false,
    url: String(source.url ?? ""),
    token: String(source.token ?? ""),
    config: {
      url: String(source.url ?? ""),
      token: String(source.token ?? ""),
      enabled: source.enabled !== false,
    },
  }
}

export const dashbotPlugin = {
  id: "dashbot",

  meta: {
    id: "dashbot",
    label: "DashBot",
    selectionLabel: "DashBot (Action Cable)",
    detailLabel: "DashBot Dashboard",
    blurb: "Real-time dashboard channel via Action Cable WebSocket.",
    order: 100,
  },

  capabilities: {
    chatTypes: ["direct"],
  },

  config: {
    listAccountIds: (cfg: Record<string, unknown>) => {
      const channelCfg = getDashbotChannelConfig(cfg)
      const accounts = (channelCfg.accounts ?? {}) as Record<string, unknown>
      return [DEFAULT_ACCOUNT_ID, ...Object.keys(accounts)]
    },
    resolveAccount: (cfg: Record<string, unknown>, accountId: string) => resolveAccount(cfg, accountId),
    defaultAccountId: (_cfg: Record<string, unknown>) => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: DashbotAccount) => Boolean(account.url?.trim() && account.token?.trim()),
    isEnabled: (account: DashbotAccount) => account.enabled !== false,
    describeAccount: (account: DashbotAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url?.trim() && account.token?.trim()),
    }),
    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: Record<string, unknown>; accountId: string; enabled: boolean }) => {
      const channels = (cfg.channels ?? {}) as Record<string, unknown>
      const dashbot = (channels.dashbot ?? {}) as Record<string, unknown>
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        const accounts = (dashbot.accounts ?? {}) as Record<string, unknown>
        const acct = (accounts[accountId] ?? {}) as Record<string, unknown>
        return { ...cfg, channels: { ...channels, dashbot: { ...dashbot, accounts: { ...accounts, [accountId]: { ...acct, enabled } } } } }
      }
      return { ...cfg, channels: { ...channels, dashbot: { ...dashbot, enabled } } }
    },
    deleteAccount: ({ cfg, accountId }: { cfg: Record<string, unknown>; accountId: string }) => {
      const channels = { ...(cfg.channels as Record<string, unknown>) }
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        const dashbot = { ...(channels.dashbot as Record<string, unknown>) }
        const accounts = { ...(dashbot.accounts as Record<string, unknown>) }
        delete accounts[accountId]
        dashbot.accounts = accounts
        channels.dashbot = dashbot
        return { ...cfg, channels }
      }
      delete channels.dashbot
      return { ...cfg, channels }
    },
    resolveAllowFrom: () => [] as string[],
    formatAllowFrom: ({ allowFrom }: { allowFrom: string[] }) => allowFrom,
  },

  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) => {
      if (text.length <= limit) return [text]
      const chunks: string[] = []
      for (let i = 0; i < text.length; i += limit) {
        chunks.push(text.slice(i, i + limit))
      }
      return chunks
    },
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps }: {
      to: string
      text: string
      accountId?: string
      deps?: Record<string, unknown>
      replyToId?: string
      threadId?: string
    }) => {
      const cfg = deps?.cfg as Record<string, unknown> | undefined
      if (!cfg) return { channel: "dashbot", ok: false, error: "no config" }
      const account = resolveAccount(cfg, accountId ?? DEFAULT_ACCOUNT_ID)
      const dashbotConfig: DashbotConfig = { url: account.url, token: account.token }
      const outbound = createOutbound(null, dashbotConfig)
      outbound.sendText(text)
      return { channel: "dashbot", ok: true, to }
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    probeAccount: async ({ account }: { account: DashbotAccount; timeoutMs?: number }) => {
      if (!account.url || !account.token) return { ok: false, error: "not configured" }
      try {
        const res = await fetch(`${account.url.replace(/\/$/, "")}/up`)
        return { ok: res.ok, status: res.status }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
    buildAccountSnapshot: ({ account, runtime }: {
      account: DashbotAccount
      cfg: Record<string, unknown>
      runtime?: Record<string, unknown>
      probe?: Record<string, unknown>
      audit?: Record<string, unknown>
    }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.url?.trim() && account.token?.trim()),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx: GatewayContext) => {
      const { account, abortSignal, log, cfg } = ctx
      const dashbotConfig: DashbotConfig = { url: account.url, token: account.token }

      log.info?.(`[${account.accountId}] connecting to ${account.url}`)

      // Create status reporter (will start on-demand when requested)
      const statusReporter = new StatusReporter(log, 15000)

      const connection = new DashbotConnection(dashbotConfig, (data: CableMessage) => {
        // Handle chat messages
        if (data.type === "message" && data.message?.role === "user") {
          log.info?.(`[${account.accountId}] inbound: ${data.message.content.slice(0, 80)}`)
          dispatchToDashbot({ content: data.message.content, connection, dashbotConfig, cfg, log, accountId: account.accountId })
        }
        // Handle plugin commands (status_requested, status_stopped)
        else if (data.type === "status_requested") {
          log.info?.(`[${account.accountId}] Status requested - starting periodic status updates`)
          if (!statusReporter.isActive()) {
            statusReporter.start((statusData) => {
              if (connection.isConnected()) {
                connection.sendStatus(statusData)
              }
            })
          }
        }
        else if (data.type === "status_stopped") {
          log.info?.(`[${account.accountId}] Status stopped - halting periodic updates`)
          statusReporter.stop()
        }
      })

      connection.connect()

      // Always run HTTP fallback (ensures status data flows even if WebSocket status detection fails)
      statusReporter.startHttpFallback(dashbotConfig.url, dashbotConfig.token)

      // Wait for abort signal to disconnect
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log.info?.(`[${account.accountId}] disconnecting`)
          statusReporter.stop()
          statusReporter.stopHttpFallback()
          connection.disconnect()
          resolve()
        })
      })
    },
  },
}

function dispatchToDashbot({ content, connection, dashbotConfig, cfg, log, accountId }: {
  content: string
  connection: DashbotConnection
  dashbotConfig: DashbotConfig
  cfg: Record<string, unknown>
  log: GatewayContext["log"]
  accountId: string
}) {
  const runtime = getDashbotRuntime()
  const dispatch = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher

  if (!dispatch) {
    // Fallback: no dispatch available, log the gap
    log.warn?.(`[${accountId}] runtime dispatch not available — message logged but not processed`)
    return
  }

  const sessionKey = `dashbot:${accountId}`
  const outbound = createOutbound(connection, dashbotConfig)

  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: content,
    From: `dashbot:dashboard`,
    To: `dashbot:${accountId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: "direct",
    Provider: "dashbot",
    Surface: "dashbot",
    MessageSid: `dashbot-${Date.now()}`,
    CommandAuthorized: true,
    OriginatingChannel: "dashbot",
    OriginatingTo: `dashbot:${accountId}`,
  })

  dispatch({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const text = payload.text ?? ""
        if (text) {
          log.info?.(`[${accountId}] outbound: ${text.slice(0, 80)}`)
          outbound.sendText(text)
        }
      },
      onError: (err: unknown) => {
        log.error?.(`[${accountId}] dispatch error: ${String(err)}`)
      },
    },
  }).catch((err: unknown) => {
    log.error?.(`[${accountId}] dispatch failed: ${String(err)}`)
  })
}
