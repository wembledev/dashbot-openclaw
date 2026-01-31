import type { DashbotConfig } from "./types.js"
import { DashbotConnection } from "./connection.js"

export interface CardPayload {
  type?: string
  prompt: string
  message?: string
  options: Array<{ label: string; value: string; style?: string }>
  metadata?: Record<string, unknown>
}

export interface OutboundSender {
  sendText(content: string, metadata?: Record<string, unknown>): void
  sendCard(card: CardPayload): Promise<{ ok: boolean; card_id?: number; error?: string }>
}

export function createOutbound(
  connection: DashbotConnection | null,
  config: DashbotConfig
): OutboundSender {
  return {
    sendText(content: string, metadata?: Record<string, unknown>): void {
      if (connection) {
        connection.sendResponse(content, metadata)
      } else {
        void postResponse(config, content, metadata)
      }
    },

    async sendCard(card: CardPayload): Promise<{ ok: boolean; card_id?: number; error?: string }> {
      return postCard(config, card)
    },
  }
}

async function postResponse(
  config: DashbotConfig,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const url = `${config.url.replace(/\/$/, "")}/api/messages/respond`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ content, metadata }),
    })
    if (!res.ok) {
      console.error(`[dashbot] HTTP respond failed: ${res.status}`)
    }
  } catch (err) {
    console.error("[dashbot] HTTP respond error:", err)
  }
}

async function postCard(
  config: DashbotConfig,
  card: CardPayload
): Promise<{ ok: boolean; card_id?: number; error?: string }> {
  const url = `${config.url.replace(/\/$/, "")}/api/cards`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        type: card.type ?? "confirm",
        prompt: card.prompt,
        message: card.message,
        options: card.options,
        metadata: card.metadata,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(`[dashbot] Card creation failed: ${res.status} ${text}`)
      return { ok: false, error: text }
    }
    const json = await res.json() as { ok: boolean; card: { id: number } }
    return { ok: true, card_id: json.card?.id }
  } catch (err) {
    console.error("[dashbot] Card creation error:", err)
    return { ok: false, error: String(err) }
  }
}
