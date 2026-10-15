import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(configHome, "opencode")
const pluginDir = join(configDir, "plugins")
const pluginFiles = ["opencode-telemetry.ts", "metrics.ts"]
const localMode = process.argv.includes("--local")
const updateMode = process.argv.includes("--update")
const localConfigPath = join(configDir, "opencode-telemetry.json")
const dependencies = {
  "@opentelemetry/api": "^1.9.1",
  "@opentelemetry/exporter-metrics-otlp-http": "^0.223.0",
  "@opentelemetry/resources": "^2.12.0",
  "@opentelemetry/sdk-metrics": "^2.12.0",
}

let localConfig
if (localMode) {
  let configExists = false
  try {
    await readFile(localConfigPath)
    configExists = true
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  if (configExists && !updateMode) {
    throw new Error(`${localConfigPath} already exists; use --update to preserve it while updating the plugin`)
  }

  if (!configExists) {
    const token = (await readFile(join(projectRoot, "secrets", "ingest-token.txt"), "utf8")).trim()
    if (token.length < 32) throw new Error("secrets/ingest-token.txt must contain at least 32 characters")
    localConfig = {
      endpoint: "http://localhost:4318/v1/metrics",
      token,
      team_name: "personal",
      user: "local-user",
      source: "local-machine",
    }
  }
}

await mkdir(pluginDir, { recursive: true })

for (const file of pluginFiles) {
  const destination = join(pluginDir, file)
  try {
    await readFile(destination)
    if (!updateMode) {
      throw new Error(`${destination} already exists; use --update to replace installed plugin files`)
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

for (const file of pluginFiles) {
  await copyFile(join(projectRoot, "opencode-plugin", file), join(pluginDir, file))
}

const manifestPath = join(configDir, "package.json")
let manifest = {}
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"))
} catch (error) {
  if (error.code !== "ENOENT") throw error
}

manifest.dependencies = { ...manifest.dependencies, ...dependencies }
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

const exampleConfig = join(projectRoot, "opencode-plugin", "opencode-telemetry.example.json")
const configExampleDestination = join(configDir, "opencode-telemetry.example.json")
try {
  await readFile(configExampleDestination)
} catch (error) {
  if (error.code !== "ENOENT") throw error
  await copyFile(exampleConfig, configExampleDestination)
}

if (localConfig) {
  await writeFile(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`, { mode: 0o600, flag: "wx" })
}

console.log(`${updateMode ? "Updated" : "Installed"} plugin files in ${pluginDir}`)
console.log(`Added OpenTelemetry dependencies to ${manifestPath}`)
if (localConfig) {
  console.log(`Created localhost telemetry config at ${localConfigPath}`)
} else if (localMode && updateMode) {
  console.log(`Preserved existing telemetry config at ${localConfigPath}`)
} else {
  console.log(`Copy opencode-telemetry.example.json to opencode-telemetry.json and set endpoint/token.`)
}
console.log("Restart OpenCode to load the plugin and install its dependencies.")
