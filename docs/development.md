# Development

How to run, test and change S3 Browser. The UI is a single `index.html` with no
framework, bundler or transpiler, shared by both backends.

## Prerequisites

- Node.js 20 or newer (this repository is developed on Node 24)
- `npm install` in `s3-browser/`
- For the local backend: an AWS CLI profile, or standard AWS environment variables

## The local backend

```bash
cd s3-browser
npm install
npm start           # http://127.0.0.1:3737
npm test
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `S3_BROWSER_PORT` | `3737` | Listen port |
| `S3_BROWSER_HOST` | `127.0.0.1` | Bind address. Keep it on loopback unless you have your own verified access control |
| `S3_BROWSER_NO_OPEN` | unset | Set to `1` to stop the automatic browser launch |
| `AWS_PROFILE` | unset | Profile to read from `~/.aws/credentials` |
| `AWS_REGION` | `us-east-1` | S3 region |
| `S3_ENDPOINT` | unset | S3-compatible endpoint (MinIO); enables path-style requests |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | If set, the SDK uses them instead of the profile |

With no explicit profile or environment credentials, the server falls back to the
shared profile `personal`. That fallback is a local-desktop convenience; it is not
used by the Worker.

Operation state is written to
`%LOCALAPPDATA%\s3-browser\operations.json` (or `%APPDATA%`, then
`~/.s3-browser`). The local queue is file-backed and survives restarts; the
Worker's is not.

## Tests

```bash
npm run test:cloudflare    # Worker + auth suite, no network, no credentials
npm test                   # Node's full discovery: test/ and cloudflare/*.test.mjs
```

`npm run test:cloudflare` runs `cloudflare/auth.test.mjs` and
`cloudflare/worker.test.mjs` with `node --test` — currently 33 tests, 30 of them
covering authentication and Worker behaviour.

The suites are self-contained by design:

- RSA keypairs are generated per run with `node:crypto`.
- The JWKS endpoint is stubbed and passed in as `fetchImpl`; the clock is injected.
- The S3 adapter is stubbed through `createHandler({ createAdapter })`, which is how
  tests assert that an unauthenticated request never constructs the adapter at all.
- Nothing contacts Cloudflare or AWS. Passing tests prove behaviour, not that a
  live Access tenant or IAM policy is configured correctly.

## Worker architecture

```
cloudflare/worker.mjs      request flow, routing, CORS, in-module operation queue
cloudflare/auth.mjs        Access JWT verification + JWKS cache
cloudflare/s3-adapter.mjs  S3 client, bucket/key validation, object operations
cloudflare/auth.test.mjs   auth + integration tests
cloudflare/worker.test.mjs bucket/key validation tests
```

Request flow in `worker.mjs`:

1. `OPTIONS` → preflight (CORS headers for configured origins only, never `*`).
2. `/api/health` → `{ok:true}`, adapter never constructed.
3. Anything not under `/api/` → `404` JSON.
4. Every other `/api/*` → authenticate, then route.
5. Successful or not, the response gets CORS headers; unexpected errors become a
   generic `500`.

The adapter is created lazily (`getAdapter()`), so routes that do not touch S3
(`/api/operations` list, cancel, retry) never build an S3 client.

### Route reference

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `OPTIONS` | any `/api/*` | public | Preflight only; grants nothing |
| `GET` | `/api/health` | public | `{"ok":true}` and nothing else |
| `GET` | `/api/buckets` | required | Buckets visible to the credentials |
| `GET` | `/api/buckets/:bucket/objects` | required | `prefix`, `continuationToken`, `delimiter`; 1,000 keys/page |
| `GET` | `/api/download` | required | `bucket`, `key`; streams the object |
| `POST` | `/api/upload` | required | `multipart/form-data`: `bucket`, `key`, `file` (not used by the shipped UI) |
| `GET` | `/api/operations` | required | In-memory list |
| `POST` | `/api/operations` | required | `{type, payload}`; types `move`, `copy`, `delete`, `rename` |
| `POST` | `/api/move` | required | `{bucket, sources, destination}` |
| `GET` | `/api/operations/:id` | required | One operation |
| `POST` | `/api/operations/:id/retry` | required | Failed operations only |
| `POST` | `/api/operations/:id/cancel` | required | Cooperative; does not roll back |

### The authentication module

`auth.mjs` exports:

- `getAccessConfig(env)` → `{teamDomain, audience, issuer, certsUrl}`, or `null`
  when either required var is missing or the team domain is malformed.
- `authenticate({token, env, fetchImpl, now})` → `{ok:true, claims}` or
  `{ok:false, status, reason}`. `status` is `401` for credential problems and
  `503` for configuration/JWKS problems. `fetchImpl` and `now` exist for tests.
- `__resetCaches()` — test-only; clears cached signing keys.

Signing keys are cached in a module `Map` keyed by team domain for five minutes.
An unknown `kid` triggers one forced refresh, but no more often than once per 30
seconds per team domain. There is no stale-key fallback: if the key set cannot be
fetched, requests fail with `503`.

## Adding an endpoint

Work through this list; the security posture depends on it.

1. Add the route inside `handleApi` in `worker.mjs`, after the auth gate — never
   before it, and never as a new public exception.
2. Use `getAdapter()` rather than constructing an adapter in the route.
3. Validate bucket and key inputs through `s3-adapter.mjs` helpers; do not pass
   request strings straight to the SDK.
4. Return the shared `json()` helper so `Cache-Control: no-store` and content type
   stay consistent.
5. Add a test in `cloudflare/auth.test.mjs` that asserts (a) the happy path with a
   valid token and (b) `401` with no token and the adapter untouched.
6. If the endpoint changes UI behaviour, remember both backends share
   `index.html`: implement the local route in `server.mjs` too, or gate the UI on
   capability.

## Verifying what gets published

```bash
WRANGLER_LOG=debug npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

`assets.directory` is the repository root and [.assetsignore](../s3-browser/.assetsignore)
is a whitelist (`/*`, `!/index.html`, `!/assets`). The debug output prints one
`Ignoring asset:` line per excluded path; the only files that should remain are the
UI and the two icons. Keep `nodejs_compat` in `wrangler.jsonc` — `@aws-sdk/client-s3`
imports `node:crypto`, `node:stream`, `node:http` and `node:fs`.

The dry run reports the script size only (about 686 KiB raw / 132 KiB gzip); it does
not upload or size assets. Verify asset inclusion from the ignore log, not from the
`Total Upload` figure.

## Local Worker development

```bash
npx wrangler dev --local
```

Expect `401`/`503` for every privileged call: a local browser request carries no
Access JWT, and the Worker fails closed. That is correct behaviour — do not add a
development bypass. If you need a real token locally, mint one through an Access
application and send `Cf-Access-Jwt-Assertion` explicitly.

Do not create `.dev.vars` in this repository unless you also add it to a
`.gitignore`; the parent `.gitignore` does not currently list it.

## Packaging

```bash
npm run package:win     # dist/s3-browser.exe (Node SEA)
npm run tauri:dev       # desktop shell, dev
npm run tauri:build     # desktop shell, release
```

These paths are unrelated to the Worker deployment and are unaffected by it.

## Known gaps

- The UI can queue `syncLocalToS3` when you drop local files. The local backend
  supports it; the Worker's allowed types are `move`, `copy`, `delete`, `rename`,
  so hosted mode returns `400 Invalid operation type`. A Worker cannot read local
  paths — a real upload flow would need `POST /api/upload` wired into the UI.
- The Worker's operation queue is module-local memory: no durability, no sharing
  across isolates, reset on deploy.
- Downloads are full-object. Range requests are not implemented.
- No upload UI, no folder download, no versioning or restore.
- No CSP or other security headers are shipped.

## Conventions

- No framework, bundler or transpiler. Keep it that way.
- One UI for both backends: prefer capability detection over forking `index.html`.
- No new runtime dependency without a stated reason; the Worker bundle and the
  free 10 ms CPU budget are the constraints.
- Comments explain *why* a security-relevant line exists. The tests are the
  contract for auth behaviour.
