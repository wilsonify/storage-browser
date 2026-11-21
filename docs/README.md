# S3 Browser documentation

S3 Browser is an S3 file manager. It runs two ways:

- **Locally** as a small Node process on your own machine, using your AWS CLI
  profile. Nothing is exposed beyond loopback by default.
- **Hosted** as a single Cloudflare Worker, reachable only through Cloudflare
  Access, with the browser UI served as static assets. This is the free-hosting
  path: no VPS, container, always-on Node process, database, or paid hosting.

AWS S3 is a paid service. The interface and its hosting are designed to stay
inside Cloudflare's free allowances.

## Start here, by role

| You are… | Read |
| --- | --- |
| **A user** who was given access to a hosted S3 Browser | [Getting started](getting-started.md) |
| **An admin** deploying it to your own Cloudflare account | [Cloudflare deployment](cloudflare-deployment.md) |
| **An admin** responsible for keys, access policy and blast radius | [Security model](security.md) |
| **A developer** running, testing or changing the code | [Development](development.md) |
| **Anyone** deciding whether this fits a free account | [Costs and limits](costs-and-limits.md) |

## What it does

- Lists the buckets your credentials can see, with a bucket allow-list on top
- Browses folder prefixes with breadcrumbs, back/forward/up, refresh
- Sorts by name, size or date; filters the current view; infinite scroll
- Downloads objects in a new tab
- Queues copy, move, rename and delete as background operations with progress,
  retry and cancel
- Keeps AWS credentials on the server side, never in the browser

## What it does not do in hosted mode

| Capability | Local / desktop | Hosted Worker |
| --- | --- | --- |
| Browse, download, sort, filter | Yes | Yes |
| Copy, move, rename, delete objects | Yes | Yes, within subrequest limits ([costs and limits](costs-and-limits.md#request-and-subrequest-budgets)) |
| Drag local files into the browser to upload them | Yes — the local server reads local paths | **No.** The UI sends a `syncLocalToS3` operation and the Worker rejects it, because a Worker cannot read your filesystem |
| Upload through the HTTP API | — | `POST /api/upload` exists, but the shipped UI does not call it |
| Durable operation history across restarts | Yes, file-backed | **No.** Queued work, progress and history live in the current isolate's memory |
| Range requests while streaming large media | Not supported | Not supported |

If you need uploads or a durable queue, that is a feature gap, not a
configuration mistake. See [Development](development.md#known-gaps).

## The hosted architecture

```
Browser ──► Cloudflare Access (login + policy) ──► Cloudflare Worker ──► AWS S3
             │                                       │
             │ adds Cf-Access-Jwt-Assertion          └ serves index.html + assets/,
             └ denies unauthenticated visitors          and runs /api/*
```

Two independent gates protect S3:

1. **Cloudflare Access** decides who may reach the hostname at all.
2. **The Worker** verifies the Access JWT on every privileged request, so a route
   without an Access policy is still not usable.

Neither gate is CORS. CORS only decides which browser origins may read responses,
and unset `ALLOWED_ORIGINS` denies all cross-origin use.

## Repository layout

```
storage-browser/
├── docs/                 # These documents
├── s3-browser/           # The application
│   ├── index.html        # Single-file vanilla UI
│   ├── server.mjs        # Local Node backend
│   ├── cloudflare/       # Worker: worker.mjs, auth.mjs, s3-adapter.mjs, tests
│   ├── wrangler.jsonc    # Worker configuration
│   ├── .assetsignore     # Public asset whitelist
│   ├── src-tauri/        # Desktop shell
│   └── test/             # Node test suites
├── helm/                 # Chart for a local k3s cluster
└── Dockerfile            # Container image for the Node backend
```

## Common first questions

**Do I need a domain?** No. The Worker's `workers.dev` hostname works, and
Cloudflare Access can be enabled on it directly.

**Do I need a database?** No. Ordinary operation needs no persistence service.
The Worker's operation queue is in-memory and non-durable.

**What will Cloudflare cost?** $0 within the free allowances: 100,000 Worker
requests/day, 10 ms CPU per request, free and unlimited static-asset requests, and
Access free for teams under 50 users. Details and citations:
[costs and limits](costs-and-limits.md).

**What will AWS cost?** Normal S3 storage, request and data-transfer charges. That
is the only bill this architecture is designed to produce.

**Is a live deployment verified?** Not by the repository. The deployment runbook
and the authentication tests are real, but no Cloudflare Access tenant, policy or
live sign-in is included or asserted.
