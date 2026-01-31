import { formatTokens, formatAge, formatRelativeTime, gatherStatusData, StatusReporter } from "../src/status-reporter.js"

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("qmd")) throw new Error("qmd not found")
    return "4|12|14"
  }),
}))

// Mock node:fs
const mockSessionsData = JSON.stringify({
  "agent:main:main": {
    sessionId: "abc-123",
    updatedAt: Date.now() - 120000, // 2 minutes ago
    model: "claude-opus-4-5",
    contextTokens: 200000,
    totalTokens: 166000,
    systemSent: true,
  },
  "agent:main:cron:job-1": {
    sessionId: "def-456",
    updatedAt: Date.now() - 3600000, // 1 hour ago
    model: "claude-haiku-4-5",
    contextTokens: 200000,
    totalTokens: 22000,
  },
})

const mockCronData = JSON.stringify({
  version: 1,
  jobs: [
    {
      id: "job-1",
      name: "Morning briefing",
      enabled: true,
      schedule: { kind: "cron", expr: "0 7 * * *" },
      sessionTarget: "isolated",
      state: {
        nextRunAtMs: Date.now() + 3600000,
        lastRunAtMs: Date.now() - 7200000,
        lastStatus: "ok",
      },
    },
    {
      id: "job-2",
      name: "Health check",
      enabled: true,
      schedule: { kind: "cron", expr: "*/30 * * * *" },
      sessionTarget: "main",
      state: {
        nextRunAtMs: Date.now() + 900000,
        lastRunAtMs: Date.now() - 1800000,
        lastStatus: "skipped",
      },
    },
    {
      id: "job-3",
      name: "Disabled job",
      enabled: false,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "isolated",
      state: {},
    },
  ],
})

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((path: string) => {
    if (path.includes("sessions.json")) return mockSessionsData
    if (path.includes("jobs.json")) return mockCronData
    throw new Error("File not found")
  }),
  existsSync: vi.fn(() => true),
}))

describe("formatTokens", () => {
  it("formats tokens with k suffix", () => {
    expect(formatTokens(166000, 200000)).toBe("166k/200k")
  })

  it("formats small token counts without k", () => {
    expect(formatTokens(500, 1000)).toBe("500/1k")
  })

  it("handles zero tokens", () => {
    expect(formatTokens(0, 200000)).toBe("0/200k")
  })
})

describe("formatAge", () => {
  it("formats seconds", () => {
    expect(formatAge(30000)).toBe("30s ago")
  })

  it("formats minutes", () => {
    expect(formatAge(120000)).toBe("2m ago")
  })

  it("formats hours", () => {
    expect(formatAge(7200000)).toBe("2h ago")
  })

  it("formats days", () => {
    expect(formatAge(172800000)).toBe("2d ago")
  })

  it("handles zero", () => {
    expect(formatAge(0)).toBe("0s ago")
  })

  it("handles negative", () => {
    expect(formatAge(-1000)).toBe("0s ago")
  })
})

describe("formatRelativeTime", () => {
  const now = Date.now()

  it("formats future time", () => {
    expect(formatRelativeTime(now + 3600000, now)).toBe("in 1h")
  })

  it("formats past time", () => {
    expect(formatRelativeTime(now - 3600000, now)).toBe("1h ago")
  })

  it("formats near future in seconds", () => {
    expect(formatRelativeTime(now + 30000, now)).toBe("in 30s")
  })
})

describe("gatherStatusData", () => {
  it("returns complete status data structure", () => {
    const data = gatherStatusData()

    expect(data.agent_status.running).toBe(true)
    expect(data.agent_status.session_count).toBe(2)
    expect(data.agent_status.main_model).toBe("claude-opus-4-5")
  })

  it("includes main session token data", () => {
    const data = gatherStatusData()

    expect(data.token_burn.main_tokens).toBe("166k/200k")
    expect(data.token_burn.main_context_percent).toBe(83)
    expect(data.token_burn.model).toBe("claude-opus-4-5")
  })

  it("includes cron jobs (excludes disabled)", () => {
    const data = gatherStatusData()

    expect(data.tasks.cron_jobs).toHaveLength(2)
    expect(data.tasks.cron_jobs[0].name).toBe("Morning briefing")
    expect(data.tasks.cron_jobs[1].name).toBe("Health check")
  })

  it("includes memory stats from sqlite", () => {
    const data = gatherStatusData()

    expect(data.memory.file_count).toBe(4)
    expect(data.memory.chunk_count).toBe(12)
    expect(data.memory.cache_count).toBe(14)
    expect(data.memory.vector_ready).toBe(true)
    expect(data.memory.fts_ready).toBe(true)
  })

  it("includes session health data", () => {
    const data = gatherStatusData()

    expect(data.session_health.model).toBe("claude-opus-4-5")
    expect(data.session_health.context_percent).toBe(83)
    expect(data.session_health.session_key).toBe("agent:main:main")
  })

  it("includes sessions list sorted with main first", () => {
    const data = gatherStatusData()

    expect(data.sessions).toHaveLength(2)
    expect(data.sessions[0].key).toBe("agent:main:main")
    expect(data.sessions[1].key).toBe("agent:main:cron:job-1")
  })

  it("includes fetched_at timestamp", () => {
    const data = gatherStatusData()

    expect(data.fetched_at).toBeTruthy()
    expect(typeof data.fetched_at).toBe("string")
  })
})

describe("StatusReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("calls sendCallback immediately and on interval", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const reporter = new StatusReporter(log, 15000)
    const sendCallback = vi.fn()

    reporter.start(sendCallback)

    // Immediate report
    await vi.advanceTimersByTimeAsync(10)
    expect(sendCallback).toHaveBeenCalledTimes(1)

    const data = sendCallback.mock.calls[0][0]
    expect(data.agent_status).toBeDefined()
    expect(data.token_burn).toBeDefined()
    expect(data.sessions).toBeDefined()

    // Advance to next interval
    await vi.advanceTimersByTimeAsync(15000)
    expect(sendCallback).toHaveBeenCalledTimes(2)

    reporter.stop()
  })

  it("stops calling sendCallback on stop()", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const reporter = new StatusReporter(log, 15000)
    const sendCallback = vi.fn()

    reporter.start(sendCallback)
    await vi.advanceTimersByTimeAsync(10)

    reporter.stop()

    const callsBefore = sendCallback.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(sendCallback).toHaveBeenCalledTimes(callsBefore)
  })

  it("tracks active state correctly", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const reporter = new StatusReporter(log, 15000)

    expect(reporter.isActive()).toBe(false)

    reporter.start(vi.fn())
    expect(reporter.isActive()).toBe(true)

    reporter.stop()
    expect(reporter.isActive()).toBe(false)
  })

  it("does not start twice", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const reporter = new StatusReporter(log, 15000)

    reporter.start(vi.fn())
    reporter.start(vi.fn())

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Already active"),
    )

    reporter.stop()
  })

  it("logs errors from gatherStatusData gracefully", async () => {
    // Force gatherStatusData to throw by mocking fs to throw
    const { readFileSync } = await import("node:fs")
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("disk error") })

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const reporter = new StatusReporter(log, 15000)
    const sendCallback = vi.fn()

    reporter.start(sendCallback)
    await vi.advanceTimersByTimeAsync(10)

    // Should still call callback (with empty/default data since sessions/cron fail gracefully)
    // The gatherStatusData catches errors internally, so it should still work
    expect(sendCallback).toHaveBeenCalled()

    reporter.stop()
  })
})
