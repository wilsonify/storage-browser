import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.SONAR_HOST_URL || "http://[::1]:9000";
const projectKey = process.env.SONAR_PROJECT_KEY || "storage-browser";
const token = process.env.SONAR_TOKEN || "";
const coverageTolerance = Number(process.env.SONAR_COVERAGE_TOLERANCE || "0.5");

function localLineCoverage() {
  let found = 0;
  let hit = 0;
  for (const line of readFileSync(join(root, "coverage", "lcov.info"), "utf-8").split(/\r?\n/)) {
    if (line.startsWith("LF:")) found += Number(line.slice(3));
    if (line.startsWith("LH:")) hit += Number(line.slice(3));
  }
  return found > 0 ? (hit / found) * 100 : null;
}

async function getJson(path) {
  const response = await fetch(`${host}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} -> HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return response.json();
}

if (!token) {
  console.error("sonar:check: SONAR_TOKEN is not set. Nothing was verified.");
  process.exit(2);
}

const local = localLineCoverage();
if (local === null) {
  console.error("sonar:check: coverage/lcov.info is missing or empty. Run `npm run test:coverage` first.");
  process.exit(2);
}

let measures;
let gate;
let issues;
try {
  [measures, gate, issues] = await Promise.all([
    getJson(`/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=coverage,new_coverage`),
    getJson(`/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`),
    getJson(`/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&resolved=false&ps=1`),
  ]);
} catch (error) {
  console.error(`sonar:check: could not query SonarQube at ${host}: ${error.message}`);
  console.error("sonar:check: the gate was NOT verified.");
  process.exit(2);
}

const measure = (key) => measures.component?.measures?.find((item) => item.metric === key)?.value ?? null;
const sonarCoverage = measure("coverage") === null ? null : Number(measure("coverage"));
const gateStatus = gate.projectStatus?.status ?? "UNKNOWN";
const conditions = gate.projectStatus?.conditions ?? [];
const openIssues = issues.total ?? 0;

console.log(`SonarQube: ${host} (project ${projectKey})`);
console.log(`  local lcov line coverage: ${local.toFixed(2)}%`);
console.log(`  Sonar coverage:           ${sonarCoverage === null ? "n/a" : `${sonarCoverage.toFixed(2)}%`}`);
console.log(`  Sonar new_coverage:       ${measure("new_coverage") ?? "n/a"}`);
console.log(`  gate:                     ${gateStatus}`);
for (const condition of conditions.filter((item) => item.status !== "OK")) {
  console.log(`    failing: ${condition.metric} ${condition.actual ?? "n/a"} (${condition.comparator} ${condition.errorThreshold})`);
}
console.log(`  open issues:              ${openIssues}`);

let failed = false;

if (sonarCoverage === null) {
  console.error("\nsonar:fail: Sonar has no coverage measure, so the lcov report was not consumed.");
  failed = true;
} else if (Math.abs(sonarCoverage - local) > coverageTolerance) {
  console.error(
    `\nsonar:fail: Sonar coverage ${sonarCoverage.toFixed(2)}% differs from local ${local.toFixed(2)}% by more than ${coverageTolerance} points.`,
  );
  failed = true;
}

if (gateStatus !== "OK") {
  console.error(`\nsonar:fail: quality gate is ${gateStatus}.`);
  failed = true;
}

if (openIssues > 0) {
  console.error(`\nsonar:fail: ${openIssues} unresolved issue(s).`);
  failed = true;
}

if (failed) process.exit(1);
console.log("\nsonar:ok: gate OK and coverage matches the local lcov report.");
