# Coverage policy

Coverage is a **diagnostic**: it shows which lines and branches no test reached.
It is not evidence that a reached line is correct. This policy fixes exactly what
is measured, what is deliberately not, and what number fails a build.

## 1. Scope A — measured and gated

Everything below is inside the coverage denominator. A regression in any of these
files can fail the gate.

| Path | Why it is gated |
|---|---|
| `cloudflare/auth.mjs` | Authentication boundary; a silent branch regression is a security defect |
| `cloudflare/s3-adapter.mjs` | Validation and the only path that signs S3 requests |
| `cloudflare/worker.mjs` | Hosted API surface: routing, upload, download, CORS, error mapping |
| `s3-ops.mjs` | Destructive planning: delete/move/copy/rename and local sync |
| `operations-store.mjs` | Durable queue state; corruption here loses work |
| `operations-worker.mjs` | Executes destructive operations |
| `server.mjs` | Local HTTP API (the desktop build's only backend) |
| `scripts/run-command-with-timeout.mjs` | Process supervision used by the release build; a bug here kills builds or leaves orphans |

## 2. Exclusions — reported, not hidden

Each exclusion has a reason and an owner. Exclusions are printed by the coverage
command and listed here; nothing is excluded merely because it scores low.

| Path | Reason | Where the gap is tracked |
|---|---|---|
| `index.html` (inline script) | 1,429 lines inside HTML; Node cannot load it, so no statement coverage exists. Counting it as 0 % would drag the gate down for a measurement artefact, and counting it as covered would be a lie. | **Workstream T7/T8** (extract to `app.js`, then browser-coverage), [`remediation-plan.md`](remediation-plan.md) |
| `scripts/package-win.mjs`, `scripts/build-sidecar.mjs` | Release-only Windows/SEA/Tauri tooling; no runtime path in the application. | Listed as untested in `remediation-plan.md` |
| `src-tauri/**` | Rust/Tauri shell; not a Node module and not in the Node test runner. | Rust tests deferred, P3 |
| `test/**`, `cloudflare/*.test.mjs` | Test code itself | — |
| `node_modules`, `.wrangler`, `coverage`, `dist`, `tauri-dist` | Generated or vendored | — |

**Rule:** adding an exclusion requires a written reason and a tracking item in
`remediation-plan.md`. "It lowers the number" is not a reason. Removing an
already-gated file from Scope A is a policy change, not a test fix.

## 3. Thresholds

Measured on Scope A as a whole, all three must hold:

- **lines ≥ 80 %**
- **branches ≥ 80 %**
- **functions ≥ 80 %**

Enforced by Node's built-in runner (no extra dependency):

```bash
node --test --experimental-test-coverage \
  --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 \
  --test-coverage-include='cloudflare/**/*.mjs' \
  --test-coverage-include='s3-ops.mjs' \
  --test-coverage-include='operations-store.mjs' \
  --test-coverage-include='operations-worker.mjs' \
  --test-coverage-include='server.mjs' \
  --test-coverage-include='scripts/run-command-with-timeout.mjs'
```

`npm run test:coverage` runs exactly this, prints the scope and exclusions, and
exits non-zero if any threshold is missed.

### Stricter targets for security-sensitive and destructive code

These are reviewed per change, not only at the aggregate gate. They are recorded
as explicit targets because an 80 % average is far too weak for them:

| Area | Target | Rationale |
|---|---|---|
| `cloudflare/auth.mjs` | **≥ 95 % lines and branches** | Every claim/algorithm/JWKS branch is a bypass candidate |
| Adapter validation (`validateBucketName`, `sanitizePrefix`, `normalizeKey`, `validateObjectKey`, `parseAllowedBuckets`) | **100 % branch** | Traversal and bucket-escape guards must have no untested arm |
| `s3-ops.mjs` delete/move/copy/rename planning | **≥ 90 % branch** | Wrong plan = data loss |
| Worker auth guard + upload/download routes | **≥ 90 % branch** | Auth bypass, silent truncation, wrong dispositions |

Where a stricter target is not yet met, the shortfall is stated in the PR and
tracked; it is not absorbed by lowering the global gate.

### Measured after the T1–T6 pass (2026-11-22)

File percentages are from `npm run test:coverage`. Area percentages are computed
from the same `coverage/lcov.info` by counting `BRDA` records inside the stated
line ranges, so the stricter targets are reproducible rather than asserted:

```bash
node /path/to/lcov-range-report.mjs   # counts BRDA hits between `from` and `to` lines
```

| Area | Lines | Target | Measured |
|---|---|---|---|
| `cloudflare/auth.mjs` | all | ≥ 95 lines + branches | **98.48 / 97.10** |
| Adapter validators (`validateBucketName`, `sanitizePrefix`, `normalizeKey`, `validateObjectKey`, `parseAllowedBuckets`) | 41–112 | 100 % branch | **100.00 %** (46/46) |
| `s3-ops.mjs` delete/move/copy/rename planning | 439–690 | ≥ 90 % branch | **91.76 %** (78/85) |
| Worker download/object/upload routes | 613–730 | ≥ 90 % branch | **95.74 %** (45/47) |
| Worker authorization (`authorize`) | 865–900 | ≥ 90 % branch | **100.00 %** (11/11) |
| Scope A aggregate | all | ≥ 80/80/80 | **96.92 lines / 92.70 branches / 94.76 functions** |


## 4. Denominator stability (the ratchet caveat)

A percentage is a ratio. Moving lines between files changes it without changing
behaviour, so:

- per-file targets are compared **within the same file scope**; a file's score is
  not compared across a refactor that moved code in or out of it;
- when a change moves lines between files, the PR states which files entered or
  left Scope A and why;
- a **lower** aggregate percentage is investigated, never waved through as "the
  denominator moved";
- the gate is raised only after a clean run shows the new number is stable
  (`npm run verify` twice on a fresh `npm ci`).

The only source change made in this pass is the `server.mjs` factory seam, which
does not move lines between measured files: it makes an already-gated file
loadable. That is a denominator **correction** (a hidden file becoming visible),
and is called out as such in the pass summary and PR.

## 5. Waivers

There are none, and no mechanism for one. A red gate is reported as a failure with
the uncovered lines, not bypassed. If a target is genuinely unreachable in the
current environment, it is documented as an **environmental limitation** (for
example isolate eviction, F-18) and the corresponding test is explicitly absent —
the threshold still has to hold on the code that can be executed.

## 6. Reporting

Every coverage run prints:

1. the included scope (Scope A),
2. the exclusion list with reasons,
3. the per-file table,
4. the three aggregate percentages and whether each threshold passed.

The lcov file (`coverage/lcov.info`, gitignored) is the same data handed to
SonarQube; the local table and Sonar's `coverage` measure are compared to confirm
the report reached the server (see [`quality-gates.md`](quality-gates.md)).
