import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDir = join(projectRoot, "dist")
const archivePath = join(outputDir, "opencode-telemetry-plugin.tar.gz")
const files = [
  "scripts/install-plugin.mjs",
  "opencode-plugin/opencode-telemetry.ts",
  "opencode-plugin/metrics.ts",
  "opencode-plugin/opencode-telemetry.example.json",
]

await mkdir(outputDir, { recursive: true })
const result = spawnSync("tar", ["-czf", archivePath, ...files], {
  cwd: projectRoot,
  stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const archive = await readFile(archivePath)
const digest = createHash("sha256").update(archive).digest("hex")
await writeFile(`${archivePath}.sha256`, `${digest}  opencode-telemetry-plugin.tar.gz\n`)
console.log(`Created ${archivePath}`)
console.log(`Created ${archivePath}.sha256`)
