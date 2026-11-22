# Test strategy

## 1. What each layer is for

| Layer | Files | Proves | Does not prove |
|---|---|---|---|
| Unit — validation | `cloudflare/s3-adapter-validation.test.mjs`, `worker.test.mjs` | Traversal/bucket/key guards accept exactly the documented shapes | That callers use them correctly |
| Unit — planning | `test/s3-ops-branches.test.mjs`, `test/s3-ops-move.test.mjs`, `test/s3-ops-local-sync.test.mjs` | Which S3 commands run, in what order, with which keys, after which skip rules | Real S3 semantics, pagination behaviour of the service |
| State machine | `test/operations-store-failure.test.mjs`, `test/operations-worker-failure.test.mjs`, `cloudflare/operations.test.mjs`, `cloudflare/worker-failure.test.mjs` | Queue transitions, pauses, retries, cancels, partial-failure reporting, budget accounting | Multi-isolate/concurrent reality |
| HTTP contract | `test/server.test.mjs`, `cloudflare/worker-failure.test.mjs`, `cloudflare/auth*.test.mjs` | Status codes **and** resulting state: stored records, keys left in the fake S3, headers, bytes | Deployed edge behaviour |
| Process | `test/run-command.test.mjs` | Timeout kill, exit-code reporting, output tail, env merge | Non-Windows kill path; real release builds |
| Browser flows | manual/harness passes in `production-qa-report.md` | The shipped UI against the real handler and real S3 | Anything automated; no CI coverage |

All suites run with Node's built-in runner (no test framework dependency):
`npm test` for everything, `npm run test:coverage` for the gated run.

## 2. Weak-test inventory (baseline → now)

The baseline suite was green but thin where the risk was highest.

| File | Baseline | Now | What changed |
|---|---|---|---|
| `cloudflare/worker.test.mjs` | 3 tests / 12 assertions covering a 936-line handler | unchanged file + **`worker-failure.test.mjs` (22 tests)** | Routing, CORS, auth-failure, upload caps (declared *and* streamed), download dispositions, retry/cancel/409, budget pause/resume, retention trimming, error mapping |
| `cloudflare/s3-adapter.test.mjs` | 5 tests / 11 assertions | + **`s3-adapter-validation.test.mjs` (13 tests)** | Every validator arm, allowlist/default resolution, headObject 404 vs failure, delete batching, upload content type, budget refusal |
| `operations.test.mjs` | 10 tests / 63 assertions | unchanged + `worker-failure` state tests | The existing tests already asserted S3 state; new tests cover the arms they missed (all-failed finalisation, cancel-in-flight) |
| `server.mjs` | **0 tests, 0 % coverage** (never imported) | **`test/server.test.mjs` (14 tests)** | Full local API: static/404, validation matrix, enqueue→persisted record, retry/cancel on real store state, download headers/body, startup/shutdown |
| `scripts/run-command-with-timeout.mjs` | 0 tests | **`test/run-command.test.mjs` (9 tests)** | Success, non-zero exit, stderr, 24-line tail, timeout kill, spawn failure, env |
| `operations-store.mjs` / `operations-worker.mjs` | 7 tests (main paths) | + **10 + 10 failure-path tests** | Corrupt file, unknown ids, cancel states, concurrent writes, recovery, kick rejection, unsupported type, queue draining, progress |

No test was deleted or weakened. Total: **75 → 203 tests, 0 failures**;
Scope A coverage **77.00/71.78/81.99 → 96.92/92.70/94.76**.

### Tests that were discovered to assert too little

- `worker.test.mjs` only exercised validators; nothing asserted that an
  unauthenticated request never reaches the adapter. Now three tests assert
  `createAdapter` was never called.
- `operations.test.mjs` asserted status and counters but not the number of S3
  calls for the *failure* arms. The new budget and in-flight tests assert call
  counts and which objects exist afterwards.
- Nothing tested `finalize()`'s "all items failed" branch, so a bug that reported
  `completed_with_errors` for a total failure would have passed. Now asserted.
- Nothing tested the folder-rename marker case; writing that test surfaced
  **Q-01**.

## 3. Behaviours coverage cannot see

These remain unverified by statement coverage and are listed so the number is
never mistaken for completeness:

1. **UI logic** — the 1,429-line inline script in `index.html` is not loadable by
   Node, so it contributes nothing to the metric. Workstream T7/T8.
2. **Real browser semantics** — downloads, drag-and-drop of OS folders, the native
   file picker, Firefox popup rules (F-20…F-22). Manual/harness only.
3. **Isolate lifetime** — Worker operations live in module memory; eviction and
   concurrent isolates cannot be forced locally (F-07/F-18).
4. **workerd runtime** — `wrangler dev` reloads forever (F-19); only bundling is
   checked, not execution under workerd.
5. **Cloudflare Access edge** — tests verify JWT verification against a local
   JWKS; the Access application policy itself is a deployment property.
6. **Real S3** — pagination, eventual consistency, per-key delete errors and
   throughput are simulated by fakes.
7. **Platform-specific branches** — non-Windows process kill (`run-command`
   lines 50–63) and `openBrowser` on macOS/Linux cannot run on this host.
8. **Defensive branches** — `s3-ops` "Unsupported source type" and the
   "directory outside root" path need device files or mount points; not reachable
   in a unit test on Windows.

## 4. Defect → test ledger (F-01…F-23)

"Covered" means an automated test asserts the fixed behaviour and the resulting
state. "UI gap" means the fix is UI-side and belongs to T7/T8.

| Finding | Status | Test(s) that hold the fix | Remaining gap |
|---|---|---|---|
| F-01 folder ops acted on the marker only | covered | `operations.test.mjs` "folder delete expands every child object and reports totals"; `s3-ops-branches.test.mjs` "copy planning expands folders…", "renaming a folder rewrites every child…"; `worker-failure.test.mjs` "a folder rename rewrites the prefix…" | — |
| F-02 bulk delete exceeded subrequest budget | covered | `operations.test.mjs` "move pauses when the subrequest budget is spent…"; `worker-failure.test.mjs` "budget exhaustion pauses with an exact remaining count and resumes", "a plan larger than the safety ceiling is refused before deleting" | Real 50-subrequest limit only reproducible in workerd |
| F-03 no upload capability (hosted) | route covered / UI gap | `worker-failure.test.mjs` "raw upload stores exactly the received bytes…", "raw upload rejects oversized declarations…", "raw upload enforces the cap even when no length is declared", "multipart upload accepts the documented field aliases" | The controls themselves are UI; T7/T8 |
| F-04 intermittent 30 MiB download 500 | **open** | — | Edge/streaming abort; needs production `wrangler tail` (remediation P1) |
| F-05 fabricated progress / hidden partials | covered | `worker-failure.test.mjs` "a partial delete is reported as completed_with_errors…", "budget exhaustion…"; `operations-store-failure.test.mjs` "completion, failure and progress persist the exact stored state" | UI rendering of the contract: UI gap |
| F-06 cancel without partial state | covered | `worker-failure.test.mjs` "cancel is honest about partial work…", "cancelling an in-flight batch is acknowledged and then finalised"; `operations-store-failure.test.mjs` "cancel distinguishes queued, running and finished operations" | — |
| F-07 jobs are isolate-local | **limitation** | `operations-store-failure.test.mjs` "running work is recovered as queued after a restart" (desktop store only) | Worker isolate eviction untestable locally (P3 persistence work) |
| F-08 bucket list advertised unusable buckets | covered | `s3-adapter.test.mjs` "listBuckets only advertises allowed buckets"; `s3-adapter-validation.test.mjs` "bucket listing filters the allowlist…" | — |
| F-09 native prompt/confirm dialogs | **UI gap** | — | Accessibility/UX work, P3 |
| F-10 no specification tree | addressed in docs | `docs/qa/*` (this pass) | No `specs/` product tree yet (P3) |
| F-11 folder download missing | **product gap** | — | Zip archive feature, P3 |
| F-12 non-ASCII download 500 | covered | `worker-failure.test.mjs` "download validates parameters and streams the stored bytes" (ASCII fallback + RFC 5987 assertions) | — |
| F-13 folder copy/move flattened paths | covered | `operations.test.mjs` "copying a folder keeps the folder name under the destination"; `s3-ops-branches.test.mjs` "copy planning expands folders, keeps names…" | — |
| F-14 cancel raced a completed upload | route covered / UI gap | `worker-failure.test.mjs` "object lookup requires both parameters and reports existence"; `operations.test.mjs` "object lookup reports whether an aborted upload actually landed" | Reconciliation loop is UI (T7) |
| F-15 upload queue could wedge | **UI gap** | — | T7 |
| F-16 multi-file download unreachable | **UI gap** | — | T7 |
| F-17 `remaining` capped without a count | covered | `worker-failure.test.mjs` "budget exhaustion pauses with an exact remaining count…", "cancel is honest about partial work…"; `operations.test.mjs` paused-move assertion | — |
| F-18 restart strands partial work | **limitation** | — | Same as F-07; needs durable jobs |
| F-19 `wrangler dev` unusable | **tooling limitation** | `check:deploy` proves bundling only | Needs dedicated assets directory (P2) |
| F-20 Firefox multi-download | **UI gap** | — | T7/T8 (Firefox harness) |
| F-21 Download rendered inline | covered (route) | `worker-failure.test.mjs` download test (`download=1` → `attachment`); `auth.test.mjs` existing disposition tests | UI action wiring (T7) |
| F-22 double-click did not open folders | **UI gap** | — | T7/T8 |
| F-23 cancelled upload still landed | **limitation** | Object-route test proves detection, not prevention | Bytes cannot be recalled; reconciliation window is UI (P1) |

### New finding from this pass

**Q-01 — P3 — Folder rename leaves the empty source marker object.**

Renaming `qa/old/` to `qa/new/` copies and deletes every child but leaves the
zero-byte marker object `qa/old/` behind, because the plan skips the marker itself
(`skipKey`) and deletes only planned children. The folder therefore reappears in
the listing as empty.

- Evidence: `worker-failure.test.mjs` "a folder rename rewrites the prefix and
  deletes the originals" asserts the marker remains, deliberately, so a future fix
  must update the test.
- Impact: cosmetic leftover; no data loss.
- Suggested fix: add the source marker as a delete task when the source prefix
  yields no children, or delete the marker after a successful prefix rewrite.
- Tracked: `remediation-plan.md` P2.

## 5. Adding a test

1. Put it next to the code (`cloudflare/*.test.mjs`) or in `test/` for the local
   server and planning.
2. Assert **state**, not just a status: which keys exist in the fake S3, what the
   store record says, which bytes/headers came back.
3. If it covers a destructive or auth path, name the risk in the test title.
4. Run `npm run test:coverage`; if a new branch is uncovered, either test it or
   record why it is unreachable in section 3 above.
5. Keep fakes small and local; do not add a mocking dependency.
