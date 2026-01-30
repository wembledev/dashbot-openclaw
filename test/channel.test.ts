import { dashbotPlugin } from "../src/channel.js"
import type { GatewayContext, DashbotAccount } from "../src/channel.js"
import type { CableMessage } from "../src/types.js"

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
    vi.restoreAllMocks()
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
