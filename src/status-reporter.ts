import { execSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface StatusSession {
  key: string
  kind: string
  model: string
  tokens: string
  context_percent: number
  age: string
  flags: string
}

export interface StatusCronJob {
  id: string
  name: string
  schedule: string
  next_run: string
  last_run: string
  status: string
  target: string
  agent: string
  error?: string
}

export interface CronError {
  job_name: string
  error: string
  timestamp: number
}

export interface StatusMemory {
  file_count: number
  chunk_count: number
  dirty: boolean
  sources: string
  vector_ready: boolean
  fts_ready: boolean
  cache_count: number
}

export interface StatusData {
  agent_status: {
    running: boolean
    session_count: number
    main_session_age: string
    main_model: string
  }
  token_burn: {
    main_tokens: string
    main_context_percent: number
    total_sessions: number
    model: string
  }
  tasks: {
    cron_jobs: StatusCronJob[]
    pending_count: number
    next_job: string | null
    cron_health: "healthy" | "degraded" | "failing"
    cron_errors: CronError[]
  }
  memory: StatusMemory
  session_health: {
    uptime: string
    model: string
    context_percent: number
    tokens: string
    session_key: string
  }
  sessions: StatusSession[]
  fetched_at: string
}

interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  debug: (msg: string) => void
}

const OPENCLAW_STATE_DIR = join(homedir(), ".openclaw")
const SESSIONS_PATH = join(OPENCLAW_STATE_DIR, "agents", "main", "sessions", "sessions.json")
const CRON_PATH = join(OPENCLAW_STATE_DIR, "cron", "jobs.json")
const MEMORY_DB_PATH = join(OPENCLAW_STATE_DIR, "memory", "main.sqlite")

export function formatTokens(total: number, context: number): string {
  const fmt = (n: number): string => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`
    return String(n)
  }
  return `${fmt(total)}/${fmt(context)}`
}

export function formatAge(ms: number): string {
  if (ms < 0) ms = 0
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatRelativeTime(targetMs: number, nowMs: number): string {
  const diffMs = targetMs - nowMs
  const absDiff = Math.abs(diffMs)
  const seconds = Math.floor(absDiff / 1000)
  const prefix = diffMs > 0 ? "in " : ""
  const suffix = diffMs <= 0 ? " ago" : ""

  if (seconds < 60) return `${prefix}${seconds}s${suffix}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${prefix}${minutes}m${suffix}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${prefix}${hours}h${suffix}`
  const days = Math.floor(hours / 24)
  return `${prefix}${days}d${suffix}`
}

export function readSessions(): StatusSession[] {
  if (!existsSync(SESSIONS_PATH)) return []

  try {
    const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8")) as Record<string, {
      sessionId?: string
      updatedAt?: number
      model?: string
      contextTokens?: number
      totalTokens?: number
      inputTokens?: number
      outputTokens?: number
      systemSent?: boolean
      abortedLastRun?: boolean
    }>

    const now = Date.now()
    return Object.entries(raw).map(([key, session]) => {
      const totalTokens = session.totalTokens ?? 0
      const contextTokens = session.contextTokens ?? 200000
      const contextPercent = contextTokens > 0 ? Math.round((totalTokens / contextTokens) * 100) : 0
      const ageMs = session.updatedAt ? now - session.updatedAt : 0
      const kind = key.includes("cron:") ? "cron" : key.includes("subagent:") ? "subagent" : "direct"

      const flags: string[] = []
      if (session.systemSent) flags.push("system")
      if (session.sessionId) flags.push(`id:${session.sessionId}`)

      return {
        key,
        kind,
        model: session.model ?? "unknown",
        tokens: formatTokens(totalTokens, contextTokens),
        context_percent: contextPercent,
        age: formatAge(ageMs),
        flags: flags.join(", "),
      }
    }).sort((a, b) => {
      // Main session first, then by key
      if (a.key.includes("agent:main:main")) return -1
      if (b.key.includes("agent:main:main")) return 1
      return a.key.localeCompare(b.key)
    })
  } catch {
    return []
  }
}

export function readCronJobs(): StatusCronJob[] {
  if (!existsSync(CRON_PATH)) return []

  try {
    const raw = JSON.parse(readFileSync(CRON_PATH, "utf-8")) as {
      jobs: Array<{
        id: string
        name: string
        enabled?: boolean
        schedule?: { kind?: string; expr?: string }
        sessionTarget?: string
        state?: {
          nextRunAtMs?: number
          lastRunAtMs?: number
          lastStatus?: string
          lastError?: string
        }
        payload?: { kind?: string }
      }>
    }

    const now = Date.now()
    return (raw.jobs ?? [])
      .filter(j => j.enabled !== false)
      .map(job => ({
        id: job.id,
        name: job.name,
        schedule: job.schedule?.kind === "cron" ? `cron ${job.schedule.expr ?? ""}` : (job.schedule?.kind ?? "unknown"),
        next_run: job.state?.nextRunAtMs ? formatRelativeTime(job.state.nextRunAtMs, now) : "-",
        last_run: job.state?.lastRunAtMs ? formatRelativeTime(job.state.lastRunAtMs, now) : "-",
        status: job.state?.lastStatus ?? "idle",
        target: job.sessionTarget ?? "unknown",
        agent: "default",
        error: job.state?.lastError,
      }))
  } catch {
    return []
  }
}

export function readCronErrors(): CronError[] {
  if (!existsSync(CRON_PATH)) return []

  try {
    const raw = JSON.parse(readFileSync(CRON_PATH, "utf-8")) as {
      jobs: Array<{
        name: string
        enabled?: boolean
        state?: {
          lastRunAtMs?: number
          lastError?: string
          lastStatus?: string
        }
      }>
    }

    const now = Date.now()
    const errors: CronError[] = []

    for (const job of raw.jobs ?? []) {
      if (job.enabled === false) continue
      if (!job.state?.lastError) continue
      if (job.state.lastStatus === "ok") continue // Don't include if last run was successful

      errors.push({
        job_name: job.name,
        error: job.state.lastError,
        timestamp: job.state.lastRunAtMs ?? now,
      })
    }

    return errors
  } catch {
    return []
  }
}

export function calculateCronHealth(jobs: StatusCronJob[], errors: CronError[]): "healthy" | "degraded" | "failing" {
  if (errors.length === 0) return "healthy"
  
  const recentErrors = errors.filter(e => Date.now() - e.timestamp < 3600000) // Last hour
  if (recentErrors.length === 0) return "healthy"
  
  const errorRate = recentErrors.length / Math.max(jobs.length, 1)
  if (errorRate >= 0.5) return "failing"
  if (errorRate > 0) return "degraded"
  
  return "healthy"
}

export function readMemoryStats(): StatusMemory {
  const defaults: StatusMemory = {
    file_count: 0,
    chunk_count: 0,
    dirty: false,
    sources: "unknown",
    vector_ready: false,
    fts_ready: false,
    cache_count: 0,
  }

  if (!existsSync(MEMORY_DB_PATH)) return defaults

  try {
    const result = execSync(
      `sqlite3 "${MEMORY_DB_PATH}" "SELECT ` +
      `(SELECT COUNT(*) FROM files) as files, ` +
      `(SELECT COUNT(*) FROM chunks) as chunks, ` +
      `(SELECT COUNT(*) FROM embedding_cache) as cache"`,
      { timeout: 3000, encoding: "utf-8" },
    ).trim()

    const parts = result.split("|")
    if (parts.length >= 3) {
      defaults.file_count = parseInt(parts[0], 10) || 0
      defaults.chunk_count = parseInt(parts[1], 10) || 0
      defaults.cache_count = parseInt(parts[2], 10) || 0
    }

    // Check if vector/fts tables have data
    defaults.vector_ready = defaults.chunk_count > 0
    defaults.fts_ready = defaults.chunk_count > 0
    defaults.sources = "memory, sessions"
  } catch {
    // SQLite query failed, return defaults
  }

  return defaults
}

export function gatherStatusData(): StatusData {
  const sessions = readSessions()
  const cronJobs = readCronJobs()
  const cronErrors = readCronErrors()
  const cronHealth = calculateCronHealth(cronJobs, cronErrors)
  const memory = readMemoryStats()

  const mainSession = sessions.find(s => s.key.includes("agent:main:main"))

  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const fetchedAt = now.toLocaleString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).replace(",", "") + ` ${tz.split("/").pop()}`

  return {
    agent_status: {
      running: mainSession !== undefined,
      session_count: sessions.length,
      main_session_age: mainSession?.age ?? "unknown",
      main_model: mainSession?.model ?? "unknown",
    },
    token_burn: {
      main_tokens: mainSession?.tokens ?? "0/0",
      main_context_percent: mainSession?.context_percent ?? 0,
      total_sessions: sessions.length,
      model: mainSession?.model ?? "unknown",
    },
    tasks: {
      cron_jobs: cronJobs,
      pending_count: cronJobs.filter(j => j.status === "idle").length,
      next_job: cronJobs
        .filter(j => j.next_run.startsWith("in "))
        .sort((a, b) => a.next_run.localeCompare(b.next_run))[0]?.name ?? null,
      cron_health: cronHealth,
      cron_errors: cronErrors,
    },
    memory,
    session_health: {
      uptime: mainSession?.age ?? "unknown",
      model: mainSession?.model ?? "unknown",
      context_percent: mainSession?.context_percent ?? 0,
      tokens: mainSession?.tokens ?? "0/0",
      session_key: mainSession?.key ?? "unknown",
    },
    sessions,
    fetched_at: fetchedAt,
  }
}

export class StatusReporter {
  private log: Logger
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalMs: number
  private sendCallback: ((data: StatusData) => void) | null = null
  private active = false

  constructor(log: Logger, intervalMs = 15000) {
    this.log = log
    this.intervalMs = intervalMs
  }

  start(sendCallback: (data: StatusData) => void): void {
    if (this.active) {
      this.log.warn?.("[status-reporter] Already active")
      return
    }

    this.log.info?.("[status-reporter] Starting on-demand status reporting")
    this.sendCallback = sendCallback
    this.active = true
    
    // Send immediately, then on interval
    void this.report()
    this.timer = setInterval(() => void this.report(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.sendCallback = null
    this.active = false
    this.log.info?.("[status-reporter] Stopped")
  }

  isActive(): boolean {
    return this.active
  }

  async report(): Promise<void> {
    if (!this.sendCallback) return

    try {
      const data = gatherStatusData()
      this.sendCallback(data)
    } catch (err) {
      this.log.error?.(`[status-reporter] Failed to gather/send status: ${String(err)}`)
    }
  }
}
