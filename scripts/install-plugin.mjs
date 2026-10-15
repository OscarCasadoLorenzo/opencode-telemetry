import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(configHome, "opencode")
const pluginDir = join(configDir, "plugins")
const pluginFiles = ["opencode-telemetry.ts", "metrics.ts"]
const dependencies = {
  "@opentelemetry/api": "^1.9.1",
  "@opentelemetry/exporter-metrics-otlp-http": "^0.223.0",
  "@opentelemetry/resources": "^2.12.0",
  "@opentelemetry/sdk-metrics": "^2.12.0",
}

await mkdir(pluginDir, { recursive: true })

for (const file of pluginFiles) {
  const destination = join(pluginDir, file)
  try {
    await readFile(destination)
    throw new Error(`${destination} already exists; move it aside before installing`)
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

console.log(`Installed plugin files in ${pluginDir}`)
console.log(`Added OpenTelemetry dependencies to ${manifestPath}`)
console.log(`Copy opencode-telemetry.example.json to opencode-telemetry.json and set endpoint/token.`)
console.log("Restart OpenCode to load the plugin and install its dependencies.")
