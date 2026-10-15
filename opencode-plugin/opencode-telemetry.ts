import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createEventRecorder } from "./metrics.ts"

type PluginConfig = {
  endpoint: string
  token: string
  user: string
  source: string
}

export function validateEndpoint(endpoint: URL): string {
  const isLocalHttp = endpoint.protocol === "http:" &&
    (endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1")

  if (endpoint.protocol !== "https:" && !isLocalHttp) {
    throw new Error("endpoint must use HTTPS, except HTTP is allowed for localhost testing")
  }
  if (endpoint.pathname !== "/v1/metrics" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("endpoint must be the OTLP /v1/metrics URL without URL credentials or query parameters")
  }

  return endpoint.toString()
}

function configPath() {
  if (process.env.OPENCODE_TELEMETRY_CONFIG) {
    return process.env.OPENCODE_TELEMETRY_CONFIG
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "opencode", "opencode-telemetry.json")
}

async function loadConfig(): Promise<PluginConfig> {
  const config = JSON.parse(await readFile(configPath(), "utf8")) as PluginConfig
  const endpoint = new URL(config.endpoint)

  const validatedEndpoint = validateEndpoint(endpoint)
  if (typeof config.token !== "string" || config.token.trim().length < 32) {
    throw new Error("token must contain at least 32 characters")
  }
  if (!config.user?.trim() || !config.source?.trim()) {
    throw new Error("user and source must be non-empty")
  }

  return { ...config, endpoint: validatedEndpoint, token: config.token.trim() }
}

export const OpenCodeTelemetry: Plugin = async ({ client }) => {
  let config: PluginConfig
  try {
    config = await loadConfig()
  } catch (error) {
    await client.app.log({
      body: {
        service: "opencode-telemetry",
        level: "warn",
        message: "Telemetry plugin disabled; configuration is missing or invalid",
        extra: { reason: error instanceof Error ? error.message : "unknown error" },
      },
    }).catch(() => undefined)
    return {}
  }

  const exporter = new OTLPMetricExporter({
    url: config.endpoint,
    headers: { authorization: `Bearer ${config.token}` },
    timeoutMillis: 5000,
  })
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 15000,
    exportTimeoutMillis: 5000,
  })
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ "service.name": "opencode" }),
    readers: [reader],
  })
  const meter = provider.getMeter("opencode-telemetry", "0.1.0")
  const recorder = createEventRecorder(
    {
      requests: meter.createCounter("opencode.ai.requests", {
        description: "Completed assistant messages",
      }),
      tokens: meter.createCounter("opencode.tokens", {
        description: "Tokens reported for completed assistant messages",
        unit: "1",
      }),
      reportedCost: meter.createCounter("opencode.reported.cost", {
        description: "Cost value reported by OpenCode; currency is not normalized",
      }),
      requestDuration: meter.createHistogram("opencode.request.duration", {
        description: "Duration of completed assistant messages",
        unit: "s",
      }),
      sessions: meter.createCounter("opencode.sessions", {
        description: "OpenCode sessions created",
      }),
      errors: meter.createCounter("opencode.errors", {
        description: "OpenCode session errors",
      }),
    },
    { source: config.source, user: config.user },
  )

  await client.app.log({
    body: {
      service: "opencode-telemetry",
      level: "info",
      message: "Telemetry plugin initialized",
      extra: { source: config.source },
    },
  }).catch(() => undefined)

  return {
    event: async ({ event }) => recorder.handleEvent(event),
    dispose: async () => provider.shutdown().catch(() => undefined),
  }
}
