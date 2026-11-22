# Remediation plan

Ordered by risk. Each item has an owner class, a concrete acceptance criterion and
where it is tracked. Items marked **done in this pass** are delivered by T1–T6;
the rest are explicitly deferred.

## P0 — block release until closed

None open after this pass. The two historical P0-equivalents are covered by
regression tests: folder operations acting on the prefix marker (F-01) and bulk
delete exceeding the subrequest budget after partial destruction (F-02).

## P1 — close before the next production deploy

| Item | Why it still matters | Acceptance | Tracked |
|---|---|---|---|
| Deploy the fixes and run the post-deploy pass | Every F-01…F-17 fix is verified locally only; production still runs the old bundle | Post-deploy checklist in `production-qa-report.md` passes against the deployed deployment | Owner action, not code |
| F-04 intermittent 30 MiB download 500 | Single unexplained production 500, not reproduced locally | Reproduce with `wrangler tail` at debug level or a Range/stream test; then either fix or document the edge cause | P1, needs production access |
| F-23 cancelled large upload still lands | The UI can say "cancelled" for bytes that are stored | Reconciliation re-check on the next refresh flips the row to `Uploaded — finished before cancel arrived` | P1, UI (T7 dependent) |
| Access boundary has no automated end-to-end test | A stubbed `authenticate` in tests proves routing, not the real JWKS contract | One test against a locally served JWKS + a signed token is already covered; the gap is Cloudflare-side policy | Accepted limitation, see below |

## P2 — next quality increment

| Item | Acceptance criterion | Effort |
|---|---|---|
| **Lint configuration** | ESLint flat config with `no-unused-vars`, `no-undef`, `eqeqeq`, `no-floating-promises`-equivalent via `node --check` + recommended rules; `npm run lint` green; wired into `verify` | S |
| **CI authority** | `.github/workflows/quality.yml` green on Node 22 and 24 for a push and a PR; no secrets needed for G1–G5/G7 | S (delivered, needs first green run) |
| **Sonar coverage on every run** | `sonar:check` returns gate `OK` and Sonar `coverage` within 0.5 pp of local | M (blocked: server unreachable during this pass) |
| **Dev dependency advisory** (`undici` via `wrangler`→`miniflare`, 4 high) | Assess `wrangler` upgrade in a branch: `npm ci`, full suite, dry-run bundle size and deploy compatibility flags unchanged; then bump. **Owner:** repository maintainer. **Expiry:** 2026-12-22. | M |
| **Mutation testing** | StrykerJS (or `mutation-testing` via Node) on `cloudflare/s3-adapter.mjs` and `s3-ops.mjs`; mutation score ≥ 60 % on validators and delete/move planning; surviving mutants triaged | M |
| **`wrangler dev` (F-19)** | Move published assets to a dedicated `public/` directory (`.assetsignore` allowlist retired), then `wrangler dev` answers a request and a delete runs in workerd | M |
| **Server input hardening review** | Local server is loopback-only and unauthenticated by design; confirm it refuses non-loopback binds unless explicitly configured | S |
| **Extraneous dev packages** | `npm prune`, then confirm `npm ls --depth=0` has no `extraneous` entries and the dry-run still builds | S |
| **Q-01 folder rename leaves the source marker** | After renaming `old/` to `new/`, `old/` is gone from the listing (currently the empty marker object survives). Update `worker-failure.test.mjs` "a folder rename rewrites the prefix…", which currently asserts the leftover on purpose. | S |

## P3 — backlog, no release impact

Q-01 (folder rename marker, above) is P3 but listed under P2 because it is a small,
fully-scoped fix discovered by this pass.

| Item | Acceptance criterion |
|---|---|
| Persist job records (F-07/F-18) | Jobs survive a restart: enqueue, advance part-way, recreate the handler, `GET /api/operations/:id` returns the record with `remainingCount` |
| Rust/Tauri shell tests | `cargo test` in `src-tauri` with at least one test per command wrapper; `cargo clippy` clean |
| Accessibility audit (F-09) | axe-core pass on the shipped UI with zero critical violations; native `prompt()`/`confirm()` replaced by an in-app dialog |
| Performance budgets | Budget for cold Worker request latency and download throughput, measured in the harness; regression fails a non-blocking report |
| Specification tree (F-10) | Small `specs/` set for operation semantics, upload limits, access rules |
| Folder download / ZIP (F-11) | Product decision first; then a test proving archive contents |

## Limitations that are documented, not solved

| Limitation | Why it cannot be closed here | Consequence |
|---|---|---|
| Isolate eviction / real concurrency (F-07, F-18) | Requires deploying and forcing isolate recycling or concurrent isolates; not reproducible locally | Worker jobs can vanish mid-operation; UI text and retry linkage are the mitigation |
| `wrangler dev` / workerd compatibility (F-19) | Dev server reload loop caused by asset layout (F-19); fixing it is a packaging change | No workerd runtime test; `wrangler deploy --dry-run` only proves bundling |
| Cloudflare Access in production | Access cannot be satisfied from localhost; tests use a real JWT + local JWKS but stub the edge policy | Edge policy correctness is a deployment check, not a unit check |
| UI behaviour | 1,429-line inline script is not measurable in Node; see T7/T8 | No statement coverage of UI logic; flows are proven only by the manual/harness QA report |
| `server.mjs` platform launchers | `openBrowser` spawns OS processes; only the `S3_BROWSER_NO_OPEN=1` path is safe to test | Browser auto-open is unverified; it is convenience-only |
| `scripts/package-win.mjs`, `build-sidecar.mjs`, `src-tauri` | Release-only tooling; no tests | A packaging regression is caught only by running the package build |

## Separate workstream: T7/T8 (UI)

Deliberately **not** part of this pass. Approved separately.

**T7 — extract and measure.** Move the 1,429-line inline script out of
`index.html` into `app.js` (module), update the SEA/asset packaging and the local
harness, and add it to the coverage denominator.

- Rollback: the extraction is mechanical and must not change behaviour; keep
  `index.html` and `app.js` in one commit so `git revert` is a single step.
- Re-verification required: Chromium **and** Firefox harness runs of the flows in
  `production-qa-report.md` §browser verification, because the extraction touches
  every handler (F-20…F-22 were Firefox-only defects).
- Acceptance: `index.html` contains no logic beyond bootstrap; `app.js` parses and
  is imported by at least a smoke test; no published-asset regression.

**T8 — browser coverage.** Instrument `app.js` in the harness (Chromium V8
coverage → lcov), map it into Sonar, and gate a **separate** UI threshold. Do not
merge UI and Scope A percentages: they have different denominators and different
failure modes. Acceptance: a UI lcov report produced by a scripted harness run,
Sonar shows non-zero UI coverage, and a documented extraction of which flows are
not scripted.

## Sequencing

1. Owner: deploy and complete the post-deploy QA pass.
2. This pass: T1–T6 (docs, server tests, failure-path tests, coverage gate,
   Sonar wiring, verify/hook/CI).
3. P2 lint + advisory upgrade in their own branches.
4. T7, then T8, each with its own rollback and Firefox/Chromium re-verification.
