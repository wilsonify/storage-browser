import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandStep } from "./run-command-with-timeout.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distExe = join(rootDir, "dist", "s3-browser.exe");
const sidecarDir = join(rootDir, "src-tauri", "bin");
const sidecarPath = join(sidecarDir, "s3-backend-x86_64-pc-windows-msvc.exe");

await runCommandStep({
  stepLabel: "Build backend executable",
  command: process.execPath,
  args: ["scripts/package-win.mjs"],
  cwd: rootDir,
  timeoutMs: 5 * 60 * 1000,
  env: {
    S3_BROWSER_SKIP_ICON_STAMP: "1",
    S3_BROWSER_STRICT_ICON_STAMP: "0",
  },
});

await mkdir(sidecarDir, { recursive: true });
await copyFile(distExe, sidecarPath);

const stats = await stat(sidecarPath);
console.log(`Sidecar ready: ${sidecarPath} (${stats.size} bytes)`);
