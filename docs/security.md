# Security model (admins and developers)

S3 Browser performs destructive operations with a real AWS identity. Treat the
deployment as an admin console for those buckets, not as a public file viewer.

This document describes what protects it, what does not, and what you still own.

## Trust boundaries

```
Internet
  │
  ├─(1)─► Cloudflare Access ── login + policy ─┐ denies unauthenticated visitors
  │                                            │ adds Cf-Access-Jwt-Assertion
  │                                            ▼
  └─────────────────────────────────────► Cloudflare Worker
                                             ├─(2) verifies the Access JWT
                                             ├─(3) applies CORS (origins only)
                                             └─(4) calls S3 with Worker secrets
                                                        │
                                                        ▼
                                                   AWS S3
```

Four independent facts, each of which must hold:

1. **Access admits the person.** Without a policy match there is no session.
2. **The Worker verifies the token.** A request that did not come through Access
   with a valid, correctly-audienced token is rejected.
3. **CORS is not authorization.** It only decides which browser origins may read a
   response. Unset `ALLOWED_ORIGINS` denies all cross-origin use.
4. **IAM limits the damage.** The key in Worker secrets is the final bound on what
   any admitted user can do.

## Layer 1 — Cloudflare Access

Configured in the dashboard, not in this repository. Recommended:

- One policy per audience. Start with an explicit email list or a one-time-PIN
  rule; add an identity provider when there is more than one person.
- Keep the session duration sane (hours, not weeks) — the Worker accepts a token
  only while it is valid.
- For automation, use an Access **service token** rather than sharing a human
  session. Service tokens are also JWTs, so the Worker verifies them the same way.
- Remember Access protects **routes**, not the Worker. Preview URLs, custom
  domains and additional routes each need attention.

## Layer 2 — Worker JWT verification

Implemented in [cloudflare/auth.mjs](../s3-browser/cloudflare/auth.mjs) and applied
in [cloudflare/worker.mjs](../s3-browser/cloudflare/worker.mjs) before any
privileged routing.

What is checked, in order:

| Check | Failure |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are configured | `503`, no privileged work |
| `Cf-Access-Jwt-Assertion` header is present and is a 3-part JWT | `401` |
| Header `alg` is exactly `RS256`; `kid` present | `401` |
| Signing keys fetched from `https://<team>/cdn-cgi/access/certs` | `503` — fail closed, no stale-key fallback |
| `kid` matches a published RSA key (one rate-limited refresh for rotation) | `401` |
| RSASSA-PKCS1-v1_5 / SHA-256 signature over `header.payload` | `401` |
| `iss` equals `https://<team>` | `401` |
| `aud` contains `ACCESS_AUD` (string or array form) | `401` |
| `exp` in the future (60 s clock skew allowed) | `401` |
| `nbf`, when present, not in the future | `401` |

Implementation notes:

- Keys are cached in memory for five minutes. If a key id is unknown, the key set
  is refreshed at most once per 30 seconds, so an unauthenticated caller cannot
  turn every request into a subrequest.
- The `CF_Authorization` cookie is deliberately ignored. Cloudflare's own guidance
  is to validate the header, because the cookie is not guaranteed to be forwarded.
- Tokens are never logged, echoed, or stored.
- There is no bypass switch, no `DISABLE_AUTH` variable, and no local-development
  exemption. Adding one would break the only control that survives an Access
  misconfiguration.

### Public surfaces

Exactly two API surfaces skip authentication:

| Surface | Response | Why it is safe |
| --- | --- | --- |
| `OPTIONS` on any `/api/*` path | `204`, CORS headers only for configured origins | Preflight carries no credentials and grants nothing |
| `GET /api/health` | `{"ok":true}` | No region, configuration, credential state or timestamp is disclosed |

Everything else — buckets, listing, download, upload, move, operations, retry,
cancel — requires a verified token. Non-API paths return `404` JSON from the
Worker; the UI itself is served as static assets.

## Layer 3 — CORS

- `ALLOWED_ORIGINS` unset or empty ⇒ no `Access-Control-Allow-Origin` on any
  response, and none on preflight.
- Only exact configured origins are echoed. Wildcards are never emitted.
- `Access-Control-Allow-Credentials: true` is sent only to an allowed origin.
- Allowed request headers are limited to `Content-Type`. The browser cannot and
  does not set `Cf-Access-Jwt-Assertion`.
- `Vary: Origin` is always set on API responses.

The bundled UI is same-origin and needs no entry. Add an origin only if you are
building a separate client that is itself behind the same Access application.

## Layer 4 — Public assets

`assets.directory` is the repository root, so
[.assetsignore](../s3-browser/.assetsignore) is a whitelist:

```
/*
!/index.html
!/assets
```

That publishes exactly three files: `index.html`,
`assets/s3_browser_icon.ico`, `assets/s3_browser_icon.svg`. Everything else —
`node_modules`, `src-tauri`, `dist`, `scripts`, `test`, `cloudflare`,
`package.json`, `package-lock.json`, `wrangler.jsonc`, docs, `.data`,
`.freebuff`, `.wrangler` — is excluded.

Keep it a whitelist. An ignore-list version silently publishes every file added
later, which is how `.env`-style leaks happen. Verify before deploying:

```bash
WRANGLER_LOG=debug npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

## Credentials

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are Worker **secrets**, set with
  `npx wrangler secret put`. They are never sent to the browser, never embedded in
  assets, and never appear in API responses.
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOWED_ORIGINS`, bucket names and region
  are public identifiers and belong in vars.
- The Worker reports a generic `500 Request failed` for unexpected errors and logs
  only the error type, because SDK error text can carry bucket names, request ids
  and SigV4 credential scopes.

### Least-privilege IAM

Create a dedicated user. Start from this and narrow it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListVisibleBuckets",
      "Effect": "Allow",
      "Action": "s3:ListAllMyBuckets",
      "Resource": "*"
    },
    {
      "Sid": "BrowseAndRead",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::YOUR-BUCKET",
        "arn:aws:s3:::YOUR-BUCKET/*"
      ]
    },
    {
      "Sid": "WriteAndDeleteForMovesAndUploads",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

`s3:ListAllMyBuckets` is what populates the sidebar; without it the Worker cannot
list buckets. If you only ever use one bucket, consider dropping it and treating
the single-bucket view as the product surface — the API still requires an explicit
bucket parameter.

For a read-only deployment, remove the third statement. The UI will still offer
delete and move, and those operations will fail with S3 permission errors — the
UI does not hide actions it cannot perform.

### Rotation

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

Rotating the AWS key takes effect after the secret update. Revoking an Access user
happens in the Access policy; their existing session lasts until the token expires.

## What is not protected

- **No per-user authorization.** Every admitted user can do everything the IAM key
  allows, on every bucket in the allow-list. There are no roles, no read-only
  users, no per-prefix scoping.
- **No audit trail in the application.** Cloudflare logs requests (not object
  content); object-level history requires S3 server access logs or CloudTrail,
  which are off by default and can cost money.
- **No rate limiting** beyond the platform's free-tier request ceiling. A
  compromised Access session can issue requests as fast as the plan allows.
- **No CSRF token** — the app has no cookie-based auth of its own, and mutations
  require a valid Access JWT. If you add a custom domain or a second Access
  application, re-check this assumption.
- **No CSP or security headers are set.** The UI escapes object names before
  inserting them into HTML, but a Content-Security-Policy is not shipped. Adding a
  `_headers` file with a strict CSP is a reasonable future hardening step, not
  currently implemented.
- **No defence against a malicious object name** beyond escaping at render time and
  key validation at the adapter. Bucket and key inputs are validated for traversal
  and shape before reaching S3.

## Hardening checklist

- [ ] Access enabled on the exact route you use; policy lists only intended people
- [ ] `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set; `/api/health` reachable only behind Access
- [ ] `ALLOWED_ORIGINS` empty, or exactly the origins you mean to allow
- [ ] `.assetsignore` intact; dry run shows three assets
- [ ] AWS key is a dedicated IAM user, scoped to the intended buckets and actions
- [ ] `ALLOWED_BUCKETS` matches that IAM scope
- [ ] No secrets in `wrangler.jsonc`, committed `.dev.vars`, or the repository
- [ ] Someone knows how to rotate the AWS key and revoke an Access user
