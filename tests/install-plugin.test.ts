import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const temporaryDirectories: string[] = []
const projectRoot = new URL("..", import.meta.url).pathname

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("plugin installer updates", () => {
  it("updates plugin files without replacing the existing telemetry config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "opencode-telemetry-installer-"))
    temporaryDirectories.push(configDir)

    const environment = { ...process.env, OPENCODE_CONFIG_DIR: configDir }
    const installer = join(projectRoot, "scripts", "install-plugin.mjs")
    const initialInstall = spawnSync(process.execPath, [installer], { encoding: "utf8", env: environment })
    expect(initialInstall.status).toBe(0)

    const configPath = join(configDir, "opencode-telemetry.json")
    const preservedConfig = JSON.stringify({ token: "keep-this-existing-token", team_name: "team-a" })
    await writeFile(configPath, preservedConfig)
    const pluginPath = join(configDir, "plugins", "opencode-telemetry.ts")
    await writeFile(pluginPath, "stale plugin contents")

    const update = spawnSync(process.execPath, [installer, "--update"], { encoding: "utf8", env: environment })

    expect(update.status).toBe(0)
    expect(await readFile(configPath, "utf8")).toBe(preservedConfig)
    expect(await readFile(pluginPath, "utf8")).not.toBe("stale plugin contents")
    expect(update.stdout).toContain("Updated plugin files")
  })
})
