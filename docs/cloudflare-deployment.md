# Cloudflare deployment (admins)

A complete runbook for putting S3 Browser on Cloudflare's free plan, privately,
behind Cloudflare Access. Budget about 20 minutes.

Expected result: one Worker serving the UI and the S3 API, reachable only by
people covered by an Access policy, with no always-on server anywhere.

- Hosting cost target: **$0** inside Cloudflare's free allowances.
- AWS S3 cost: **paid, expected** — storage, requests and the data transfer AWS
  charges when objects are read.

Read [costs and limits](costs-and-limits.md) before you start, and
[security](security.md) before you hand out access.

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Cloudflare account on the Workers **Free** plan | Free plan is the default for new accounts |
| Node.js 20 or newer | This repository is developed on Node 24 |
| AWS credentials for the bucket(s) you want to expose | Use a dedicated least-privilege IAM user, not your root key ([example policy](security.md#least-privilege-iam)) |
| Wrangler | Installed locally by `npm install`; run it with `npx wrangler` |
| A domain | **Not required** — `workers.dev` is enough and supports one-click Access |

You do **not** need a database, KV namespace, R2 bucket, Durable Object, queue,
container, or custom domain.

## 2. Install and configure

```bash
cd s3-browser
npm install
```

`wrangler.jsonc` is gitignored because it holds deployment-specific bucket names
and Access values. Copy the committed template, then review it:

```bash
cd s3-browser
cp wrangler.example.jsonc wrangler.jsonc
```

The values you must review:

| Key | What to do |
| --- | --- |
| `name` | Worker name; becomes `https://<name>.<subdomain>.workers.dev` |
| `compatibility_flags: ["nodejs_compat"]` | **Keep.** `@aws-sdk/client-s3` needs the Node compatibility layer |
| `assets.directory` | Keep `"./"`. [.assetsignore](../s3-browser/.assetsignore) makes only `index.html` and `assets/` public |
| `S3_BROWSER_BUCKET` | Default bucket the UI opens |
| `ALLOWED_BUCKETS` | Comma-separated allow-list; keep it to what you actually expose |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Leave empty for the first deploy; filled in step 4 |
| `ALLOWED_ORIGINS` | Leave empty unless a separate origin must call the API. Empty denies cross-origin use |

`AWS_REGION` is optional (default `us-east-1`). Add it as a var if your bucket
lives elsewhere.

## 3. Deploy once and add the AWS secrets

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

At this point the UI already loads — it is static and needs no Worker — but every
API call fails closed with `503` because `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are
empty. That is intentional: nothing is reachable before Access is configured.

## 4. Put Cloudflare Access in front

1. Cloudflare dashboard → **Workers & Pages** → your Worker.
2. **Settings → Domains & Routes**.
3. Next to the `workers.dev` route, click **Enable Cloudflare Access**.
4. Click **Manage Cloudflare Access** to edit the application. Set a policy that
   matches reality: a one-time-PIN rule for your email, or your identity provider.
   Add the people who should have access and nobody else.
5. In that Access application, copy two values:
   - the **team domain**, e.g. `my-team.cloudflareaccess.com`
   - the **Application Audience (AUD) Tag**, a long hex string
6. Put them into the Worker as vars — either in your local `wrangler.jsonc`, or in
   the dashboard under **Settings → Variables and Secrets** — then redeploy:

```bash
npx wrangler deploy
```

Both values are public identifiers, not secrets. Leaving either empty keeps the
application closed.

> **Why the Worker verifies the token too.** Access only guards the routes it is
> attached to. Preview URLs, a second route, or a future misconfiguration can
> expose the Worker without an Access policy. The Worker therefore validates the
> `Cf-Access-Jwt-Assertion` header itself and refuses anything it cannot verify.

## 5. Verify

Work through this in order; each step isolates one layer.

1. **Static UI**: open the `workers.dev` URL in a private window. You should be
   redirected to the Access login, and after signing in see the bucket sidebar.
2. **Health**: `/api/health` is the only public API surface and returns
   `{"ok":true}`. If you can reach it without a login, Access is not enabled on
   that route yet.
3. **Authenticated read**: the sidebar lists buckets. Failure here means the
   Worker rejected the token or the AWS secrets are missing.
4. **Mutation**: rename a harmless test object, watch the operations panel reach
   *completed*, then rename it back. This proves the IAM key can read and write.
5. **Access enforcement**: open the same URL from a browser session that is not in
   the policy. You should be blocked before the application loads.

Create a scratch prefix for step 4. Do not test destructive operations on data you
care about: these actions are not reversible by the application.

## 6. Free-plan guardrails

- Stay on the **Workers Free** plan. Do not add a payment method for Workers.
- Do not add KV, D1, R2, Queues or Durable Objects. This application needs none.
- Enable Access only on the route you actually use; keep preview URLs in mind.
- Watch the daily request count in the dashboard for the first week, especially if
  someone leaves a tab open: the UI polls `/api/operations` every 1.2 seconds,
  which is roughly 72,000 requests/day for one idle tab against a 100,000/day
  allowance.
- If you ever approach the ceiling, fix behaviour (close tabs, batch operations),
  not the plan.

## 7. Updating and rolling back

```bash
npx wrangler deploy                 # deploy the current working tree
npx wrangler deployments list       # recent versions
npx wrangler rollback               # return to the previous version
```

Secrets and vars survive a rollback. A redeploy resets the in-memory operation
queue, so do not deploy while someone is waiting on a long move.

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Login page never appears | Access not enabled for the route you opened | Step 4, then confirm you are on the `workers.dev` hostname, not a preview URL |
| UI loads, API returns `401` | No valid Access JWT reached the Worker | Confirm Access is enabled on the same route; check the `ACCESS_AUD` matches the application hosting that route |
| API returns `503 Authentication is not available` | `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` empty, or JWKS unreachable | Set both vars and redeploy; confirm the team domain is exactly `<team>.cloudflareaccess.com` |
| API returns `503 Object storage is not configured` | AWS secrets missing | Step 3 |
| `403` from S3 in an operation error | IAM policy too narrow, wrong region, or bucket outside the allow-list | Check the IAM policy and `AWS_REGION` |
| Deployment fails with limits or huge uploads | The `.assetsignore` whitelist was altered or removed | Restore it; verify with the dry run below |
| `Error 1027` | 100,000 requests/day exceeded on Free | Wait for the UTC reset; reduce polling/usage |
| Operations vanish | Non-durable module-local queue | Known limitation, not a configuration error |

Before any deploy, you can verify what would be published:

```bash
WRANGLER_LOG=debug npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

The debug log prints an `Ignoring asset:` line for each excluded path. Only
`index.html`, `assets/s3_browser_icon.ico` and `assets/s3_browser_icon.svg` should
remain. If you see anything else, stop and fix
[.assetsignore](../s3-browser/.assetsignore) — that file is the only thing keeping
source, tests and dependencies out of your public assets.

## 9. What is not handled for you

- No uptime monitoring, alerting or log shipping.
- No audit log of who moved what. Cloudflare logs requests; S3 server access logs
  and CloudTrail (both off by default) are the way to see object operations.
- No backup or versioning. Deleting a prefix is immediate.
- No per-user authorization. Everyone admitted by the policy can do everything the
  IAM key allows.

See [security](security.md) for the full model and remaining risks.
