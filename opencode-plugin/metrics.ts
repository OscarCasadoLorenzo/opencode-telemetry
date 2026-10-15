import type { Counter, Histogram } from "@opentelemetry/api"
import type { Event, AssistantMessage } from "@opencode-ai/sdk"

export type TelemetryInstruments = {
  requests: Counter
  tokens: Counter
  cost: Counter
  responseLatency: Histogram
  sessions: Counter
  errors: Counter
}

export type PluginIdentity = {
  teamName: string
  userName: string
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function createEventRecorder(
  instruments: TelemetryInstruments,
  identity: PluginIdentity,
) {
  const maxTrackedEntries = 10000
  const completedMessages = new Set<string>()
  const recordedModelErrors = new Set<string>()
  const recordedToolErrors = new Set<string>()
  const recordedSessions = new Set<string>()
  const messageAttributes = new Map<string, Record<string, string>>()
  const sessionAttributes = new Map<string, Record<string, string>>()
  const baseAttributes = {
    team_name: identity.teamName,
    user_name: identity.userName,
  }

  function remember(set: Set<string>, key: string) {
    if (set.has(key)) return false
    set.add(key)
    if (set.size > maxTrackedEntries) set.delete(set.values().next().value!)
    return true
  }

  function rememberAttributes(map: Map<string, Record<string, string>>, key: string, value: Record<string, string>) {
    map.delete(key)
    map.set(key, value)
    if (map.size > maxTrackedEntries) map.delete(map.keys().next().value!)
  }

  function recordError(type: string, attributes: Record<string, string>) {
    instruments.errors.add(1, { ...attributes, type })
  }

  function recordAssistantMessage(message: AssistantMessage) {
    const messageKey = `${message.sessionID}:${message.id}`
    const attributes = {
      ...baseAttributes,
      agent: message.mode || "unknown",
      provider: message.providerID || "unknown",
      model: message.modelID || "unknown",
      session_id: message.sessionID,
    }
    rememberAttributes(messageAttributes, messageKey, attributes)
    rememberAttributes(sessionAttributes, message.sessionID, attributes)

    if (message.error && remember(recordedModelErrors, messageKey)) {
      recordError("model", attributes)
    }

    if (typeof message.time.completed !== "number" || !Number.isFinite(message.time.completed)) return

    if (!remember(completedMessages, messageKey)) return

    instruments.requests.add(1, attributes)

    const tokenValues = [
      ["input", message.tokens.input],
      ["output", message.tokens.output],
      ["reasoning", message.tokens.reasoning],
      ["cacheRead", message.tokens.cache.read],
      ["cacheWrite", message.tokens.cache.write],
    ] as const

    for (const [type, value] of tokenValues) {
      if (validNumber(value)) {
        instruments.tokens.add(value, { ...attributes, type })
      }
    }

    if (validNumber(message.cost)) {
      instruments.cost.add(message.cost, attributes)
    }

    const durationMs = message.time.completed - message.time.created
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      instruments.responseLatency.record(durationMs, {
        team_name: identity.teamName,
        user_name: identity.userName,
        agent: attributes.agent,
        provider: attributes.provider,
        model: attributes.model,
      })
    }
  }

  function handleEvent(event: Event) {
    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      recordAssistantMessage(event.properties.info)
      return
    }

    if (event.type === "session.created") {
      const sessionID = event.properties.info.id
      if (remember(recordedSessions, sessionID)) {
        instruments.sessions.add(1, { ...baseAttributes, session_id: sessionID })
      }
      return
    }

    if (event.type === "session.error") {
      const sessionID = event.properties.sessionID ?? "unknown"
      recordError("session", {
        ...(sessionAttributes.get(sessionID) ?? {
          ...baseAttributes,
          agent: "unknown",
          provider: "unknown",
          model: "unknown",
        }),
        session_id: sessionID,
      })
      return
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type !== "tool" || part.state.status !== "error") return

      if (!remember(recordedToolErrors, `${part.sessionID}:${part.callID}`)) return
      const attributes = messageAttributes.get(`${part.sessionID}:${part.messageID}`) ?? {
        ...baseAttributes,
        agent: "unknown",
        provider: "unknown",
        model: "unknown",
        session_id: part.sessionID,
      }
      recordError("tool", attributes)
    }
  }

  return { handleEvent }
}
