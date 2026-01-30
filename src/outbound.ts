import type { DashbotConfig } from "./types.js"
import { DashbotConnection } from "./connection.js"

export interface OutboundSender {
  sendText(content: string, metadata?: Record<string, unknown>): void
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
        // Fallback to HTTP POST
        void postResponse(config, content, metadata)
      }
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
