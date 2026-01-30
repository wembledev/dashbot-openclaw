import type { DashbotConfig, CableMessage } from "./types.js"
import { DashbotConnection } from "./connection.js"
import { createOutbound } from "./outbound.js"
import { getDashbotRuntime } from "./runtime.js"

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

function resolveAccount(cfg: Record<string, unknown>, _accountId: string): DashbotAccount {
  const channelCfg = getDashbotChannelConfig(cfg)
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: "DashBot",
    enabled: channelCfg.enabled !== false,
    url: String(channelCfg.url ?? ""),
    token: String(channelCfg.token ?? ""),
    config: {
      url: String(channelCfg.url ?? ""),
      token: String(channelCfg.token ?? ""),
      enabled: channelCfg.enabled !== false,
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
    listAccountIds: (_cfg: Record<string, unknown>) => [DEFAULT_ACCOUNT_ID],
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
    setAccountEnabled: ({ cfg, enabled }: { cfg: Record<string, unknown>; accountId: string; enabled: boolean }) => {
      const channels = (cfg.channels ?? {}) as Record<string, unknown>
      const dashbot = (channels.dashbot ?? {}) as Record<string, unknown>
      return { ...cfg, channels: { ...channels, dashbot: { ...dashbot, enabled } } }
    },
    deleteAccount: ({ cfg }: { cfg: Record<string, unknown>; accountId: string }) => {
      const channels = { ...(cfg.channels as Record<string, unknown>) }
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

      const connection = new DashbotConnection(dashbotConfig, (data: CableMessage) => {
        if (data.type === "message" && data.message.role === "user") {
          log.info?.(`[${account.accountId}] inbound: ${data.message.content.slice(0, 80)}`)
          dispatchToDashbot({ content: data.message.content, connection, dashbotConfig, cfg, log, accountId: account.accountId })
        }
      })

      connection.connect()

      // Wait for abort signal to disconnect
      return new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log.info?.(`[${account.accountId}] disconnecting`)
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
