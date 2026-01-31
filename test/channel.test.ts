import { dashbotPlugin } from "../src/channel.js"
import type { GatewayContext, DashbotAccount } from "../src/channel.js"
import type { CableMessage } from "../src/types.js"

// Mock status reporter with a real class (must be constructible with `new`)
vi.mock("../src/status-reporter.js", () => ({
  StatusReporter: class MockStatusReporter {
    start = vi.fn()
    stop = vi.fn()
    isActive = vi.fn(() => false)
  },
}))

// Mock runtime module
vi.mock("../src/runtime.js", () => ({
  getDashbotRuntime: vi.fn(() => ({
    channel: {
      reply: {
        finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
    },
  })),
  setDashbotRuntime: vi.fn(),
}))

// Mock WebSocket
const createdSockets: MockWebSocket[] = []

class MockWebSocket {
  url: string
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    createdSockets.push(this)
    setTimeout(() => this.onopen?.(new Event("open")), 0)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {}
}

vi.stubGlobal("WebSocket", MockWebSocket)

function lastWs(): MockWebSocket {
  return createdSockets[createdSockets.length - 1]
}

function simulateMessage(ws: MockWebSocket, data: unknown) {
  ws.onmessage?.({
    data: JSON.stringify(data),
  } as MessageEvent)
}

describe("dashbotPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    createdSockets.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("has correct plugin metadata", () => {
    expect(dashbotPlugin.id).toBe("dashbot")
    expect(dashbotPlugin.meta.label).toBe("DashBot")
    expect(dashbotPlugin.meta.order).toBe(100)
    expect(dashbotPlugin.capabilities.chatTypes).toContain("direct")
  })

  describe("config", () => {
    const cfg = {
      channels: {
        dashbot: {
          enabled: true,
          url: "https://dashbot.example.com",
          token: "test-token",
        },
      },
    }

    it("lists single default account", () => {
      expect(dashbotPlugin.config.listAccountIds(cfg)).toEqual(["default"])
    })

    it("resolves account from config", () => {
      const account = dashbotPlugin.config.resolveAccount(cfg, "default")
      expect(account.url).toBe("https://dashbot.example.com")
      expect(account.token).toBe("test-token")
      expect(account.enabled).toBe(true)
    })

    it("detects configured account", () => {
      const account = dashbotPlugin.config.resolveAccount(cfg, "default")
      expect(dashbotPlugin.config.isConfigured(account)).toBe(true)
    })

    it("detects unconfigured account", () => {
      const empty = dashbotPlugin.config.resolveAccount({ channels: {} }, "default")
      expect(dashbotPlugin.config.isConfigured(empty)).toBe(false)
    })
  })

  describe("multi-account config", () => {
    const multiCfg = {
      channels: {
        dashbot: {
          enabled: true,
          url: "https://dashbot.example.com",
          token: "prod-token",
          accounts: {
            dev: {
              url: "http://localhost:3000",
              token: "dev-token",
            },
            staging: {
              url: "https://staging.dashbot.example.com",
              token: "staging-token",
              enabled: false,
            },
          },
        },
      },
    }

    it("listAccountIds returns default + named accounts", () => {
      const ids = dashbotPlugin.config.listAccountIds(multiCfg)
      expect(ids).toContain("default")
      expect(ids).toContain("dev")
      expect(ids).toContain("staging")
      expect(ids).toHaveLength(3)
    })

    it("listAccountIds returns only default when no accounts block", () => {
      const cfg = { channels: { dashbot: { url: "https://x.com", token: "t" } } }
      expect(dashbotPlugin.config.listAccountIds(cfg)).toEqual(["default"])
    })

    it("resolveAccount returns flat config for default", () => {
      const account = dashbotPlugin.config.resolveAccount(multiCfg, "default")
      expect(account.accountId).toBe("default")
      expect(account.url).toBe("https://dashbot.example.com")
      expect(account.token).toBe("prod-token")
      expect(account.enabled).toBe(true)
      expect(account.name).toBe("DashBot")
    })

    it("resolveAccount returns named account config", () => {
      const account = dashbotPlugin.config.resolveAccount(multiCfg, "dev")
      expect(account.accountId).toBe("dev")
      expect(account.url).toBe("http://localhost:3000")
      expect(account.token).toBe("dev-token")
      expect(account.enabled).toBe(true)
      expect(account.name).toBe("DashBot (dev)")
    })

    it("resolveAccount respects disabled flag on named account", () => {
      const account = dashbotPlugin.config.resolveAccount(multiCfg, "staging")
      expect(account.accountId).toBe("staging")
      expect(account.enabled).toBe(false)
      expect(dashbotPlugin.config.isEnabled(account)).toBe(false)
    })

    it("resolveAccount returns empty shell for unknown account", () => {
      const account = dashbotPlugin.config.resolveAccount(multiCfg, "unknown")
      expect(account.accountId).toBe("unknown")
      expect(account.url).toBe("")
      expect(account.token).toBe("")
      expect(dashbotPlugin.config.isConfigured(account)).toBe(false)
    })

    it("setAccountEnabled updates default account at top level", () => {
      const result = dashbotPlugin.config.setAccountEnabled({ cfg: multiCfg, accountId: "default", enabled: false })
      const dashbot = (result.channels as Record<string, unknown>).dashbot as Record<string, unknown>
      expect(dashbot.enabled).toBe(false)
      // Named accounts unchanged
      const accounts = dashbot.accounts as Record<string, Record<string, unknown>>
      expect(accounts.dev.url).toBe("http://localhost:3000")
    })

    it("setAccountEnabled updates named account inside accounts block", () => {
      const result = dashbotPlugin.config.setAccountEnabled({ cfg: multiCfg, accountId: "dev", enabled: false })
      const dashbot = (result.channels as Record<string, unknown>).dashbot as Record<string, unknown>
      const accounts = dashbot.accounts as Record<string, Record<string, unknown>>
      expect(accounts.dev.enabled).toBe(false)
      expect(accounts.dev.url).toBe("http://localhost:3000")
      // Default unchanged
      expect(dashbot.enabled).toBe(true)
    })

    it("deleteAccount for default removes entire dashbot block", () => {
      const result = dashbotPlugin.config.deleteAccount({ cfg: multiCfg, accountId: "default" })
      const channels = result.channels as Record<string, unknown>
      expect(channels.dashbot).toBeUndefined()
    })

    it("deleteAccount for named account preserves others", () => {
      const result = dashbotPlugin.config.deleteAccount({ cfg: multiCfg, accountId: "dev" })
      const dashbot = (result.channels as Record<string, unknown>).dashbot as Record<string, unknown>
      const accounts = dashbot.accounts as Record<string, unknown>
      expect(accounts.dev).toBeUndefined()
      expect(accounts.staging).toBeDefined()
      // Default config preserved
      expect(dashbot.url).toBe("https://dashbot.example.com")
    })
  })

  describe("gateway.startAccount", () => {
    it("connects to dashbot on start", async () => {
      const ctx = createGatewayContext()
      const promise = dashbotPlugin.gateway.startAccount(ctx)
      vi.runAllTimers()

      expect(lastWs()).toBeDefined()
      expect(lastWs().url).toContain("dashbot.example.com")

      // Abort to clean up
      ctx._abort.abort()
      await promise
    })

    it("disconnects on abort", async () => {
      const ctx = createGatewayContext()
      const promise = dashbotPlugin.gateway.startAccount(ctx)
      vi.runAllTimers()

      ctx._abort.abort()
      await promise

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("disconnecting"),
      )
    })

    it("logs inbound user messages", async () => {
      const ctx = createGatewayContext()
      const promise = dashbotPlugin.gateway.startAccount(ctx)
      vi.runAllTimers()

      // Complete handshake
      simulateMessage(lastWs(), { type: "welcome" })
      simulateMessage(lastWs(), {
        type: "confirm_subscription",
        identifier: JSON.stringify({ channel: "ChatChannel" }),
      })

      // Simulate user message broadcast
      const broadcast: { identifier: string; message: CableMessage } = {
        identifier: JSON.stringify({ channel: "ChatChannel" }),
        message: {
          type: "message",
          message: {
            id: 1,
            role: "user",
            content: "Hello from dashboard",
            created_at: "2026-01-30T12:00:00Z",
          },
        },
      }
      simulateMessage(lastWs(), broadcast)

      expect(ctx.log.info).toHaveBeenCalledWith(
        expect.stringContaining("inbound: Hello from dashboard"),
      )

      ctx._abort.abort()
      await promise
    })

    it("ignores assistant messages", async () => {
      const ctx = createGatewayContext()
      const promise = dashbotPlugin.gateway.startAccount(ctx)
      vi.runAllTimers()

      // Complete handshake
      simulateMessage(lastWs(), { type: "welcome" })
      simulateMessage(lastWs(), {
        type: "confirm_subscription",
        identifier: JSON.stringify({ channel: "ChatChannel" }),
      })

      const broadcast: { identifier: string; message: CableMessage } = {
        identifier: JSON.stringify({ channel: "ChatChannel" }),
        message: {
          type: "message",
          message: {
            id: 2,
            role: "assistant",
            content: "I am the assistant",
            created_at: "2026-01-30T12:00:01Z",
          },
        },
      }
      simulateMessage(lastWs(), broadcast)

      // Only the "connecting" and "WebSocket connected" log calls, no inbound log
      const infoCalls = (ctx.log.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[0])
        .filter((msg: string) => msg.includes("inbound"))
      expect(infoCalls).toHaveLength(0)

      ctx._abort.abort()
      await promise
    })
  })

  describe("status", () => {
    it("probes the /up endpoint", async () => {
      vi.useRealTimers()
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 }),
      )

      const account: DashbotAccount = {
        accountId: "default",
        name: "DashBot",
        enabled: true,
        url: "https://dashbot.example.com",
        token: "t",
        config: { url: "https://dashbot.example.com", token: "t" },
      }

      const result = await dashbotPlugin.status.probeAccount({ account })
      expect(result).toEqual({ ok: true, status: 200 })
      expect(fetchSpy).toHaveBeenCalledWith("https://dashbot.example.com/up")
    })
  })
})

function createGatewayContext(): GatewayContext & { _abort: AbortController } {
  const abort = new AbortController()
  return {
    cfg: {
      channels: {
        dashbot: {
          enabled: true,
          url: "https://dashbot.example.com",
          token: "test-token",
        },
      },
    },
    accountId: "default",
    account: {
      accountId: "default",
      name: "Dashbot",
      enabled: true,
      url: "https://dashbot.example.com",
      token: "test-token",
      config: { url: "https://dashbot.example.com", token: "test-token" },
    },
    runtime: {},
    abortSignal: abort.signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getStatus: () => ({}),
    setStatus: () => {},
    _abort: abort,
  }
}
