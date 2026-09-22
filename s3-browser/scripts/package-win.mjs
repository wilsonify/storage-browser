import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandStep } from "./run-command-with-timeout.mjs";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(rootDir, ".sea-build");
const distDir = join(rootDir, "dist");

const bundlePath = join(buildDir, "app.cjs");
const seaConfigPath = join(buildDir, "sea-config.json");
const seaBlobPath = join(buildDir, "sea-prep.blob");
const outputExePath = join(distDir, "s3-browser.exe");
const appIconIcoPath = join(rootDir, "assets", "s3_browser_icon.ico");

const TIMEOUTS = {
  bundleMs: 2 * 60 * 1000,
  seaBlobMs: 2 * 60 * 1000,
  injectBlobMs: 2 * 60 * 1000,
  setIconMs: 90 * 1000,
};

const strictIconStamp = process.env.S3_BROWSER_STRICT_ICON_STAMP === "1";

function esbuildCommand() {
  if (process.platform === "win32") {
    return join(rootDir, "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
  }
  return join(rootDir, "node_modules", ".bin", "esbuild");
}

function postjectCommandArgs() {
  if (process.platform === "win32") {
    return [process.execPath, join(rootDir, "node_modules", "postject", "dist", "cli.js")];
  }
  return [join(rootDir, "node_modules", ".bin", "postject")];
}

function rceditCommandArgs() {
  if (process.platform !== "win32") return null;
  return [join(rootDir, "node_modules", "rcedit", "bin", "rcedit.exe")];
}

const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(major) || major < 20) {
  throw new Error(`Node 20+ is required for SEA packaging. Current: ${process.version}`);
}

await mkdir(buildDir, { recursive: true });
await mkdir(distDir, { recursive: true });

await runCommandStep({
  stepLabel: "1/4 Bundle server",
  command: esbuildCommand(),
  args: [
  "server.mjs",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node24",
  `--outfile=${bundlePath}`,
  ],
  cwd: rootDir,
  timeoutMs: TIMEOUTS.bundleMs,
});

const seaConfig = {
  main: bundlePath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
  assets: {
    "index.html": join(rootDir, "index.html"),
    "s3_browser_icon.svg": join(rootDir, "assets", "s3_browser_icon.svg"),
    "s3_browser_icon.ico": appIconIcoPath,
  },
};

await writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2), "utf-8");
await runCommandStep({
  stepLabel: "2/4 Build SEA blob",
  command: process.execPath,
  args: ["--experimental-sea-config", seaConfigPath],
  cwd: rootDir,
  timeoutMs: TIMEOUTS.seaBlobMs,
});

await copyFile(process.execPath, outputExePath);
const postject = postjectCommandArgs();
await runCommandStep({
  stepLabel: "3/4 Inject SEA blob",
  command: postject[0],
  args: [
  ...postject.slice(1),
  outputExePath,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  SEA_FUSE,
  ],
  cwd: rootDir,
  timeoutMs: TIMEOUTS.injectBlobMs,
});

const rcedit = rceditCommandArgs();
if (rcedit) {
  try {
    await runCommandStep({
      stepLabel: "4/4 Stamp EXE icon",
      command: rcedit[0],
      args: [outputExePath, "--set-icon", appIconIcoPath],
      cwd: rootDir,
      timeoutMs: TIMEOUTS.setIconMs,
    });
  } catch (err) {
    if (strictIconStamp) throw err;
    console.warn("\n[4/4 Stamp EXE icon] Non-fatal warning: icon stamping failed or timed out.");
    console.warn("Set S3_BROWSER_STRICT_ICON_STAMP=1 to make this step fail the build.");
    console.warn(err.message);
  }
}

const exeStat = await stat(outputExePath);
console.log(`Built ${outputExePath} (${exeStat.size} bytes)`);
