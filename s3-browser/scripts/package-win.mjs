import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(rootDir, ".sea-build");
const distDir = join(rootDir, "dist");

const bundlePath = join(buildDir, "app.cjs");
const seaConfigPath = join(buildDir, "sea-config.json");
const seaBlobPath = join(buildDir, "sea-prep.blob");
const outputExePath = join(distDir, "s3-browser.exe");

function runOrThrow(command, args, useShell = false) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: useShell,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

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

const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(major) || major < 20) {
  throw new Error(`Node 20+ is required for SEA packaging. Current: ${process.version}`);
}

await mkdir(buildDir, { recursive: true });
await mkdir(distDir, { recursive: true });

runOrThrow(esbuildCommand(), [
  "server.mjs",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node24",
  `--outfile=${bundlePath}`,
]);

const seaConfig = {
  main: bundlePath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
  assets: {
    "index.html": join(rootDir, "index.html"),
  },
};

await writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2), "utf-8");
runOrThrow(process.execPath, ["--experimental-sea-config", seaConfigPath]);

await copyFile(process.execPath, outputExePath);
const postject = postjectCommandArgs();
runOrThrow(postject[0], [
  ...postject.slice(1),
  outputExePath,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  SEA_FUSE,
]);

const exeStat = await stat(outputExePath);
console.log(`Built ${outputExePath} (${exeStat.size} bytes)`);
