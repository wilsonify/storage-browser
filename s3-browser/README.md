# S3 Browser

An S3 file-management application with a local Node backend and a Cloudflare
Worker backend. These backends do **not** share all exposure, upload, or queue
durability guarantees.

**User/operator projection:** the workflows and trust boundaries below.
**Developer/automation reference:** [package commands](package.json),
[local request handling](server.mjs), [operation store](operations-store.mjs),
[operation worker](operations-worker.mjs), [Worker handling](cloudflare/worker.mjs),
and [Worker authentication](cloudflare/auth.mjs) own the interfaces and behavior.
Discover scripts with `npm run`; run `npm test` for the assertions maintained with
the implementation, not proof of live AWS permissions or deployment security.

## Start

```bash
cd s3-browser
npm install   # first time only
npm start
npm test
```

Then open **http://localhost:3737**

## Single-file Windows distribution

Build a standalone `exe` (includes Node runtime, backend, UI, and dependencies):

```bash
cd s3-browser
npm install
npm run package:win
```

Output:

- `dist/s3-browser.exe`

Run it from any directory:

```bash
path\to\s3-browser.exe
```

Notes:

- The executable uses your existing AWS profile credentials (`personal`) from your local AWS config files.
- Operation queue state is stored in `%LOCALAPPDATA%\s3-browser\operations.json` (or `%APPDATA%` fallback), not next to the executable.
- Set `S3_BROWSER_NO_OPEN=1` to prevent automatic browser launch.

## How the local app works

```
index.html  →  Node.js server (localhost:3737)  →  AWS SDK  →  S3
```

- **`index.html`** — vanilla HTML/CSS/JS file manager, served by the Node server
- **`server.mjs`** — tiny Node.js HTTP server that proxies S3 API calls using `@aws-sdk/client-s3` with your local `~/.aws/credentials` `personal` profile
- **No credentials in the browser** — the server reads credentials from your existing AWS CLI profile via `fromIni()`, never exposes them over HTTP

The local server is loopback-oriented and does not authenticate callers. Keep it
bound to loopback unless you put your own verified access-control boundary in
front of it.

## Cloudflare Workers hosting

```
Browser → Cloudflare Access → Cloudflare Worker → AWS S3
```

The hosted variant is a single Cloudflare Worker: it serves the browser UI as
Workers static assets, and it executes the S3 API operations. Production needs no
VPS, container, always-running Node process, database, or separate hosting bill.

### Cost model

Two distinct costs, deliberately separated:

- **Cloudflare hosting: $0 within the documented free allowances.** Static-asset
  requests are free and unlimited, and Workers Free allows 100,000 requests/day
  with 10 ms of CPU per request. Cloudflare Access is included in the Zero Trust
  Free plan for teams under 50 users.
- **AWS S3: paid and accepted.** Storage, requests and the data transfer AWS
  charges when the Worker reads objects are your normal S3 cost. Cloudflare does
  not charge egress.

Free allowances are allowances, not unlimited service. On the Workers Free plan
exceeding them fails requests instead of billing: past 100,000 requests in a UTC
day the Worker returns Error 1027, and consistently exceeding 10 ms of CPU per
request terminates the invocation. Money is involved only if you subscribe to
Workers Paid ($5/month minimum) or grow past 50 Access users.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
[Zero Trust plans](https://www.cloudflare.com/sase/products/access).

### Files

- `wrangler.jsonc` — Worker configuration, `nodejs_compat`, public vars
- `.assetsignore` — whitelist: only `index.html` and `assets/` are published
- `cloudflare/worker.mjs` — Worker entry point implementing the `/api/*` endpoints
- `cloudflare/auth.mjs` — Cloudflare Access JWT verification (RS256, WebCrypto)
- `cloudflare/s3-adapter.mjs` — S3 adapter; validates bucket/key parameters and keeps credentials in Worker secrets
- `cloudflare/worker.test.mjs`, `cloudflare/auth.test.mjs` — validation and authentication tests

### Authentication

Cloudflare Access is the access-control boundary. The Worker additionally verifies
the Access JWT on every request, because a route without an Access policy would
otherwise be reachable directly.

- The token is read from the `Cf-Access-Jwt-Assertion` header, which Cloudflare
  Access adds to requests it forwards. A caller cannot forge it.
- Signature, algorithm (`RS256` only), key id, issuer, audience, `exp` and `nbf`
  are all validated against the team's published keys at
  `https://<team>/cdn-cgi/access/certs`, cached in memory for five minutes.
- Missing or invalid credentials return `401` with `WWW-Authenticate: Bearer`.
- If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is unset, or the signing keys cannot be
  fetched, every privileged request returns `503`. The application fails closed;
  there is no bypass and no stale-key fallback.
- Exactly two API surfaces are public: `OPTIONS` preflight (no credentials, no
  authorization) and `/api/health`, which returns `{"ok": true}` and nothing else.

### Configuration

Vars in [wrangler.jsonc](wrangler.jsonc) (public values):

| Name | Purpose |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Your Access team domain, e.g. `my-team.cloudflareaccess.com`. Empty = fail closed. |
| `ACCESS_AUD` | The Access application's Application Audience (AUD) tag. Empty = fail closed. |
| `ALLOWED_ORIGINS` | Comma-separated exact browser origins allowed to read API responses. Empty denies all cross-origin use; the bundled UI is same-origin and needs no entry. |
| `S3_BROWSER_BUCKET` | Default bucket. |
| `ALLOWED_BUCKETS` | Comma-separated bucket allow-list. |
| `AWS_REGION` | Optional S3 region; defaults to `us-east-1`. |

Secrets (never commit these):

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Use a least-privilege IAM key limited to the buckets in `ALLOWED_BUCKETS`; the
Worker can perform any S3 action that key permits.

CORS is not authentication. It only decides which browser origins may read
responses, and only configured origins ever receive an
`Access-Control-Allow-Origin` header. No response or preflight returns `*`.

### Local development

The Node backend remains the way to develop against S3 locally:

```bash
npm start
npm run test:cloudflare
npm test
```

`npm run test:cloudflare` runs the Worker tests with Node's built-in test runner.
They generate their own RSA keypair and stub the JWKS endpoint, so they need no
Cloudflare account, Access tenant, AWS credentials, or network.

To exercise the Worker itself:

```bash
npx wrangler dev --local
```

`wrangler dev` serves the UI and Worker locally, but every privileged API call
returns `401`/`503` because a local browser request carries no Access JWT. That is
the intended fail-closed behavior, not a bug. Do not create an unauthenticated
local bypass in the Worker to work around it. Worker secrets can be provided in an
uncommitted `.dev.vars` file (this repository has no `.gitignore`, so never create
one containing real credentials).

### Deploy

```bash
cd s3-browser
npx wrangler login
npx wrangler deploy
```

Then:

1. In the Cloudflare dashboard open the Worker → **Settings → Domains & Routes**,
   and enable **Cloudflare Access** for the `workers.dev` route. Configure an email
   or identity-provider policy so only you can reach it.
2. Copy the access team domain and the application's AUD tag from the Access
   application into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (dashboard → Worker →
   Settings → Variables, or `wrangler.jsonc`).
3. Set the AWS secrets as shown above, then redeploy after any config change.

Verify an upload manifest before deploying:

```bash
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

`assets.directory` is the repository root, so [.assetsignore](.assetsignore) is a
whitelist: `/*` is ignored except `index.html` and `assets/`. Development files,
`node_modules`, `src-tauri`, `dist`, `scripts`, `test`, `cloudflare`,
`package.json`, `package-lock.json`, `wrangler.jsonc` and the docs are not
published. With `WRANGLER_LOG=debug` the dry run prints an `Ignoring asset:` line
per excluded path; the only remaining files should be `index.html` and the two
icons under `assets/`.

The public UI works without invoking the Worker: a request for `/` matches a
static asset, and only `/api/*` requests run code.

### Free-tier limits that shape behavior

- **100,000 requests/day.** The UI polls `/api/operations` every 1.2 seconds while
  a tab is open, so a tab left open continuously consumes roughly 72,000 requests
  per day on its own. Close the tab when you are done.
- **10 ms CPU per request.** Waiting on S3 does not count, but SigV4 signing and
  XML parsing do. Very large listings are the most likely place to approach this.
- **50 subrequests per request.** Move, copy and delete run one S3 operation per
  object inside a single invocation, so a single queued operation touching more
  than roughly 25 objects can fail part-way. Failures are reported per operation.
- **20,000 static files, 25 MiB each.** Far above this application's three files.
- **Workers Logs** has a free daily allowance; from 1 December 2026 it is billed by
  ingested volume with a free daily allowance and no overage purchase on the Free
  plan.

### Known limitations

- The operation queue is module-local memory. Queued work, progress and history
  are not durable: they are lost on isolate eviction, restart or redeploy and are
  not shared between isolates. Do not treat a queued operation as durable work.
- The Worker accepts Upload/Download operations but the served UI performs
  downloads only; uploads are an API capability.
- Downloads are full-object responses. Range requests (seeking inside large media)
  are not supported.
- The local Node server and the Worker have different credential sources and
  different queue lifetimes; a shared frontend does not make them equivalent.

### Remaining security requirements

- Cloudflare Access only protects the routes it is attached to. Enable it on the
  `workers.dev` route and remember that version preview URLs are separate.
- Cloudflare Access must be paired with the JWT verification in
  `cloudflare/auth.mjs`; do not disable it or add an unauthenticated route.
- The AWS key's IAM policy is the final limit on damage. Scope it to the intended
  buckets and actions.
- There is no per-user authorization beyond "authenticated caller": every user
  admitted by the Access policy can perform every operation the IAM key allows.
- No rate limiting is implemented beyond the platform's free-tier limits.

## What it does

- Lists S3 buckets in a sidebar
- Browse folders (prefixes) with breadcrumb navigation
- View file name, size, and modified date
- Sort by name/size/date
- Filter/search within current view
- Open/download files in a new tab
- Queue asynchronous move/copy/delete/rename operations (local state is file-backed;
  Worker state has a different lifetime)
- Move files and folders via copy-then-delete; review errors and partial results
  rather than assuming a move is atomic
- Drag/drop, right-click context menu, multi-select, and Explorer-like keyboard shortcuts
- Back / Forward / Up / Refresh navigation
- Operations panel with queued/running/completed/failed states and retry
- Keyboard navigation (arrow keys, Enter, Backspace to go up)
- Infinite scroll for large directories

## What it does NOT do

- Expose AWS credentials to the browser
- Authenticate callers of the local Node server, which is loopback-oriented
- Provide durable or cross-instance operation history on the Worker
