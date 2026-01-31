import type { DashbotConfig, CableCommand, CableIncoming, CableMessage } from "./types.js"

const CHAT_IDENTIFIER = JSON.stringify({ channel: "ChatChannel" })
const CARDS_IDENTIFIER = JSON.stringify({ channel: "CardsChannel" })

export class DashbotConnection {
  private ws: WebSocket | null = null
  private config: DashbotConfig
  private onMessage: (msg: CableMessage) => void
  private onCardEvent: ((msg: CableMessage) => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private chatSubscribed = false
  public cardsSubscribed = false

  constructor(config: DashbotConfig, onMessage: (msg: CableMessage) => void) {
    this.config = config
    this.onMessage = onMessage
  }

  setCardHandler(handler: (msg: CableMessage) => void): void {
    this.onCardEvent = handler
  }

  isConnected(): boolean {
    return this.chatSubscribed && this.ws !== null
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
      this.chatSubscribed = false
      this.cardsSubscribed = false
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
    this.chatSubscribed = false
    this.cardsSubscribed = false
  }

  sendResponse(content: string, metadata?: Record<string, unknown>): void {
    if (!this.ws || !this.chatSubscribed) {
      console.warn("[dashbot] Cannot send — not connected/subscribed")
      return
    }

    const cmd: CableCommand = {
      command: "message",
      identifier: CHAT_IDENTIFIER,
      data: JSON.stringify({ action: "respond", content, metadata }),
    }
    this.ws.send(JSON.stringify(cmd))
  }

  sendStatus(statusData: unknown): void {
    if (!this.ws || !this.chatSubscribed) {
      console.warn("[dashbot] Cannot send status — not connected/subscribed")
      return
    }

    const cmd: CableCommand = {
      command: "message",
      identifier: CHAT_IDENTIFIER,
      data: JSON.stringify({ action: "send_status", status_data: statusData }),
    }
    this.ws.send(JSON.stringify(cmd))
  }

  private handleIncoming(data: CableIncoming): void {
    if ("type" in data) {
      switch (data.type) {
        case "welcome":
          this.subscribeChatChannel()
          this.subscribeCardsChannel()
          break
        case "confirm_subscription": {
          const id = (data as { identifier?: string }).identifier
          if (id === CHAT_IDENTIFIER) {
            console.log("[dashbot] Subscribed to ChatChannel")
            this.chatSubscribed = true
          } else if (id === CARDS_IDENTIFIER) {
            console.log("[dashbot] Subscribed to CardsChannel")
            this.cardsSubscribed = true
          }
          break
        }
        case "ping":
          break
      }
    } else if ("message" in data && "identifier" in data) {
      const incoming = data as { identifier: string; message: CableMessage }
      if (incoming.identifier === CARDS_IDENTIFIER) {
        // Card events go to the card handler
        this.onCardEvent?.(incoming.message)
      } else {
        // Chat messages go to the main handler
        this.onMessage(incoming.message)
      }
    }
  }

  private subscribeChatChannel(): void {
    if (!this.ws) return
    const cmd: CableCommand = {
      command: "subscribe",
      identifier: CHAT_IDENTIFIER,
    }
    this.ws.send(JSON.stringify(cmd))
  }

  private subscribeCardsChannel(): void {
    if (!this.ws) return
    const cmd: CableCommand = {
      command: "subscribe",
      identifier: CARDS_IDENTIFIER,
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
