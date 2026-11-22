import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localConfig = join(root, "wrangler.jsonc");
const exampleConfig = join(root, "wrangler.example.jsonc");

const hasLocalConfig = existsSync(localConfig);
if (hasLocalConfig) {
  console.log("check:deploy: validating the local wrangler.jsonc.");
} else {
  console.log("check:deploy: wrangler.jsonc not found; validating the committed wrangler.example.jsonc.");
  console.log("check:deploy: copy wrangler.example.jsonc to wrangler.jsonc to validate your real deployment.");
}

// Invoke the CLI entry with Node directly: no shell wrapper (and no Windows
// .cmd quoting), and the same behaviour on every platform.
const wranglerEntry = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

const args = [
  "deploy",
  "--dry-run",
  "--outdir",
  ".wrangler/verify",
  "--config",
  hasLocalConfig ? localConfig : exampleConfig,
];

const child = spawn(process.execPath, [wranglerEntry, ...args], { cwd: root, stdio: "inherit" });

child.on("error", (error) => {
  console.error(`check:deploy: could not run wrangler: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});
