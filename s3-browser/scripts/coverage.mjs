import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Scope A: everything a regression must be able to fail on.
const INCLUDED = [
  "cloudflare/**/*.mjs",
  "s3-ops.mjs",
  "operations-store.mjs",
  "operations-worker.mjs",
  "server.mjs",
  "scripts/run-command-with-timeout.mjs",
];

// Documented in docs/qa/coverage-policy.md. Reported here on every run so the
// percentage can never be read without knowing what it leaves out.
const EXCLUDED = [
  "index.html inline script - not loadable by Node; workstream T7/T8",
  "scripts/package-win.mjs, scripts/build-sidecar.mjs - release-only tooling",
  "scripts/clean.mjs, scripts/timeout-probe.mjs, scripts/coverage.mjs, scripts/check-syntax.mjs, scripts/sonar-check.mjs - dev tooling",
  "src-tauri/** - Rust/Tauri shell, not a Node module",
  "test/** and cloudflare/*.test.mjs - test code",
  "node_modules, dist, tauri-dist, coverage, .wrangler - generated or vendored",
];

const output = join(root, "coverage", "lcov.info");
mkdirSync(dirname(output), { recursive: true });

console.log("Coverage scope (Scope A):");
for (const pattern of INCLUDED) console.log(`  include ${pattern}`);
console.log("Not measured (reported, not hidden):");
for (const reason of EXCLUDED) console.log(`  exclude ${reason}`);
console.log("Thresholds: lines 80, branches 80, functions 80\n");

const args = [
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-lines=80",
  "--test-coverage-branches=80",
  "--test-coverage-functions=80",
  ...INCLUDED.flatMap((pattern) => ["--test-coverage-include", pattern]),
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=lcov",
  "--test-reporter-destination=coverage/lcov.info",
];

const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });

child.on("error", (error) => {
  console.error(`coverage: failed to start the test runner: ${error.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  if (code === 0) {
    console.log(`\nlcov written to ${output}`);
    console.log("Coverage thresholds passed on Scope A.");
  } else {
    console.error("\nCoverage gate failed: see the per-file table above for uncovered lines.");
  }
  process.exit(code ?? 1);
});
