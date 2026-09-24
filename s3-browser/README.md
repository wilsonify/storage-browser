# S3 Browser

A minimal local S3 file browser.

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
cp .dev.vars.example .dev.vars
# edit .dev.vars with your AWS keys and bucket
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

Recommended values:

- `AWS_REGION=us-east-1`
- `S3_BROWSER_BUCKET=064592191516-audio`
- `ALLOWED_BUCKETS=064592191516-audio`

The default bucket is configurable and is not hard-coded inside the UI. The Worker validates bucket and key names to prevent traversal and rejects requests outside the configured allow-list.

## What it does

- Lists S3 buckets in a sidebar
- Browse folders (prefixes) with breadcrumb navigation
- View file name, size, and modified date
- Sort by name/size/date
- Filter/search within current view
- Open/download files in a new tab
- Queue asynchronous move/copy/delete/rename operations with persisted state
- Move files and folders safely via copy-then-delete
- Drag/drop, right-click context menu, multi-select, and Explorer-like keyboard shortcuts
- Back / Forward / Up / Refresh navigation
- Operations panel with queued/running/completed/failed states and retry
- Keyboard navigation (arrow keys, Enter, Backspace to go up)
- Infinite scroll for large directories

## What it does NOT do

- Upload new objects from local files
- Expose AWS credentials to the browser
- Require authentication (localhost only)

## Security

AWS credentials stay in `~/.aws/credentials` and are read by the Node server using the AWS SDK's `fromIni()` credential provider. The browser never sees keys, tokens, or the credentials file.
