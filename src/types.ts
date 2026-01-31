export interface DashbotConfig {
  url: string
  token: string
}

export interface DashbotMessage {
  id: number
  role: "user" | "assistant"
  content: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface CableMessage {
  type: string
  message?: DashbotMessage
}

export interface CableCommand {
  command: "subscribe" | "message"
  identifier: string
  data?: string
}

export interface CableWelcome {
  type: "welcome"
}

export interface CableConfirmation {
  type: "confirm_subscription"
  identifier: string
}

export interface CablePing {
  type: "ping"
  message: number
}

export interface CableBroadcast {
  identifier: string
  message: CableMessage
}

export type CableIncoming = CableWelcome | CableConfirmation | CablePing | CableBroadcast
