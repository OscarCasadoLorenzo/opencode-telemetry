import { describe, expect, it, vi } from "vitest"
import { createEventRecorder, type TelemetryInstruments } from "../opencode-plugin/metrics.ts"
import { validateEndpoint } from "../opencode-plugin/opencode-telemetry.ts"
import type { AssistantMessage, Event } from "@opencode-ai/sdk"

function instruments(): TelemetryInstruments {
  return {
    requests: { add: vi.fn() } as never,
    tokens: { add: vi.fn() } as never,
    cost: { add: vi.fn() } as never,
    responseLatency: { record: vi.fn() } as never,
    sessions: { add: vi.fn() } as never,
    errors: { add: vi.fn() } as never,
  }
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 1000, completed: 3000 },
    parentID: "user-message-1",
    modelID: "model-x",
    providerID: "provider-y",
    mode: "build",
    path: { cwd: "/private/project", root: "/private" },
    cost: 0.012,
    tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
    ...overrides,
  }
}

describe("telemetry endpoint validation", () => {
  it("allows HTTPS endpoints and localhost HTTP testing", () => {
    expect(validateEndpoint(new URL("https://metrics.example.net/v1/metrics")))
      .toBe("https://metrics.example.net/v1/metrics")
    expect(validateEndpoint(new URL("http://localhost:4318/v1/metrics")))
      .toBe("http://localhost:4318/v1/metrics")
  })

  it("rejects non-local HTTP and malformed OTLP endpoints", () => {
    expect(() => validateEndpoint(new URL("http://metrics.example.net/v1/metrics"))).toThrow(/HTTPS/)
    expect(() => validateEndpoint(new URL("http://localhost:4318/other"))).toThrow(/\/v1\/metrics/)
  })
})

describe("OpenCode event recorder", () => {
  it("records completed assistant usage once with dashboard labels", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, {
      teamName: "personal",
      userName: "test-user",
    })
    const message = assistantMessage()
    const event = { type: "message.updated", properties: { info: message } } as Event

    recorder.handleEvent(event)
    recorder.handleEvent(event)

    expect(metrics.requests.add).toHaveBeenCalledTimes(1)
    expect(metrics.requests.add).toHaveBeenCalledWith(1, {
      team_name: "personal",
      user_name: "test-user",
      agent: "build",
      provider: "provider-y",
      model: "model-x",
      session_id: "session-1",
    })
    expect(metrics.tokens.add).toHaveBeenCalledTimes(5)
    expect(metrics.tokens.add).toHaveBeenCalledWith(4, expect.objectContaining({ type: "cacheRead" }))
    expect(metrics.tokens.add).toHaveBeenCalledWith(5, expect.objectContaining({ type: "cacheWrite" }))
    expect(metrics.cost.add).toHaveBeenCalledWith(0.012, expect.objectContaining({ model: "model-x" }))
    expect(metrics.responseLatency.record).toHaveBeenCalledWith(2000, expect.objectContaining({
      team_name: "personal",
      agent: "build",
      model: "model-x",
    }))
    const requestCalls = JSON.stringify((metrics.requests.add as unknown as ReturnType<typeof vi.fn>).mock.calls)
    expect(requestCalls).not.toContain("/private/project")
    expect(requestCalls).toContain("session-1")
  })

  it("ignores unfinished assistant messages", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, {
      teamName: "personal",
      userName: "test-user",
    })
    const event = {
      type: "message.updated",
      properties: { info: assistantMessage({ time: { created: 1000, completed: undefined } }) },
    } as Event

    recorder.handleEvent(event)

    expect(metrics.requests.add).not.toHaveBeenCalled()
    expect(metrics.tokens.add).not.toHaveBeenCalled()
  })

  it("counts sessions and labels errors by bounded category", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, {
      teamName: "personal",
      userName: "test-user",
    })

    const sessionCreated = {
      type: "session.created",
      properties: { info: { id: "session-1" } },
    } as Event
    recorder.handleEvent(sessionCreated)
    recorder.handleEvent(sessionCreated)
    recorder.handleEvent({
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "MessageAbortedError", data: { message: "private" } } },
    } as Event)

    expect(metrics.sessions.add).toHaveBeenCalledWith(1, {
      team_name: "personal",
      user_name: "test-user",
      session_id: "session-1",
    })
    expect(metrics.sessions.add).toHaveBeenCalledTimes(1)
    expect(metrics.errors.add).toHaveBeenCalledWith(1, {
      team_name: "personal",
      user_name: "test-user",
      agent: "unknown",
      provider: "unknown",
      model: "unknown",
      session_id: "session-1",
      type: "session",
    })
    expect(metrics.errors.add).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      error_type: expect.anything(),
    }))
  })

  it("counts assistant and tool failures once by bounded error category", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, {
      teamName: "personal",
      userName: "test-user",
    })
    const failedMessage = assistantMessage({
      error: { name: "APIError", data: { message: "private", isRetryable: false } },
    })
    const failedMessageEvent = {
      type: "message.updated",
      properties: { info: failedMessage },
    } as Event
    const failedToolEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "session-1",
          messageID: "message-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: { status: "error", input: {}, error: "private", time: { start: 1000, end: 2000 } },
        },
      },
    } as Event

    recorder.handleEvent(failedMessageEvent)
    recorder.handleEvent(failedMessageEvent)
    recorder.handleEvent(failedToolEvent)
    recorder.handleEvent(failedToolEvent)

    expect(metrics.errors.add).toHaveBeenCalledTimes(2)
    expect(metrics.errors.add).toHaveBeenCalledWith(1, expect.objectContaining({ type: "model" }))
    expect(metrics.errors.add).toHaveBeenCalledWith(1, expect.objectContaining({ type: "tool", agent: "build" }))
    const errorCalls = (metrics.errors.add as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(JSON.stringify(errorCalls)).not.toContain("private")
  })
})
