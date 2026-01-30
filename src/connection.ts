import type { DashbotConfig, CableCommand, CableIncoming, CableMessage } from "./types.js"

const CHANNEL_IDENTIFIER = JSON.stringify({ channel: "ChatChannel" })

export class DashbotConnection {
  private ws: WebSocket | null = null
  private config: DashbotConfig
  private onMessage: (msg: CableMessage) => void
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private subscribed = false

  constructor(config: DashbotConfig, onMessage: (msg: CableMessage) => void) {
    this.config = config
    this.onMessage = onMessage
  }

  connect(): void {
    const wsUrl = this.buildWsUrl()
    console.log(`[dashbot] Connecting to ${wsUrl}`)
    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      console.log("[dashbot] WebSocket connected")
    }

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleIncoming(JSON.parse(String(event.data)) as CableIncoming)
    }

    this.ws.onclose = () => {
      console.log("[dashbot] WebSocket disconnected, reconnecting...")
      this.subscribed = false
      this.scheduleReconnect()
    }

    this.ws.onerror = (err: Event) => {
      console.error("[dashbot] WebSocket error:", err)
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.subscribed = false
  }

  sendResponse(content: string, metadata?: Record<string, unknown>): void {
    if (!this.ws || !this.subscribed) {
      console.warn("[dashbot] Cannot send — not connected/subscribed")
      return
    }

    const cmd: CableCommand = {
      command: "message",
      identifier: CHANNEL_IDENTIFIER,
      data: JSON.stringify({ action: "respond", content, metadata }),
    }
    this.ws.send(JSON.stringify(cmd))
  }

  private handleIncoming(data: CableIncoming): void {
    if ("type" in data) {
      switch (data.type) {
        case "welcome":
          this.subscribe()
          break
        case "confirm_subscription":
          console.log("[dashbot] Subscribed to ChatChannel")
          this.subscribed = true
          break
        case "ping":
          break
      }
    } else if ("message" in data) {
      // Broadcast from channel
      this.onMessage(data.message)
    }
  }

  private subscribe(): void {
    if (!this.ws) return

    const cmd: CableCommand = {
      command: "subscribe",
      identifier: CHANNEL_IDENTIFIER,
    }
    this.ws.send(JSON.stringify(cmd))
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, 3000)
  }

  private buildWsUrl(): string {
    const base = this.config.url.replace(/\/$/, "")
    const protocol = base.startsWith("https") ? "wss" : "ws"
    const host = base.replace(/^https?:\/\//, "")
    return `${protocol}://${host}/cable?token=${encodeURIComponent(this.config.token)}`
  }
}
