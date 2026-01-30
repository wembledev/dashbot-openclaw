import { createOutbound } from "../src/outbound.js"
import type { DashbotConfig } from "../src/types.js"
import { DashbotConnection } from "../src/connection.js"

// Mock WebSocket globally so DashbotConnection can construct
class MockWebSocket {
  url: string
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {}
}

vi.stubGlobal("WebSocket", MockWebSocket)

const config: DashbotConfig = {
  url: "https://dashbot.example.com",
  token: "test-token",
}

describe("createOutbound", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("sends via connection when available", () => {
    const connection = new DashbotConnection(config, () => {})
    const sendSpy = vi.spyOn(connection, "sendResponse")

    const outbound = createOutbound(connection, config)
    outbound.sendText("Hello", { model: "test" })

    expect(sendSpy).toHaveBeenCalledWith("Hello", { model: "test" })
  })

  it("falls back to HTTP POST when connection is null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: {} }), { status: 201 }),
    )

    const outbound = createOutbound(null, config)
    outbound.sendText("Hello from fallback")

    // fetch is called async, wait for it
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://dashbot.example.com/api/messages/respond",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: "Bearer test-token",
          }),
          body: JSON.stringify({ content: "Hello from fallback" }),
        }),
      )
    })
  })

  it("includes metadata in HTTP fallback body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 201 }),
    )

    const outbound = createOutbound(null, config)
    outbound.sendText("Response", { model: "gpt-4", tokens: 42 })

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
      expect(body.content).toBe("Response")
      expect(body.metadata).toEqual({ model: "gpt-4", tokens: 42 })
    })
  })

  it("logs error on HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    )
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const outbound = createOutbound(null, config)
    outbound.sendText("will fail")

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("HTTP respond failed: 401"),
      )
    })
  })

  it("logs error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const outbound = createOutbound(null, config)
    outbound.sendText("will fail")

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("HTTP respond error:"),
        expect.any(Error),
      )
    })
  })
})
