import type { Counter, Histogram } from "@opentelemetry/api"
import type { Event, AssistantMessage } from "@opencode-ai/sdk"

export type TelemetryInstruments = {
  requests: Counter
  tokens: Counter
  reportedCost: Counter
  requestDuration: Histogram
  sessions: Counter
  errors: Counter
}

export type PluginIdentity = {
  source: string
  user: string
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function createEventRecorder(
  instruments: TelemetryInstruments,
  identity: PluginIdentity,
) {
  const completedMessages = new Set<string>()
  const baseAttributes = { source: identity.source, user: identity.user }

  function recordAssistantMessage(message: AssistantMessage) {
    if (typeof message.time.completed !== "number" || !Number.isFinite(message.time.completed)) return

    const messageKey = `${message.sessionID}:${message.id}`
    if (completedMessages.has(messageKey)) return
    completedMessages.add(messageKey)

    const attributes = {
      ...baseAttributes,
      provider: message.providerID,
      model: message.modelID,
    }

    instruments.requests.add(1, attributes)

    const tokenValues = [
      ["input", message.tokens.input],
      ["output", message.tokens.output],
      ["reasoning", message.tokens.reasoning],
      ["cache_read", message.tokens.cache.read],
      ["cache_write", message.tokens.cache.write],
    ] as const

    for (const [tokenType, value] of tokenValues) {
      if (validNumber(value)) {
        instruments.tokens.add(value, { ...attributes, token_type: tokenType })
      }
    }

    if (validNumber(message.cost)) {
      instruments.reportedCost.add(message.cost, attributes)
    }

    const durationMs = message.time.completed - message.time.created
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      instruments.requestDuration.record(durationMs / 1000, attributes)
    }
  }

  function handleEvent(event: Event) {
    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      recordAssistantMessage(event.properties.info)
      return
    }

    if (event.type === "session.created") {
      instruments.sessions.add(1, baseAttributes)
      return
    }

    if (event.type === "session.error") {
      instruments.errors.add(1, {
        ...baseAttributes,
        error_type: event.properties.error?.name ?? "unknown",
      })
    }
  }

  return { handleEvent }
}
