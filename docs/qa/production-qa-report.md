# S3 Browser — Production QA and Usability Audit

- **Target:** https://s3-browser.tom-andrew-wilson.workers.dev/
- **Tested deployment:** `5383f991-121a-4249-a277-9e100c848517` (100% of traffic)
- **Run window:** 2026-11-21, 15:20–15:50 EST
- **Test area:** `__s3_browser_qa__/baseline-1795292633/` in bucket `064592191516-audio`
- **Report date:** 2026-11-21 (Firefox pass added 2026-11-22)
- **Deploy status:** fixes are implemented and tested locally but **not deployed** (see [Deployment boundary](#deployment-boundary)).
- **Local verification:** the Phase 2 fixes were exercised through the shipped `index.html` against the real Worker handler and real S3 in bucket `064592191516-audio`, confined to `__s3_browser_qa__/local-1795293384/` (see [Local browser verification](#local-browser-verification-phase-2)). Every delete was confirmed with `list-objects-v2`, not with the UI's own claim.
- **Firefox verification:** the same shipped UI was re-driven in **Firefox (Gecko) 159** through the same harness against live S3, confined to `__s3_browser_qa__/firefox-1795357547/` (see [Firefox (Gecko) verification](#firefox-gecko-verification)). 18/18 checks passed after three Firefox defects were found and fixed (F-20, F-21, F-22).

---

## Executive summary

The deployed application is a capable **read-first S3 browser** with a working Access boundary, correct file downloads, and usable navigation. It is **not yet a reliable Dropbox-style file manager**, for two reasons that this audit reproduced against production:

1. **Folder operations silently did the wrong thing.** Deleting a folder reported `COMPLETED (1/1, 100%)` while every object inside it survived. The adapter never enumerated prefixes, so folder delete/move/copy/rename acted on the literal key `prefix/`.
2. **Large operations destroyed partial state and lied about it.** Deleting 100 objects failed with `Too many subrequests by single Worker invocation` **after deleting exactly 50**, reporting progress `0/1, 0%`. The operation runner looped one S3 request per object inside `waitUntil` with no budget and no partial accounting.

A third gap is product-level rather than a regression: **the hosted UI had no upload at all** (no file input, no folder input, no new-folder), and dropping OS files posted an operation type the Worker rejects (`400 Invalid operation type: syncLocalToS3`).

**Assessment:** after the changes in this report, core file management has a correct implementation *in the repository* (recursive, budgeted, resumable, with explicit partial-failure reporting), regression coverage, **and** browser-level verification against the real handler and real S3 through a local harness. That pass found and fixed five more defects, the two most serious being **downloads of any non-ASCII key returning 500** (F-12) and **folder copy/move flattening the tree** (F-13). `wrangler dev` itself could not serve reliably in this environment (F-19), so verification used a loopback harness that runs the shipped `index.html` and `createHandler()` unchanged against live S3. A separate Firefox (Gecko) pass then found three browser-compatibility defects — **multi-file download stopped after the first file** (F-20), **Download rendered files instead of saving them** (F-21) and **double-click never opened a folder** (F-22) — all fixed and re-verified in Gecko. Production readiness is still **conditional on deploying and completing the post-deploy QA pass**: nothing here has run against a deployed build of the fixes.

**Most important risks:** unverified deployed behaviour of the new upload path and batch engine; operations depend on an open browser tab and isolate-local memory (a restart mid-delete was observed to strand remaining objects with no job record, F-18); no synchronization or conflict resolution exists.

**Do core file-management workflows work today?** Browse and download: **yes** (production, except non-ASCII names — F-12). Upload: **no in production** (no control shipped) / **yes in the local harness** against real S3. Move/copy/rename/delete of *files*: **yes**. Folder-level operations: **no in production** (reported success, did nothing) / **yes locally** after the fixes. Bulk operations above ~25–50 objects: **no in production** (partial destruction) / **yes locally** — 1,100 objects deleted with `remaining []` and S3 verified empty.

---

## Feature coverage matrix

| Capability | Implemented | Tested | Result | Notes |
|---|---|---|---|---|
| Browse buckets/folders | Yes | Yes (production) | Pass | Bucket list, bucket → prefix drill-down, breadcrumb/parent/refresh controls present. Buckets outside `ALLOWED_BUCKETS` were advertised but unusable (F-08, fixed locally). |
| Upload files | Yes (local build) | Yes (local harness, real S3) | Pass | Hosted had no upload control at all (F-03). Verified: toolbar Upload with a real `File` through `#file-input`; 25 MiB upload reported exact byte totals (F-17 note on granularity). |
| Upload folders | Yes (local build) | Yes (local harness, real S3) | Pass | `webkitdirectory` input and `webkitGetAsEntry()` drop both reproduced multi-level trees, including `level two/` and `unicode-测试.txt`. |
| Download files | Yes | Yes (production + local) | Pass with caveat | SHA-256 matched for empty (0 B), text (12 B) and binary (4 KiB). Non-ASCII keys returned 500 until fixed (F-12). A 30 MiB production download returned **500 once**; four 25 MiB local downloads all returned 200, so F-04 is still open. |
| Download folders | **Not implemented** | Yes (local) | **Not implemented** | Selecting a folder and choosing Download now explains it: `Folder download is not supported yet — select files to download.` |
| Copy | Yes | Yes (production, files); yes (local, folders) | Pass / fixed (folders) | Folder copy previously copied only the `prefix/` marker (F-01) and then flattened names/paths (F-13); now `dest/<folder>/<relative path>` verified in S3. |
| Move | Yes | Yes (production, files); local tests for folders | Pass (files) / fixed (folders) | Move is copy + delete, now accounted separately (F-02/F-05/F-13). |
| Rename | Yes | Yes (production, file); local test for folders | Pass (file) / fixed (folders) | Folder rename is now a prefix rewrite. |
| Delete | Yes | Yes (production + local) | **Fail in production baseline**, pass locally | Baseline: folder delete reported success with children intact; 100-object delete removed 50 then failed (F-01, F-02). Local: 1,100-object recursive delete reported `completed 1100/1100`, `remaining []`, and `list-objects-v2` then returned 0 objects. |
| Synchronization | **Not implemented (hosted)** | No | **Not implemented** | `syncLocalToS3` exists only in the desktop Node server (`s3-ops.mjs`, `overwrite = false`). No repeated, bidirectional, or watched sync. |
| Job progress | Partial → improved | Yes (production baseline) | Fail → fixed locally | Progress was `0/1` with a 14% placeholder bar; now real totals or an explicit indeterminate bar, plus timestamps and failed counts. |
| Job cancellation | Yes (between objects) | Yes (production) | Pass with caveat | Cancel acknowledged and stopped the run; partial result was not previously reported (F-06). |
| Job retry | Yes | Yes (production) | Pass with caveat | Retry previously re-ran the whole operation; now retries only failed keys as a new linked operation. |
| Job recovery | **Not implemented** | Yes (observed) | **Not implemented** | Operations live in Worker module memory; a restart mid-delete was observed to drop the job and strand the remaining objects (F-18). |
| Firefox (Gecko) support | Yes | Yes (Playwright Firefox 159, local harness, real S3) | Pass | 18/18 flows against `__s3_browser_qa__/firefox-1795357547/`, no console or page errors. Three Firefox defects found and fixed (F-20…F-22). Real OS drag-and-drop, the native folder picker and Firefox's download panel stay manual. |

---

## Findings

Severity: P0 critical, P1 high, P2 medium, P3 low. "Fixed locally" means the repository is changed and covered by tests, but the change is not in production yet.

### F-01 — P1 — Folder delete/move/copy/rename acted on the prefix marker only

- **Impact:** users believe they deleted or renamed a folder; every child object remains. Rename of a folder moves nothing.
- **Repro (production):** open `__s3_browser_qa__/baseline-1795292633/duplicates/`, select `first/`, press Delete, confirm.
- **Expected:** both `duplicates/first/shared.txt` and the folder disappear.
- **Actual:** UI showed `DELETE COMPLETED (1/1, 100%)` and `result.deleted = 1`; S3 still listed `duplicates/first/shared.txt` and the folder.
- **Evidence:** operation payload `{type:"delete", targets:["…/duplicates/first/"]}`; `aws s3api list-objects-v2 --prefix "$P/duplicates/"` afterwards returned both `first/shared.txt` and `second/shared.txt`. `DeleteObjects` also reports non-existent keys as `Deleted`, so the counter was meaningless.
- **Root cause:** `cloudflare/s3-adapter.mjs` had no prefix enumeration; UI passes folder paths ending in `/`, and the delete/copy path treated that string as an object key.
- **Fix:** paginated `listAllKeys`, recursive expansion for delete/copy/move, folder rename as prefix rewrite, `skipped`/`remaining` accounting. Covered by `operations.test.mjs` (folder delete expands every child; folder move preserves paths).
- **Verified:** unit tests only. **Not verified in production.**

### F-02 — P1 — Bulk delete exceeded the Free subrequest limit after destroying half the data

- **Impact:** data loss with a misleading failure; the user cannot tell which 50 objects were removed.
- **Repro:** 100 objects under `…/bulk2/`, select all, Delete.
- **Expected:** either success with all 100 removed, or a refusal before starting.
- **Actual:** operation `failed` with `Too many subrequests by single Worker invocation.`; `0/1, 0%`; S3 then held **50** of the original 100.
- **Evidence:** operation error text above; `aws s3api list-objects-v2 --prefix "$P/bulk2/"` → 50 remaining; `wrangler tail` showed no uncaught exception (the SDK error was caught and stored on the op).
- **Root cause:** `processOperationQueue` in `waitUntil` issued one `DeleteObjects` request per target, with no subrequest budget and no per-key accounting; Workers Free allows 50 subrequests per invocation.
- **Fix:** 30-subrequest budget per invocation (`SubrequestBudget`), delete batching up to 100 keys per request, resumable plan with `cursor`/`remaining`, client-driven `POST /api/operations/:id/advance`, and explicit `completed_with_errors`. Covered by tests: "move pauses when the subrequest budget is spent and resumes on later advances", adapter batch-splitting test.
- **Verified:** unit tests only. **Not verified in production.**

### F-03 — P1 — No upload capability in the hosted UI

- **Impact:** the primary file-manager action is impossible; the only affordance (drag-and-drop) errors out.
- **Repro:** drop any local file on the table in the deployed app.
- **Expected:** the file is uploaded to the current prefix.
- **Actual:** UI posted `{type:"syncLocalToS3"}`; Worker replied `400 Invalid operation type: syncLocalToS3`. No `<input type="file">` existed anywhere in `index.html`; no Upload button; no New folder.
- **Evidence:** `index.html` had no file input or upload control; `validTypes = new Set(["move","copy","delete","rename"])` in `worker.mjs`; drop handler called `enqueueLocalSyncOperation`.
- **Root cause:** upload/sync was implemented only for the desktop Node server; the hosted Worker never received an upload UI.
- **Fix:** toolbar `Upload`, `Upload folder`, `New folder`; hidden file/folder inputs; OS drop walks `webkitGetAsEntry()`; sequential XHR queue with real `upload.onprogress`; `PUT /api/upload` (raw body, 50 MiB cap) alongside the existing multipart route; `/api/capabilities` gates the controls so the desktop build keeps its legacy path.
- **Verified:** unit tests for the upload route (cap + success). **UI not exercised in any browser.**

### F-04 — P2 — Intermittent 500 on a 30 MiB download

- **Impact:** a single large download fails for no visible reason; retry works.
- **Repro:** `GET /api/download?bucket=…&key=…/large-30mb.bin` from the app origin.
- **Expected:** 200 with the 30 MiB body.
- **Actual:** first request `500`, body empty, `cf-ray a5e26b7a7a4bdf84-BOS`, 408 ms on the successful retry. `wrangler tail` recorded no `s3-browser request failed` line for it, pointing at an edge/streaming abort rather than the handler.
- **Root cause:** not determined. Candidates: `GetObject` stream interruption, or a Worker/edge abort while streaming 30 MiB.
- **Fix:** none. **Open.** Needs reproduction with `wrangler tail` at debug level and a Range/streaming check.

### F-05 — P2 — Progress was fabricated and partial results were not exposed

- **Impact:** users cannot tell whether work is progressing, finished, or partially failed.
- **Repro:** run any multi-object operation; observe `0/1` progress and a hard-coded 14% bar; folder delete "completed" while children remained.
- **Expected:** real totals, or an explicitly indeterminate indicator; failed-item counts.
- **Actual:** `progress.total` started at 0 (bar rendered at 14%), no timestamps, no failed count, no `completed_with_errors`.
- **Root cause:** operations reported `{total, completed, message}` only, incremented after the whole run; UI invented a percentage.
- **Fix:** result contract `{status,total,completed,copied,deleted,failed[],skipped[],remaining[],deleteFailed[],cancellationRequested}`; statuses `queued|running|cancelling|cancelled|completed|completed_with_errors|failed`; UI shows indeterminate bars when totals are unknown, start/finish times and failed counts.
- **Verified:** covered by operation tests; UI unverified.

### F-06 — P2 — Cancellation reported a terminal state without saying what was left

- **Impact:** after cancelling a bulk delete, users cannot see which objects were already removed.
- **Repro:** start a 100-object delete, cancel immediately.
- **Expected:** `Cancelled` plus a partial-state summary.
- **Actual:** op reached `cancelled`; `result` did not enumerate remaining work, and progress stayed at `1/1` from the previous shape.
- **Root cause:** same result-shape limitation as F-05; cancellation checked only between items.
- **Fix:** cancel sets `cancelling`, finalizes to `cancelled` with `remaining[]` and counters; no new batch starts after acknowledgement (test: "cancel stops the operation and keeps partial state explicit").
- **Verified:** unit tests only.

### F-07 — P2 — Job state is isolate-local; recovery is not provided

- **Impact:** jobs vanish on deploy, isolate eviction, or a request served by a different isolate; cancel/retry can 404.
- **Repro:** enqueue an operation, force an isolate change (deploy or wait), then `GET /api/operations/:id`.
- **Expected (ideal):** durable job records.
- **Actual:** `operationMap`/queue are module-scope in the Worker. In this run cancel and retry happened to land on the same isolate and worked, but nothing guarantees it.
- **Root cause:** no persistence layer (and no paid queue/DO by constraint).
- **Fix:** documented limitation plus honest UX: the operations panel is described as continuing "while this page is open"; retry creates a new linked operation. **Recommendation:** persist job records in Workers KV (free tier) or Durable Objects (free tier, SQLite-backed), see product gaps.
- **Verified:** not tested for eviction (would require forcing isolate recycling).

### F-08 — P2 — Bucket list advertised unusable buckets

- **Impact:** the sidebar listed 16 buckets while `ALLOWED_BUCKETS` permits one; clicking any other bucket produced `400 Bucket … is not allowed for this deployment.`
- **Repro:** open the deployed app; the sidebar lists `064592191516-backups`, `…-books`, etc. Selecting one errors.
- **Expected:** only permitted buckets are offered.
- **Actual:** `ListBuckets` results were returned unfiltered.
- **Root cause:** allowlist enforced only on object operations.
- **Fix:** `listBuckets()` filters by `ALLOWED_BUCKETS` when configured; test "listBuckets only advertises allowed buckets".
- **Verified:** unit test only.

### F-09 — P3 — Destructive and rename flows use native `prompt()`/`confirm()`

- **Impact:** blocking, unstyled, inaccessible dialogs; no place to show a destination path or a typed-name conflict warning.
- **Evidence:** `confirm(\`Delete ${paths.length} selected item(s)?\`)`, `prompt("Rename to:", …)`, `confirm(… Overwrite?)` in the upload queue.
- **Fix:** not changed (browser-native dialogs are the existing convention). Recommend replacing with an in-app dialog before adding conflict resolution.

### F-10 — P3 — No specification tree in the repository

- **Impact:** "OpenSpec requirements" cannot be verified; requirements live only in prose docs.
- **Evidence:** no `openspec/` or `specs/` directory; `docs/` contains six guides (`README`, `getting-started`, `cloudflare-deployment`, `security`, `development`, `costs-and-limits`).
- **Fix:** none. Recommend adding a small spec set for operations, upload limits and access rules.

### F-11 — P3 — Folder download and multi-select download missing

- **Impact:** recovering a folder means downloading files one by one.
- **Actual:** double-click downloads a single file; context menu had no Download. Multi-file download of selected files was added; folder/ZIP stays out of scope.
- **Fix:** partial (multi-file download). Folder ZIP remains a product gap.

### F-12 — P1 — Downloading any key with non-ASCII characters returned 500 (fixed locally)

- **Impact:** every file whose name contains an em dash, CJK, accents or emoji could not be downloaded — a 500 with `{"error":"Request failed"}` in the UI.
- **Repro (local harness, real S3):** `GET /api/download?bucket=064592191516-audio&key=__s3_browser_qa__/local-1795293384/spaces%20in%20name%20%E2%80%94%20%E6%B5%8B%E8%AF%95.txt` → `500`.
- **Evidence:** Worker log `s3-browser request failed: {"name":"TypeError","message":"Cannot convert argument to a ByteString because the character at index 33 has a value of 8212 which is greater than 255."}`.
- **Root cause:** the download response set `Content-Disposition: inline; filename="<key basename>"`. Header values are byte strings, so a non-ASCII filename throws inside `Response` construction. Browsing and uploading the same name worked, which hid the defect.
- **Fix:** ASCII fallback plus RFC 5987 parameter — `filename="spaces in name _ __.txt"; filename*=UTF-8''spaces%20in%20name%20%E2%80%94%20%E6%B5%8B%E8%AF%95.txt`. Test: "worker: non-ASCII download keys produce a byte-safe content disposition".
- **Verified:** local browser/HTTP — 200 with the header above; the same file's body confirmed the overwrite test (`overwritten content`).

### F-13 — P1 — Folder copy/move flattened the folder name and nested paths (fixed locally)

- **Impact:** copying or moving a folder merged its children into the destination instead of recreating the tree. Two folders with same-named children silently overwrite each other.
- **Repro (local harness):** select `budget/` (200 objects), Copy, enter `dest-via-ui/`, Paste → job reported `copied 200`; S3 contained `dest-via-ui/obj-000.txt`, not `dest-via-ui/budget/obj-000.txt`.
- **Second layer:** after the folder name was preserved, a nested copy of `proj/` still produced `dest-via-ui/proj/b.txt` for `proj/level-one/level-two/nested.txt` — the file branch used the basename instead of the path relative to the source prefix.
- **Root cause:** `buildExpandQueue` set `destinationPrefix` to the destination only, and `taskForKey` used `objectNameFromKey(key)` for every non-folder key.
- **Fix:** folder sources append their own name (`${destination}${folderName}/`), and every task keeps `key.slice(sourcePrefix.length)`. Tests: "copying a folder keeps the folder name under the destination" (also asserts the nested path and the absence of a flattened key).
- **Verified:** local browser copy of `proj/` → S3 listed `dest-via-ui/proj/level-one/level-two/nested.txt` and `dest-via-ui/proj/level two/unicode-测试.txt`.

### F-14 — P1 — A cancel that lost the race reported `cancelled` while the bytes had landed (fixed locally)

- **Impact:** a user cancels a large upload, the row says `Cancelled`, but the object exists in S3 — a false negative that invites duplicate uploads and confusion about what is stored.
- **Repro (local harness):** upload 25 MiB, click the row's Cancel while the Worker is still committing → UI `cancelled`; `aws s3api head-object …/race-cancel.bin` → `ContentLength: 26214400`.
- **Root cause:** `xhr.onabort` declared `cancelled` unconditionally; the abort only guarantees the browser stopped waiting, not that the server stopped writing.
- **Fix:** `GET /api/object?bucket=&key=` (adapter `headObject`) lets the UI verify the outcome. On abort the row stays `cancelled`, then a background reconciliation (6 attempts, 1.2 s apart) flips it to `Uploaded` with `Upload finished before cancel arrived` if the object appears. Test: "object lookup reports whether an aborted upload actually landed".
- **Verified:** local browser — a true cancel (abort during send) stays `cancelled` with `/api/object` → `exists:false`; a late cancel now reports `completed` with the explanation.

### F-15 — P2 — Upload queue could wedge permanently (fixed locally)

- **Impact:** one entry that never fired a load/error/abort event blocked every later upload and kept the page in fast-poll mode.
- **Evidence:** driving an artificial abort before `XMLHttpRequest.send()` left the entry at `uploading` with `pumpsUploading` still true; nothing drained the queue afterwards.
- **Fix:** `xhr.send()` is wrapped — a throw marks the entry `failed`, renders, and resolves the promise, so the pump always advances.
- **Verified:** local harness — a later upload completed normally after the failing entry.

### F-16 — P2 — Multi-file download existed but was unreachable (fixed locally)

- **Impact:** `downloadSelection()` handles several files, but the context menu disabled `Download` unless exactly one file was selected, so the feature could not be triggered by a user.
- **Fix:** `canDownload` is true for any non-empty selection; folders still get the explicit "not supported" message.
- **Verified:** local browser — ctrl-click two files, Download opened two `/api/download` URLs, both 200, SHA-256 `b6a98d9c…` (`alpha\n`) and `f2c82dec…` (`beta\n`) matched.

### F-17 — P3 — `remaining` was capped at 200 keys with no count (fixed locally)

- **Impact:** a paused or cancelled job could look almost finished: a cancelled 4,000-object delete reported `completed 1600` with `remaining` listing 200 keys, while S3 still held 2,400 objects.
- **Fix:** the result now carries `remainingCount` (exact when planning is complete, `null` while the plan is still growing) and job rows append `| N remaining`. The 200-key list is retained for detail.
- **Verified:** paused copy row rendered `(29/200, 14%) | 171 remaining`; `remainingCount` matched `remaining.length` and the S3 count.

### F-18 — P2 — In-memory jobs strand partial work when the Worker restarts (limitation, observed)

- **Impact:** restarting the Worker mid-delete lost the job record entirely; the remaining objects stayed in S3 with no UI trace of the operation.
- **Evidence (local harness):** a 4,000-object delete was cancelled with 1,600 done; after restarting the handler process, `GET /api/operations` returned `{"operations":[]}` while objects remained. A fresh delete through the UI then cleared the prefix (1,175 planned, 1,175 completed, `remainingCount 0`) and `list-objects-v2` returned 0.
- **Status:** unchanged by design (no queue/DO by constraint). Matches F-07; the practical consequence is that a deploy or isolate recycle during a bulk operation leaves silent partial work. Recommendation unchanged: persist job records in KV at batch boundaries.

### F-19 — P2 — `wrangler dev` cannot serve this project locally (blocked, tooling)

- **Impact:** browser verification against workerd was impossible; the pass used a loopback harness instead (see below).
- **Evidence:** `npx wrangler dev --local --ip 127.0.0.1 --port 8788` logged `Local server updated and ready` → `Reloading local server...` in a loop and never answered: `curl --max-time 8 http://127.0.0.1:8788/` → `status=000`. The loop persisted with **all** logs written to `/tmp` (outside the project) and with `--persist-to /tmp/wd-state`, so it is not the `wrangler tail`-in-project problem from the earlier attempt.
- **Root cause (high confidence):** `wrangler.jsonc` sets `assets.directory: "./"` with a `.assetsignore` allowlist. The dev asset watcher therefore watches the whole project, including `.wrangler/`, where wrangler writes its own temp/registry/state files — so its own writes retrigger reloads indefinitely.
- **Fix:** none in this pass (changing the assets layout is a separate change). Suggested: move the published assets to a dedicated `public/` directory, or run dev against a temporary asset directory.

### F-20 — P1 — Firefox saved only the first file of a multi-file download (fixed locally)

- **Impact:** select three files, choose Download, and Firefox saves one while silently dropping the rest — worse than failing, because the user believes the batch arrived.
- **Repro (Playwright Firefox 159, shipped UI):** ctrl-select two files, right-click → Download. The first `/api/download` opens in a tab and saves; the second call is swallowed by the popup blocker and the user sees Firefox's "prevented this site from opening a pop-up window" notice at most.
- **Root cause:** `downloadSelection()` called `window.open(url, "_blank")` once per file. Firefox requires a separate user gesture for every `Window.open()` call (MDN, Mozilla bug 675574), so only the first is allowed. Chromium permitted the batch, which is why the earlier Chromium pass saw two downloads.
- **Fix:** in-document `<a download>` clicks via a new `triggerDownload()` helper; popups are no longer involved. Multiple anchor-triggered downloads are allowed in Firefox (there is no Chrome-style "automatic downloads" permission to grant).
- **Verified:** Firefox 159 — two files selected, both downloads fired, suggested filenames kept `spaces in name — 测试.txt` and `second.txt`, and SHA-256 of both saved bodies matched the uploaded bytes.

### F-21 — P1 — "Download" rendered inline-able files instead of saving them (fixed locally)

- **Impact:** choosing Download on a `.txt`, image or PDF opened a viewer tab instead of saving a file, in every browser. "Open" and "Download" were the same action.
- **Repro:** context-menu Download on `second.txt` → a tab with `text/plain` inline rendering.
- **Root cause:** `/api/download` always sent `Content-Disposition: inline`, and the UI opened that URL in a tab.
- **Fix:** an explicit `download=1` parameter on the route sends `Content-Disposition: attachment`; without it the route stays `inline` so double-click Open still previews. The RFC 5987 `filename*` handling is unchanged, and the Download action now uses the attachment URL.
- **Verified:** Firefox 159 downloads fired with the attachment disposition and the correct names. Tests: "worker: an explicit download forces an attachment disposition" and "worker: a forced download keeps the byte-safe unicode filename"; the existing preview test now asserts `inline`.

### F-22 — P1 — Double-clicking a folder never opened it (fixed locally)

- **Impact:** the primary navigation gesture of a file manager did nothing. Folders could only be entered via the breadcrumb or Enter key.
- **Repro (Playwright Firefox, and reproducible by hand):** double-click a folder row → nothing.
- **Root cause:** the row's `click` handler called `renderTable()`, which rebuilds every `<tr>` on the first click. The second click therefore landed on a different element, so the browser never dispatched `dblclick` on the row that had the listener.
- **Fix:** selection now updates row classes in place (`applySelectionClasses()`), so rows keep their identity between the two clicks. Sorting, filtering and refresh still rebuild the table.
- **Verified:** Firefox 159 — double-clicked into `__s3_browser_qa__` → `firefox-1795357547` → `into` and back out with the up button; breadcrumbs and listing followed every step.

### F-23 — P3 — A cancelled 25 MiB upload still landed in S3 (limitation, observed)

- **Impact:** the row said `Cancelled` and `/api/object` reported `exists:false`, yet the object appeared in S3 seconds later. A user who cancels and retries ends up with a file they believe they stopped.
- **Evidence (Firefox run):** `cancel-me.bin` row → `Cancelled`, `/api/object` → `{exists:false}`; `list-objects-v2` afterwards listed `__s3_browser_qa__/firefox-1795357547/cancel-me.bin` at `26,214,400` bytes, and the UI's own listing showed `25.0 MB`.
- **Root cause:** an abort only stops the client waiting; once the body has been received the server commits it. The harness's 4 s delay for large uploads made the commit land after the 6 × 1.2 s reconciliation window from F-14. In production the same window exists but is far smaller.
- **Status:** not changed in this pass. Deleting on cancel would race overwrites of pre-existing objects and is not safe to guess. Recommended: extend the reconciliation window (or re-check on the next refresh) so the row can flip to `Uploaded — finished before cancel arrived`; the object itself cannot be recalled once the bytes are stored.

> Deliberately excluded: an attempt to select 100 files with a custom script produced `Invalid key: missing value`. That was a harness bug (it used `item.path` for files instead of the UI's `pathForItem`), not an application defect.

---

## Changes made

No commit, push, PR or merge. Nothing was deployed.

| File | Change |
|---|---|
| `cloudflare/s3-adapter.mjs` | Injected client (`constructor(env, { client })`), `SubrequestBudget` + `BudgetExhaustedError`, every S3 call spends budget, paginated `listAllKeys`, `copyKey`, `headObject` (404 → `{exists:false}`, used by upload-cancel reconciliation), batched `deleteKeysBatch` with per-key errors, `listBuckets` allowlist filtering. |
| `cloudflare/worker.mjs` | Operation plan/batch engine (resumable `cursor`, `remaining`), `POST /api/operations/:id/advance` (409 while a batch is in flight), retry of failed keys only, `cancelling` state, `completed_with_errors`, `PUT /api/upload` with 50 MiB cap, `/api/capabilities`, `GET /api/object` (upload outcome lookup), exact `remainingCount` alongside the capped `remaining` list, folder copies/moves that keep the folder name and each child's relative path, RFC 5987 `Content-Disposition` for non-ASCII names, `download=1` → `Content-Disposition: attachment` while previews stay `inline`, destination-inside-source and self-copy rejection, sanitized operation errors, listing-progress guard. `/api/health` unchanged. |
| `index.html` | Upload / Upload folder / New folder controls, XHR upload queue with real byte progress and per-upload cancel, drop traversal of folders, overwrite confirmation for visible collisions, multi-file download (now reachable for multi-selections, F-16), cancel reconciliation against `/api/object` (F-14), `send()` failure guard (F-15), `remaining count` in job rows (F-17), `New folder` and `Download` in the context menu, adaptive polling (1.2 s active, backoff to 30 s idle, pause when hidden, single timer), job rows with status labels, timestamps, failed counts and indeterminate progress; Firefox-safe in-document anchor downloads (`triggerDownload`, F-20), `download=1` on the Download action (F-21), `dragenter` acceptance so Firefox offers the drop target, and in-place selection classes so double-click opens folders again (F-22). |
| `package.json` | `test:cloudflare` now includes the two new test files. |
| `cloudflare/operations.test.mjs` | **New.** 10 tests: recursive delete, budget pause/resume, failed-delete accounting, folder-name/path preservation on copy, nesting rejection, cancellation, retry-only-failed, upload cap, upload success, `/api/object` outcome lookup. |
| `cloudflare/s3-adapter.test.mjs` | **New.** 5 tests: bucket allowlist, pagination, budget exhaustion before send, delete batching + errors, key validation. |
| `cloudflare/auth.test.mjs` | +3 checks: non-ASCII byte-safe disposition (F-12), previews stay `inline`, and `download=1` yields `attachment` with the RFC 5987 filename preserved (F-21). |
| `.wrangler/local-harness.mjs` | **New, gitignored, dev-only.** Loopback harness that serves the shipped `index.html` and `/assets/*` and proxies `/api/*` into the real `createHandler()` with the real S3 adapter (`AWS_PROFILE`), stubbing `authenticate` for loopback only and delaying uploads over 5 MiB by 4 s so cancel can be exercised on a fast link. Not part of the deploy bundle. |

### Deliberate limitations of the fix

- Uploads are buffered in the Worker (≤ 50 MiB), not streamed or multipart; larger files need a multipart design.
- Large operations need a client present to advance batches (no paid queue/DO). The UI says so; a closed tab pauses the job.
- Overwrite detection on upload only covers keys visible in the current folder listing.
- Folder detection relies on the trailing `/` that the UI already produces.

---

## Test results

| Command | Result |
|---|---|
| `npm run test:cloudflare` | **51 tests, 51 pass, 0 fail**, exit 0 (33 pre-existing + 18 new) |
| `npx wrangler deploy --dry-run --outdir /tmp/wd-dry-ff` | exit 0; `Total Upload: 705.76 KiB / gzip: 136.84 KiB` |
| `node vm.Script` parse of the inline `index.html` script | parse OK (1 inline script) |
| `npx wrangler dev --local` UI smoke | **Blocked** — reload loop, not the `wrangler tail` cause this time: logs were written to `/tmp` and state to `/tmp/wd-state`, and the server still never answered (`status=000`). Root cause in F-19. |
| Firefox harness flows (Gecko, real handler + real S3) | Playwright Firefox 159 against `http://127.0.0.1:8790/`: **18/18 checks**, no console or page errors. Details in [Firefox (Gecko) verification](#firefox-gecko-verification). |
| Local harness browser flows (Chromium pass, real handler + real S3) | Executed in the preview Chromium against `http://127.0.0.1:8790/`: new folder ×2, upload file, upload folder, OS-drop folder tree, overwrite prompt, 25 MiB progress, per-file cancel (true + racing), 1,100-object recursive delete, budget-paused copy, cancelled 4,000-object delete, folder copy, multi-file download, folder download message, large downloads. Details below. |
| Production browser flows (baseline deployment) | Executed through the Access-authenticated session: bucket list, bucket drill-down, folder navigation, name rendering, downloads, folder delete, bulk delete, cancel, retry. |

Skipped or blocked:

- Everything above is pre-deploy or local; **no fix has been exercised against a deployed build**.
- Cloudflare Access itself is not exercised locally (`authenticate` is stubbed for loopback), so sign-in, session expiry and 401/403 behaviour still rely on the production pass.
- Native OS file choosers and real drag gestures: the harness assigns `File` objects through `DataTransfer` and calls the real drop handler with a constructed `webkitGetAsEntry()` tree. The application code path is the shipped one; the OS file dialogs are not.
- Byte-progress granularity: loopback delivers the body in one chunk, so only 0 → 100 % was observable (`loaded` reached exactly 26,214,400 of 26,214,400). No intermediate percentages were fabricated or seen.
- The intermittent 30 MiB production 500 (F-04) did not reproduce: four consecutive 25 MiB downloads returned 200. Still open.
- Isolate eviction is not directly testable; the equivalent restart case was observed (F-18).
- Slow-network and concurrent-user load tests.
- `wrangler dev`/workerd: blocked (F-19), so nothing here is a workerd compatibility result.

---

## Local browser verification (Phase 2)

- **When:** 2026-11-21, 15:30–15:55 EST.
- **UI under test:** the shipped `index.html` (unmodified, same file the Worker serves) in the preview Chromium.
- **Server:** `wrangler dev` was unusable (F-19), so a loopback harness (`.wrangler/local-harness.mjs`, gitignored) served the UI and forwarded `/api/*` into the real `createHandler()` from `cloudflare/worker.mjs` with the real `AwsS3WorkerAdapter` and **live S3** through the local AWS credential chain. Only `authenticate` was stubbed (`{ok:true}`, loopback only) because Access cannot be satisfied from localhost.
- **Data confinement:** every object lived under `__s3_browser_qa__/local-1795293384/`. Nothing outside `__s3_browser_qa__/` was read or written; the prefix was emptied at the end and `list-objects-v2` confirmed 0 objects.
- **Ground truth:** every result was checked with `aws s3api list-objects-v2`/`head-object`, never with the UI's own status.

| # | Flow | How it was driven | Evidence |
|---|---|---|---|
| 1 | New folder | toolbar `New folder` (native `prompt` stubbed) → `__s3_browser_qa__`, then `local-1795293384` | both listed after refresh; marker keys present in S3 |
| 2 | Upload file (spaces + Unicode) | real `<input type=file>` with a `File` assigned through `DataTransfer`, `change` dispatched | `state.uploads` completed; key `…/spaces in name — 测试.txt` in S3 |
| 3 | Upload folder, multi-level | `#folder-input` with `webkitRelativePath` set to `proj/level-one/level-two/nested.txt` and `proj/level two/unicode-测试.txt` | both keys created with the tree intact |
| 4 | Folder drag-and-drop | real `handleDropToDestination()` with `dataTransfer.items[0].webkitGetAsEntry()` returning a nested directory tree | `drop-tree/a.txt` and `drop-tree/sub dir/unicode-测试.txt` uploaded; no `syncLocalToS3` request |
| 5 | Overwrite prompt | re-uploaded an existing key with `confirm` recording its message | `1 file(s) already exist here. Overwrite?`; downloaded body afterwards = `overwritten content` |
| 6 | Real byte progress | 25 MiB upload, `xhr.upload.onprogress` sampled | `loaded` reached exactly `26214400` of `26214400`; no fabricated steps (loopback sends in one chunk) |
| 7 | Per-file cancel — true | abort 3 ms after `send()` | row `cancelled`; `/api/object` → `exists:false`; no object in S3 |
| 8 | Per-file cancel — racing | cancel clicked while the Worker was committing 25 MiB | row flips to `Uploaded` with `Upload finished before cancel arrived`; object present (F-14) |
| 9 | Recursive delete, multi-page | `bulk/` with 1,100 objects deleted through the context menu | job `completed`, `total 1100`, `completed 1100`, `remaining []`; `list-objects-v2` → **0 objects** |
| 10 | Forced budget stop | copy of a 200-object folder | row `Paused (continues on next poll) (29/200, 14%) \| 171 remaining`; finished `200/200` after later advances; S3 copy verified |
| 11 | Cancelled delete honesty | 4,000-object `bulk3/`, job Cancel clicked mid-run | `cancelled`, `completed 1600`, `cancellationRequested true`; S3 still held 2,400 objects — no false 100 % |
| 12 | Folder copy correctness | `proj/` copied into `dest-via-ui/` (F-13 fix) | `dest-via-ui/proj/level-one/level-two/nested.txt` and `dest-via-ui/proj/level two/unicode-测试.txt` |
| 13 | Multi-file download | two files selected (click + ctrl-click), context-menu Download | two `/api/download` URLs, both 200, SHA-256 `b6a98d9c…` and `f2c82dec…` match |
| 14 | Folder download | `proj/` selected, Download | no download; `Folder download is not supported yet — select files to download.` |
| 15 | Large + Unicode download | 25 MiB × 4 and the em-dash/CJK key | four 200s (1.3–1.5 s each, 26,214,400 B); Unicode key 200 with RFC 5987 header after F-12 |
| 16 | Job durability on restart | harness restarted mid-delete | `/api/operations` → `[]` while objects remained; cleared by a fresh UI delete (1,175 planned/completed) (F-18) |

Reproduce: from `s3-browser/`, start `AWS_PROFILE=<profile> node .wrangler/local-harness.mjs` (port `8790`, `HARNESS_PORT` to override) and open `http://127.0.0.1:8790/`. The harness is dev-only and must not be deployed.

---

## Firefox (Gecko) verification

- **When:** 2026-11-22, 09:23–09:27 EST.
- **Engine:** Playwright Firefox **159.0** (Gecko), headless, installed in a temporary directory outside the repository; `package.json` was not changed. The preview browser used for the Chromium pass is Chromium-only, so it could not answer this question.
- **UI under test:** the same shipped `index.html` the Worker serves, unmodified except for the fixes above.
- **Server and data:** the same `.wrangler/local-harness.mjs` → real `createHandler()` → real `AwsS3WorkerAdapter` → live S3 (`AWS_PROFILE`, bucket `064592191516-audio`). Access is stubbed for loopback only. Every object lived under `__s3_browser_qa__/firefox-1795357547/`.

| # | Flow | Evidence |
|---|---|---|
| 1 | Boot | bucket list renders (1 bucket), zero `console` errors, zero uncaught page errors for the whole run |
| 2 | Bucket → folder drill-down | breadcrumbs `064592191516-audio / __s3_browser_qa__ / firefox-1795357547` |
| 3 | New folder ×2 + double-click navigation (F-22) | folders created by the native `prompt`, entered by double-click |
| 4 | Sort headers and filter | size/modified/name toggles, then a no-match filter shows the empty state |
| 5 | Upload file with spaces + CJK | `spaces in name — 测试.txt` → row `Uploaded`, key present in S3 |
| 6 | Overwrite prompt | re-upload → `1 file(s) already exist here. Overwrite?` accepted → `Uploaded` |
| 7 | Second file upload | `second.txt` → `Uploaded` |
| 8 | Folder upload via `webkitdirectory` | `#folder-input` with a real directory → `ui-folder/level one/unicode-测试.txt` and `ui-folder/level-two/nested.txt` in S3 (no fallback needed) |
| 9 | New folder + upload into it | `into/inner.txt` |
| 10 | Per-file cancel | row `Cancelled`, `/api/object` → `exists:false`; the object nevertheless landed later (F-23) |
| 11 | Keyboard selection | `ArrowDown` then `Ctrl+A` → status `4 item(s) \| 4 selected` |
| 12 | Multi-select | click + ctrl-click → `4 item(s) \| 2 selected` |
| 13 | Multi-file download (F-20/F-21) | two `download` events, names `spaces in name — 测试.txt` and `second.txt`, SHA-256 `7994e1800113…` and `cd895c774fc9…` match the uploaded bytes |
| 14 | Recursive delete with nested children | `tree/nested-src/a/b/deep.txt` + `tree/nested-src/c.txt` deleted from the folder row → job `COMPLETED (3/3, 100%)`; `list-objects-v2` → **0 objects under `tree/`** |
| 15 | Layout | screenshot of the main view: sidebar, breadcrumbs, sticky `thead`, aligned size/modified columns, status bar and ops panel all render correctly in Gecko |

**Ground truth:** `list-objects-v2` under the prefix after the run listed exactly the 5 expected keys plus `into/` and the cancelled upload; `tree/` was empty; the prefix and the `__s3_browser_qa__/` marker were then deleted and re-listed as **0 objects**.

**Not covered here, and why:**

- **Real OS drag and drop** (file and nested folder from Explorer through `webkitGetAsEntry()`) cannot be synthesised by any browser automation. The code path is unchanged and Gecko-compatible on review, but it is not proven by this run.
- **The native folder picker dialog**: Playwright filled the real `webkitdirectory` input programmatically; the dialog itself was not shown.
- **Firefox's Downloads panel and multi-download UI**: Playwright captures downloads before the browser UI, so panel behaviour is unverified. Firefox has no "automatic downloads" permission (unlike Chrome); with "Always ask where to save files" enabled, Firefox may only prompt for the first of several downloads (Mozilla bug 2079100).
- **PDFs**: if Firefox is set to open PDFs in its own viewer, it honours that preference over `Content-Disposition: attachment` (Mozilla bug 1756980). The download is still offered, but the viewer may open instead.
- **Cloudflare Access sign-in in Firefox** and anything against the deployed build: the harness stubs `authenticate`, and deploying needs separate approval.

**Manual Firefox checklist (2 minutes, on the deployed build):**

1. Select two files → right-click → Download: both appear in the Downloads panel (not just the first).
2. Double-click a folder row: it opens.
3. Drag a folder from Explorer onto the file table: the tree (including nested and unicode names) is uploaded.
4. Download a PDF: either it saves, or Firefox's PDF viewer opens — it should never be a blank tab.

---

## Product gaps

### 1. Synchronization and conflict resolution — **not implemented**

- **Benefit:** the actual Dropbox model: keep a local folder and S3 converged without manual transfers.
- **Current state:** the desktop Node build has a one-shot `syncLocalToS3` (walks local paths, uploads, skips existing unless `overwrite`). Nothing compares remote state, nothing runs repeatedly, and the hosted app has nothing.
- **Approach:** (a) manifest of `key → size, mtime, etag` built from `ListObjectsV2`; (b) local side from the File System Access API in the browser or the Node sidecar on desktop; (c) compare, then classify create/modify/delete on each side; (d) write conflicts as `name (conflicted copy).ext` rather than overwriting; (e) run as a resumable batched operation through the engine added here.
- **Complexity:** high. Needs conflict policy design and user-visible resolution UI, not just code.
- **Free-tier viability:** the transfer/compare work fits, but continuous background sync does not: Workers have no scheduler without Cron Triggers (free) and no durable state without KV/DO. A tab-driven sync is viable; an always-on agent is not.
- **Limits:** no filesystem watching in the browser; ETag is not a content hash for multipart objects; large manifests must be paged.

### 2. Durable job records — **recommended next**

- **Benefit:** jobs survive deploys, evictions and tab closure; cancel/retry stop depending on which isolate answers.
- **Approach:** Workers KV (free: 100k reads/day, 1k writes/day) keyed `job:<id>` with TTL, written at batch boundaries; the batch engine already has resumable state to serialize.
- **Complexity:** medium (serialize plan/cursor, add expiry, keep secrets out).
- **Limits:** KV writes are eventually consistent and rate-limited; a true queue needs Durable Objects (free tier exists but adds a new primitive and a per-request pricing model to reason about).

### 3. Folder download (ZIP)

- **Benefit:** recovering a folder in one action.
- **Approach:** Worker builds a STORE-method ZIP stream (CRC32 table in-code, no dependency) from paged `GetObject`s; cap entry count and total bytes; expose progress through the existing operation contract.
- **Complexity:** medium-high (streaming archive + backpressure + subrequest budget of 30 per invocation).
- **Limits:** big folders need multi-invocation assembly, which Workers cannot hold in memory; a realistic cap is a few hundred MB per invocation.

### 4. Browser automation harness — **recommended next**

- **Benefit:** the upload UI and drop handling are currently untested end to end; the last mile is exactly where regressions live.
- **Approach:** add Playwright as a dev dependency, one spec against `wrangler dev --local` with a stub S3 adapter route, plus a small production smoke spec behind Access.
- **Complexity:** low-medium; no runtime cost.
- **Limits:** production specs need an Access service token, which is an owner action.

---

## Production smoke-test results

| Field | Value |
|---|---|
| URL | `https://s3-browser.tom-andrew-wilson.workers.dev/` |
| Deployment | `5383f991-121a-4249-a277-9e100c848517` |
| Date/time | 2026-11-21 15:20–15:50 EST |
| Auth | Existing Cloudflare Access session in the local browser profile; no bypass, no credential extraction |
| Test prefix | `__s3_browser_qa__/baseline-1795292633/` (109 objects, plus `bulk2/` with 100 for the subrequest test) |
| Fixtures | empty.txt, hello.txt, binary.dat, large-30mb.bin, nested/level-one/level-two/nested-file.txt, `spaces in name.txt`, `unicode-测试.txt`, duplicates/{first,second}/shared.txt, bulk/{1..100}, bulk2/{1..100} |
| Checksums | `hello.txt` `a948904f…a447`, `binary.dat` `150d3582…094a`, `empty.txt` `e3b0c442…b855` all match local SHA-256 |
| Cleanup | `aws s3 rm --recursive s3://064592191516-audio/__s3_browser_qa__/` → `aws s3 ls … --recursive` returns nothing. **Zero QA objects remain.** The local run's prefix `__s3_browser_qa__/local-1795293384/` was deleted through the UI and verified with `list-objects-v2` → 0, then the `__s3_browser_qa__/` marker was removed. |
| Non-QA data | untouched; no operation ran outside `__s3_browser_qa__/` |

---

## Recommended next steps

1. **Deploy and finish the production pass** (requires owner approval). Firefox is now covered locally (F-20…F-22) and needs the four-step manual check above against the deployed build. The fixes now include two defects that only appeared under real usage — non-ASCII downloads (F-12) and folder copy flattening (F-13) — plus honest cancel reconciliation (F-14). Re-run: upload file/folder/Unicode, drop a folder, recursive delete of > 1,000 objects, folder copy/move/rename, cancel mid-run, retry, and the 30 MiB download (F-04).
3. **Make `wrangler dev` usable again** (F-19): move published assets into a dedicated directory instead of `assets.directory: "./"`, so the dev watcher stops reacting to `.wrangler/` writes.
4. **Replace native dialogs** with an in-app modal before adding conflict UI (F-09).
5. **Persist jobs** in KV at batch boundaries so cancel/retry survive isolate changes, and so a restart cannot strand partial work silently (F-07/F-18).
6. **Turn the local harness into a checked-in Playwright spec** — it already drives the real UI and real S3; formalising it would have caught F-12…F-17 before this pass (gap 4).
7. **Folder ZIP download** as the last major usability gap (gap 3).
8. **Synchronization and conflicts** as a separate product initiative, not a patch (gap 1).

---

## Deployment boundary

The approved plan for this run explicitly excluded deployment. Nothing here was deployed, and no Cloudflare Access policy, AWS IAM permission, credential, bucket setting or secret was changed. Deploying `cloudflare/worker.mjs`, `cloudflare/s3-adapter.mjs` and `index.html` is the single action required to put these fixes live; it needs explicit owner approval, after which the `__s3_browser_qa__/post-deploy-<ts>/` pass should be run and appended to this report.
