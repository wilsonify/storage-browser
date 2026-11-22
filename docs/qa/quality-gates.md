# Quality gates

A gate is a command that fails when a property regresses. Everything here is
local, free and dependency-light: Node's test runner, `node --check`, a
`wrangler deploy --dry-run`, `npm audit --omit=dev` and the SonarQube API.

`npm run verify` runs syntax (G3), the test+coverage gate (G1+G2), the bundle
dry-run (G4) and the production audit (G5) in order and stops at the first
failure. G6 (Sonar) and G7 (hygiene) are separate commands; they need a running
server and a layout check respectively.

Verified on 2026-11-22 after a fresh `npm ci`: `verify` exit 0 twice, with 203
tests passing and Scope A at 96.92 / 92.70 / 94.76.

## 1. Gate table

| # | Gate | Command | Blocks on |
|---|---|---|---|
| G1 | Tests | `npm test` | Any failing test |
| G2 | Coverage thresholds | `npm run test:coverage` | Scope A below 80 % lines / branches / functions, or a missed stricter per-area target |
| G3 | Syntax | `npm run check:syntax` | Any `.mjs`/`.js` file that does not parse, or an inline `<script>` in `index.html` that does not parse |
| G4 | Wrangler bundle | `npm run check:deploy` (`wrangler deploy --dry-run`) | Worker no longer bundles, or the Worker config is invalid |
| G5 | Production dependency audit | `npm run audit:prod` (`npm audit --omit=dev`) | Any advisory in shipped dependencies |
| G6 | Sonar gate | `npm run sonar:check` (needs `SONAR_TOKEN`, server up) | New issues, new hotspots, or quality gate ERROR |
| G7 | Artifact hygiene | `git check-ignore -v s3-browser/coverage/lcov.info s3-browser/.wrangler/verify` | Generated output not ignored (checked by hand; not part of `verify`) |

## 2. What each gate means

**G1 — tests.** The suite is the primary contract. Deleting or weakening a test
to pass a gate is a gate violation, not a fix. A test that asserts only a status
code is not sufficient for P0 behaviour; see
[`test-strategy.md`](test-strategy.md).

**G2 — coverage.** Scope, exclusions, thresholds and the ratchet rules live in
[`coverage-policy.md`](coverage-policy.md). The gate prints its own scope so the
number cannot be read without knowing what it covers.

**G3 — syntax.** Catches files the test runner never imports (release scripts,
build helpers) and the unmeasured inline UI script. This is a parse check, not a
lint; there is still no lint configuration (see
[`remediation-plan.md`](remediation-plan.md), P2).

**G4 — bundle.** `wrangler deploy --dry-run` builds the Worker bundle with the
real compatibility flags and writes nothing to Cloudflare. It prefers the local,
gitignored `wrangler.jsonc` and falls back to the committed
`wrangler.example.jsonc`, so a fresh clone and CI still validate the build. It is the closest local proxy for "this still deploys" and catches
bad imports, incompatible Node APIs and asset-config errors. It does not prove
workerd runtime behaviour; `wrangler dev` remains blocked (F-19).

**G5 — audit.** Only shipped dependencies are gated. The dev toolchain's `undici`
advisory is recorded, owned and time-limited in
[`remediation-plan.md`](remediation-plan.md) instead of being auto-upgraded in
this pass; a dev-tool crash cannot reach users, but a shipped advisory can.

**G6 — Sonar.** `sonar-project.properties` points Sonar at `coverage/lcov.info`
and the same Scope A exclusions. `sonar:check` reads two endpoints and fails on
either:

- `/api/qualitygates/project_status` — gate must be `OK`;
- `/api/measures/component` — `coverage` must match the local lcov percentage
  within **0.5 percentage points** (Sonar and Node count slightly differently:
  Sonar excludes some non-executable lines).

If coverage on Sonar is 0 while the local lcov is non-zero, the report was not
consumed: that is a failure, not a rounding difference. The gate is deliberately
queryable outside the scanner so the result can be verified independently.

**G7 — hygiene.** `s3-browser/coverage/` and `.wrangler/` (dry-run output) are
gitignored; `.assetsignore` allows only `index.html` and `assets/` into the
published Worker. This is a repository-configuration property, checked with
`git check-ignore` when the layout changes, not a step inside `verify`.

## 3. Local enforcement

`.githooks/pre-push` runs `npm run verify` and aborts the push on failure.
Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

Bypassing with `git push --no-verify` is allowed only with a stated reason in the
PR/commit message. The hook is a convenience; CI is the authority.

`.github/workflows/quality.yml` runs the cloud-safe subset (`npm ci`, tests,
coverage, syntax, bundle dry-run, prod audit) on Node 22 and 24 for every push and
pull request. The Sonar step is a separate job that runs only when the repository
provides a `SONAR_TOKEN` secret and a reachable server.

## 4. Review requirements beyond the gates

Gates cannot see intent. Changes touching these areas need a second reviewer and
the listed evidence in the PR:

| Change touches | Required evidence |
|---|---|
| `cloudflare/auth.mjs` | New/changed test for every new claim, algorithm or key branch; explicit fail-closed reasoning (503 vs 401) |
| `cloudflare/s3-adapter.mjs` validators | 100 % branch on the validator; a rejection test for every accepted shape |
| Delete / move / rename planning (`s3-ops.mjs`, `worker.mjs` `buildPlan`) | Test proving **resulting S3 state** (which keys remain), not the reported counter |
| Upload limits / download headers | Test asserting the stored bytes or the exact header value |
| `operations-store.mjs` persistence | Test reloading a fresh store from disk and asserting recovered status |
| Release tooling (`scripts/**`) | At minimum a syntax check and a stated untested surface |

**P0 rule:** a behavioural test for a destructive or auth path must assert the
resulting state — the store record, the keys left in the fake S3, the exact
response body/headers. `assert.equal(response.status, 200)` alone is not accepted
as coverage of the behaviour.

## 5. Exception process

There is no silent waiver. If a gate must be passed while red, the PR states:
which gate, the exact failing output, the user-visible risk, the owner, and the
date by which it will be green. A gate is never loosened in the same change that
needs the exception.
