# S3 Browser

An S3 file-management application with a local Node backend and a Cloudflare
Worker variant. These backends do **not** share all exposure, upload, or queue
durability guarantees.

**User/operator projection:** the workflows and trust boundaries below.
**Developer/automation reference:** [package commands](package.json),
[local request handling](server.mjs), [operation store](operations-store.mjs),
[operation worker](operations-worker.mjs), and [Worker handling](cloudflare/worker.mjs)
own the interfaces and behavior. Discover scripts with `npm run`; run `npm test`
for the assertions maintained with the implementation, not proof of live AWS
permissions or deployment security.

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

## How it works

```
index.html  →  Node.js server (localhost:3737)  →  AWS SDK  →  S3
```

- **`index.html`** — vanilla HTML/CSS/JS file manager, served by the Node server
- **`server.mjs`** — tiny Node.js HTTP server that proxies S3 API calls using `@aws-sdk/client-s3` with your local `~/.aws/credentials` `personal` profile
- **No credentials in the browser** — the server reads credentials from your existing AWS CLI profile via `fromIni()`, never exposes them over HTTP

## Cloudflare Workers deployment

The same frontend can also be served from a Cloudflare Worker while keeping the Windows/Tauri app untouched.

### Files added

- `wrangler.jsonc` — minimal Worker configuration with static assets
- `cloudflare/worker.mjs` — Worker entry point implementing the existing `/api/*` endpoints
- `cloudflare/s3-adapter.mjs` — AWS S3 adapter that validates bucket/key parameters and keeps credentials in Worker secrets
- `cloudflare/worker.test.mjs` — validation tests for bucket/key safety

### Local setup

```bash
cd s3-browser
npm install
# Create an uncommitted .dev.vars with settings required by the adapter.
# There is no .dev.vars.example in this checkout; inspect cloudflare/s3-adapter.mjs.
npx wrangler dev --local
```

### Deploy

```bash
cd s3-browser
npx wrangler login
npx wrangler deploy
```

Set secrets in the Cloudflare dashboard or with Wrangler:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put AWS_REGION
```

Review [Worker configuration](wrangler.jsonc) and
[adapter configuration handling](cloudflare/s3-adapter.mjs) for the declared settings. Replace account-specific sample buckets with resources
you intend to expose; do not treat the checked-in values as general recommendations.

**Before deployment:** the Worker entry point does not authenticate callers.
Establish and verify an external access-control boundary and least-privilege AWS
permissions before exposing it. CORS and a bucket allow-list are not user
authentication. Worker operations are held in module-local memory, unlike the
local backend's file-backed store; do not assume queued work or history survives
Worker restarts or is shared across isolates.

The default bucket is configurable and is not hard-coded inside the UI. The Worker validates bucket and key names to prevent traversal and rejects requests outside the configured allow-list.

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
- Provide caller authentication in the inspected Node/Worker entry points

## Upload and operation boundaries

The [local server](server.mjs) accepts local-file transfer operations, and the
[Worker](cloudflare/worker.mjs) has an upload handler. Consult the active backend
and UI rather than treating upload capabilities as identical across variants.
Queued acceptance is not completion: inspect operation results and errors before
assuming a copy, move, delete, or transfer succeeded. Persistence is owned by each
backend; a shared frontend does not establish shared recovery semantics.

## Security

The local server uses the AWS SDK's profile credential provider; credential
selection is owned by [server.mjs](server.mjs), not a second settings list here.
The browser receives operation results rather than the credential configuration.
The local bind address defaults to loopback but is configurable: keep it restricted
unless you have supplied and verified an appropriate access-control boundary.
The service can perform mutations using its AWS permissions; hiding credentials
from the browser does not authorize callers. See the Worker warning above before
using a remotely accessible deployment.
