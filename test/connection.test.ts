import { DashbotConnection } from "../src/connection.js"
import type { CableMessage } from "../src/types.js"

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = MockWebSocket.OPEN
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    // Simulate async open
    setTimeout(() => this.onopen?.(new Event("open")), 0)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}

vi.stubGlobal("WebSocket", MockWebSocket)

describe("DashbotConnection", () => {
  let connection: DashbotConnection
  let receivedMessages: CableMessage[]

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    createdSockets.length = 0
    receivedMessages = []
    connection = new DashbotConnection(
      { url: "https://dashbot.example.com", token: "test-token" },
      (msg) => receivedMessages.push(msg),
    )
  })

  afterEach(() => {
    connection.disconnect()
    vi.useRealTimers()
  })

  it("builds the correct WebSocket URL", () => {
    connection.connect()
    vi.runAllTimers()
    // Access the underlying WebSocket to check URL
    const ws = getLastWebSocket()
    expect(ws.url).toBe("wss://dashbot.example.com/cable?token=test-token")
  })

  it("uses ws:// for http:// URLs", () => {
    connection = new DashbotConnection(
      { url: "http://localhost:3000", token: "t" },
      () => {},
    )
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()
    expect(ws.url).toBe("ws://localhost:3000/cable?token=t")
  })

  it("strips trailing slash from URL", () => {
    connection = new DashbotConnection(
      { url: "https://dashbot.example.com/", token: "t" },
      () => {},
    )
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()
    expect(ws.url).toBe("wss://dashbot.example.com/cable?token=t")
  })

  it("subscribes to ChatChannel and CardsChannel after welcome", () => {
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()

    // Simulate welcome message from server
    simulateMessage(ws, { type: "welcome" })

    expect(ws.sent).toHaveLength(2)
    const chatCmd = JSON.parse(ws.sent[0])
    expect(chatCmd.command).toBe("subscribe")
    expect(JSON.parse(chatCmd.identifier)).toEqual({ channel: "ChatChannel" })
    const cardsCmd = JSON.parse(ws.sent[1])
    expect(cardsCmd.command).toBe("subscribe")
    expect(JSON.parse(cardsCmd.identifier)).toEqual({ channel: "CardsChannel" })
  })

  it("dispatches broadcast messages to callback", () => {
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()

    // Complete handshake
    simulateMessage(ws, { type: "welcome" })
    simulateMessage(ws, {
      type: "confirm_subscription",
      identifier: JSON.stringify({ channel: "ChatChannel" }),
    })

    // Simulate broadcast
    const broadcast = {
      identifier: JSON.stringify({ channel: "ChatChannel" }),
      message: {
        type: "message",
        message: {
          id: 1,
          role: "user" as const,
          content: "Hello",
          created_at: "2026-01-30T12:00:00Z",
        },
      },
    }
    simulateMessage(ws, broadcast)

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0].message.content).toBe("Hello")
  })

  it("ignores ping messages", () => {
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()

    simulateMessage(ws, { type: "ping", message: 1706630400 })

    expect(receivedMessages).toHaveLength(0)
  })

  it("sends response via WebSocket after subscription confirmed", () => {
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()

    // Complete handshake
    simulateMessage(ws, { type: "welcome" })
    simulateMessage(ws, {
      type: "confirm_subscription",
      identifier: JSON.stringify({ channel: "ChatChannel" }),
    })

    connection.sendResponse("Hello back", { model: "test" })

    // sent[0] is ChatChannel subscribe, sent[1] is CardsChannel subscribe, sent[2] is the response
    expect(ws.sent).toHaveLength(3)
    const cmd = JSON.parse(ws.sent[2])
    expect(cmd.command).toBe("message")
    const data = JSON.parse(cmd.data)
    expect(data.action).toBe("respond")
    expect(data.content).toBe("Hello back")
    expect(data.metadata).toEqual({ model: "test" })
  })

  it("does not send when not subscribed", () => {
    connection.connect()
    vi.runAllTimers()
    const ws = getLastWebSocket()

    // Only welcome, no confirm
    simulateMessage(ws, { type: "welcome" })

    connection.sendResponse("should not send")

    // Only the two subscribe commands should be in sent (ChatChannel + CardsChannel)
    expect(ws.sent).toHaveLength(2)
    expect(JSON.parse(ws.sent[0]).command).toBe("subscribe")
    expect(JSON.parse(ws.sent[1]).command).toBe("subscribe")
  })

  it("reconnects after disconnect", () => {
    connection.connect()
    vi.runAllTimers()
    const ws1 = getLastWebSocket()

    // Simulate disconnect
    ws1.onclose?.(new Event("close"))

    // Advance past reconnect timer (3s)
    vi.advanceTimersByTime(3000)

    // A new WebSocket should have been created
    const ws2 = getLastWebSocket()
    expect(ws2).not.toBe(ws1)
  })

  it("cleans up on disconnect()", () => {
    connection.connect()
    vi.runAllTimers()

    connection.disconnect()

    // Should not reconnect after explicit disconnect
    vi.advanceTimersByTime(5000)
    // No errors thrown = success
  })
})

// Helpers

const createdSockets: MockWebSocket[] = []
const OrigWebSocket = MockWebSocket

vi.stubGlobal(
  "WebSocket",
  class extends OrigWebSocket {
    constructor(url: string) {
      super(url)
      createdSockets.push(this)
    }
  },
)

function getLastWebSocket(): MockWebSocket {
  return createdSockets[createdSockets.length - 1]
}

function simulateMessage(ws: MockWebSocket, data: unknown) {
  ws.onmessage?.({
    data: JSON.stringify(data),
  } as MessageEvent)
}
