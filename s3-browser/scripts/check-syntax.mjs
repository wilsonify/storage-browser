import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "tauri-dist",
  ".wrangler",
  ".sea-build",
  "coverage",
  ".git",
]);
const CHECKED_EXTENSIONS = new Set([".mjs", ".js"]);

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "src-tauri") continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && CHECKED_EXTENSIONS.has(extname(entry.name))) files.push(fullPath);
  }
  return files;
}

let failures = 0;
const files = walk(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf-8" });
  if (result.status !== 0) {
    failures += 1;
    console.error(`syntax error: ${relative(root, file)}`);
    console.error((result.stderr || result.stdout || "").trim());
  }
}

// The hosted UI ships one 1,400-line inline script that no module test loads.
// Parsing it is the only automated check that covers it today (workstream T7/T8).
const html = readFileSync(join(root, "index.html"), "utf-8");
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
for (const [index, match] of inlineScripts.entries()) {
  try {
    new Script(match[1], { filename: `index.html#inline-${index + 1}` });
  } catch (error) {
    failures += 1;
    console.error(`syntax error in index.html inline script #${index + 1}: ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`\nSyntax check failed: ${failures} problem(s).`);
  process.exit(1);
}

console.log(`Syntax OK: ${files.length} module files and ${inlineScripts.length} inline script(s) parsed.`);
