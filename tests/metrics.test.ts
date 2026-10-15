import { describe, expect, it, vi } from "vitest"
import { createEventRecorder, type TelemetryInstruments } from "../opencode-plugin/metrics.ts"
import type { AssistantMessage, Event } from "@opencode-ai/sdk"

function instruments(): TelemetryInstruments {
  return {
    requests: { add: vi.fn() } as never,
    tokens: { add: vi.fn() } as never,
    reportedCost: { add: vi.fn() } as never,
    requestDuration: { record: vi.fn() } as never,
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

describe("OpenCode event recorder", () => {
  it("records completed assistant usage once, without project or session labels", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, { source: "personal-mac", user: "test-user" })
    const message = assistantMessage()
    const event = { type: "message.updated", properties: { info: message } } as Event

    recorder.handleEvent(event)
    recorder.handleEvent(event)

    expect(metrics.requests.add).toHaveBeenCalledTimes(1)
    expect(metrics.requests.add).toHaveBeenCalledWith(1, {
      source: "personal-mac",
      user: "test-user",
      provider: "provider-y",
      model: "model-x",
    })
    expect(metrics.tokens.add).toHaveBeenCalledTimes(5)
    expect(metrics.reportedCost.add).toHaveBeenCalledWith(0.012, expect.objectContaining({ model: "model-x" }))
    expect(metrics.requestDuration.record).toHaveBeenCalledWith(2, expect.objectContaining({ model: "model-x" }))
    expect(JSON.stringify(metrics)).not.toContain("/private/project")
    expect(JSON.stringify(metrics)).not.toContain("session-1")
  })

  it("ignores unfinished assistant messages", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, { source: "personal-mac", user: "test-user" })
    const event = {
      type: "message.updated",
      properties: { info: assistantMessage({ time: { created: 1000, completed: undefined } }) },
    } as Event

    recorder.handleEvent(event)

    expect(metrics.requests.add).not.toHaveBeenCalled()
    expect(metrics.tokens.add).not.toHaveBeenCalled()
  })

  it("counts sessions and labels errors only by bounded error type", () => {
    const metrics = instruments()
    const recorder = createEventRecorder(metrics, { source: "personal-mac", user: "test-user" })

    recorder.handleEvent({ type: "session.created", properties: { info: {} } } as Event)
    recorder.handleEvent({
      type: "session.error",
      properties: { sessionID: "session-1", error: { name: "MessageAbortedError", data: { message: "private" } } },
    } as Event)

    expect(metrics.sessions.add).toHaveBeenCalledWith(1, { source: "personal-mac", user: "test-user" })
    expect(metrics.errors.add).toHaveBeenCalledWith(1, {
      source: "personal-mac",
      user: "test-user",
      error_type: "MessageAbortedError",
    })
    expect(metrics.errors.add).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionID: expect.anything() }))
  })
})
