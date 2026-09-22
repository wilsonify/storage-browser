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

## How it works

```
index.html  →  Node.js server (localhost:3737)  →  AWS SDK  →  S3
```

- **`index.html`** — vanilla HTML/CSS/JS file manager, served by the Node server
- **`server.mjs`** — tiny Node.js HTTP server that proxies S3 API calls using `@aws-sdk/client-s3` with your local `~/.aws/credentials` `personal` profile
- **No credentials in the browser** — the server reads credentials from your existing AWS CLI profile via `fromIni()`, never exposes them over HTTP

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
