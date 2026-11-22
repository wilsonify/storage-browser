# Quality baseline — S3 Browser

- **Measured:** 2026-11-22, before the T1–T6 quality pass changed any file.
- **Host:** Windows, Git Bash. **Node** 24.15.0, **npm** 11.12.1, **SonarQube** 26.10 (local).
- **Working directory for every command:** `s3-browser/` unless stated otherwise.
- **Commit at measurement:** `0b13ff6` (`fix: update forceKillProcessTree to use path.join for taskkill executable`), clean working tree.

Everything below is a command result, not an estimate. Each row names the command
that produces it, so the table can be re-created from a fresh checkout.

## 1. Test and build checks

| Check | Command | Result |
|---|---|---|
| Full test suite | `npm test` | **75 pass, 0 fail**, 0 skipped, 0 todo (0.46 s) |
| Worker/Cloudflare suite | `npm run test:cloudflare` | **51 pass, 0 fail** |
| Statement/line coverage | `node --test --experimental-test-coverage` | **77.00 %** |
| Branch coverage | same | **71.78 %** |
| Function coverage | same | **81.99 %** |
| Worker bundle | `wrangler deploy --dry-run --outdir <tmp>` | exit **0**; bundle builds, no deploy |
| Inline UI script parses | `vm.Script` over each `<script>` without `src` in `index.html` | **1 script, parses** |
| Lint | — | **not configured** (no ESLint/Prettier/`lint` script) |
| Type checking | — | **not configured** (plain ESM JavaScript, no `// @ts-check`) |
| CI | — | **not configured** (no workflow files) |
| Coverage threshold | — | **not configured** (no `--test-coverage-*` flags, no gate) |
| Node version pin | — | **absent** (no `engines`, no `.nvmrc`, no `packageManager`) |

## 2. Coverage by module (baseline)

Produced with `node --test --experimental-test-coverage`. Percentages are
`line / branch / function`.

| Module | Lines | Branches | Functions | Notes |
|---|---|---|---|---|
| `cloudflare/auth.mjs` | 93.18 | 80.18 | 94.44 | Access JWT verification |
| `cloudflare/s3-adapter.mjs` | 66.36 | 69.41 | 77.42 | Validators `validateBucketName`, `sanitizePrefix`, `normalizeKey`, `validateObjectKey` are the main gap |
| `cloudflare/worker.mjs` | 80.45 | 67.98 | 83.02 | 936-line handler: routing, upload, CORS, error mapping partly unexercised |
| `operations-store.mjs` | 97.00 | 66.67 | 90.00 | Branch gaps in recovery and cancel |
| `operations-worker.mjs` | 81.48 | 79.17 | 62.50 | `start`/`stop`/`kick` lifecycle never run |
| `s3-ops.mjs` | 64.51 | 73.85 | 77.42 | Copy/move/rename planning and local-walk branches |
| `server.mjs` | **not reported** | — | — | **Never imported by a test**, so it never enters the denominator (see below) |
| `scripts/run-command-with-timeout.mjs` | 0.00 | 0.00 | 0.00 | No tests |
| `index.html` inline script (1,429 lines) | 0.00 | 0.00 | 0.00 | Not loadable by Node; unmeasurable here |
| `scripts/package-win.mjs`, `scripts/build-sidecar.mjs` | 0.00 | 0.00 | 0.00 | Release-only tooling, no tests |
| `src-tauri/**` (Rust) | — | — | — | Not part of the Node test runner |

### Why `server.mjs` shows 0 % and not "missing"

Node's coverage report lists only modules that were **loaded** during the test
run. `server.mjs` has never been imported by a test, so at baseline it is absent
from the table entirely. That is worse than a low score: the 77.00 % figure is
computed on a denominator that silently excludes the 465-line local HTTP backend.
This pass puts `server.mjs` into the test run (factory seam + route tests) so it
enters the denominator instead of being hidden by it, and keeps it in the gate.

## 3. Dependency health

| Check | Command | Result |
|---|---|---|
| Production dependencies | `npm audit --omit=dev` | **0 vulnerabilities** (3 AWS SDK packages) |
| All dependencies | `npm audit` | **4 high**, all dev-only: `undici` under `wrangler` → `miniflare`. Fix offered by `npm audit fix`. |
| Extraneous packages | `npm ls --depth=0` | `@emnapi/runtime`, `@img/sharp-wasm32` (transitive leftovers, dev tree only) |

The advisory is in the local development/deploy toolchain, not in code that ships
to the Worker. It is recorded in [`remediation-plan.md`](remediation-plan.md) with
an owner and an expiry instead of being auto-fixed here: a `wrangler` major-chain
bump can change bundling, compatibility flags and the deploy path, so it needs its
own compatibility pass.

## 4. Static analysis (SonarQube)

Last completed scan earlier this session (`2026-11-22T14:35Z`):

| Metric | Value |
|---|---|
| Open issues | **0** |
| Security hotspots | **0** |
| Duplicated lines | 0 |
| Quality gate | **ERROR** — sole failing condition `new_coverage` at **0.0 %** (no coverage report was supplied) |

At the start of this pass the Sonar server did **not** answer on
`http://[::1]:9000` (`curl` → connection refused), so the baseline could not be
re-read live. This pass adds `sonar-project.properties` and a `sonar:check`
script so coverage is fed to Sonar and cross-checked instead of being absent.
The scan itself is re-run and reported when the server is reachable; until then
the Sonar row above is historical, not current.

## 5. Repository state

| Item | Value |
|---|---|
| Branch | `master` |
| HEAD | `0b13ff6` |
| Working tree | **clean** at measurement (`git status --porcelain` empty) |
| Earlier uncommitted work | The Firefox fixes, Sonar fixes and QA report from previous turns are now committed; nothing was discarded by this pass |

## 6. What passing tests prove — and what they do not

The 75 tests are **green and useful**: they assert folder expansion, path
preservation, budget pausing/resume, partial-delete reporting, cancel/retry
semantics, upload caps, download dispositions and JWT verification. They are the
reason the F-01…F-17 fixes have a regression net.

They do not prove:

- anything about `server.mjs`, which no test loads — the local desktop API is
  entirely unexercised;
- anything about the browser UI: its 1,429-line inline script is not measured and
  its behaviour is only covered by the manual/harness passes in
  [`production-qa-report.md`](production-qa-report.md);
- deployed behaviour: nothing here ran against Cloudflare Access, workerd
  (`wrangler dev` is blocked, F-19) or a deployed Worker;
- isolate behaviour: Worker operation state is module memory (F-07/F-18), which
  cannot be forced locally;
- release tooling: `scripts/package-win.mjs`, `scripts/build-sidecar.mjs` and the
  Tauri/Rust shell have no automated tests.

## 7. Absences, stated plainly

At baseline the project had **no lint configuration, no CI, no coverage
threshold, no dependency gate, no Node version pin and no end-to-end suite**.
The suite was healthy; the enforcement around it was absent. Those absences — not
a failing test — are what this pass addresses, and
[`quality-gates.md`](quality-gates.md) defines them as enforceable gates.

## Reproducing this baseline

The numbers above describe commit `0b13ff6`, before this pass added tests, so
reproducing them requires checking out that commit. The commands are recorded so
the measurement is auditable rather than remembered.

```bash
git checkout 0b13ff6
cd s3-browser
npm ci
npm test
npm run test:cloudflare
node --test --experimental-test-coverage
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir /tmp/verify-dry
npm audit --omit=dev
npm audit
```
