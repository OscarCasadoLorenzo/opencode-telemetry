import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const dashboard = JSON.parse(readFileSync(new URL("../grafana/dashboards/opencode-usage.json", import.meta.url), "utf8")) as {
  uid: string
  panels: Array<{ id: number; targets?: Array<{ expr: string }> }>
  templating: { list: Array<{ name: string }> }
}

describe("provisioned Grafana dashboard", () => {
  it("uses the telemetry metric families and labels emitted by the plugin", () => {
    const expressions = dashboard.panels.flatMap((panel) => panel.targets?.map((target) => target.expr) ?? [])
    const metricFamilies = new Set(
      expressions.flatMap((expression) => [...expression.matchAll(/\b(opencode_[A-Za-z0-9_]+)/g)].map((match) => match[1])),
    )

    expect(dashboard.uid).toBe("opencode-usage")
    expect(metricFamilies).toEqual(new Set([
      "opencode_token_usage_tokens_total",
      "opencode_request_count_total",
      "opencode_session_count_total",
      "opencode_response_latency_milliseconds_bucket",
      "opencode_error_count_total",
      "opencode_cost_usage_USD_total",
    ]))
    expect(dashboard.templating.list.map((variable) => variable.name)).toEqual([
      "team_name",
      "user_name",
      "agent",
      "model",
      "provider",
      "token_type",
      "session_id",
    ])
    expect(expressions.join("\n")).not.toMatch(/opencode_(?:tokens_total|ai_requests_total|reported_cost_total)/)
  })

  it("keeps session IDs off the latency histogram to bound its cardinality", () => {
    const latencyQueries = dashboard.panels
      .flatMap((panel) => panel.targets ?? [])
      .filter((target) => target.expr.includes("opencode_response_latency_milliseconds_bucket"))

    expect(latencyQueries.length).toBeGreaterThan(0)
    expect(latencyQueries.every((target) => !target.expr.includes("session_id"))).toBe(true)
  })
})
