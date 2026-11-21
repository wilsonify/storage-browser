# Costs and limits

The design goal is simple: **Cloudflare hosting costs $0 within documented free
allowances; AWS S3 is the only expected bill.**

Figures below were checked against Cloudflare's documentation in November 2026.
Providers change limits; confirm against the linked page before making a
money-sensitive decision.

## Cost breakdown

| Component | Expected cost |
| --- | --- |
| Cloudflare static UI | **$0** — requests to static assets are free and unlimited, and asset storage is not charged |
| Cloudflare Worker | **$0** within the free allowances (100,000 requests/day, 10 ms CPU per invocation) |
| Cloudflare Access | **$0** on the Zero Trust Free plan for teams under 50 users |
| Cloudflare Workers Logs | $0 within the free allowance; see the pricing note below |
| AWS S3 storage | Paid — normal S3 rates |
| AWS S3 requests | Paid — per-request rates, including requests the Worker makes |
| AWS data transfer out of S3 | Paid by AWS pricing; Cloudflare does not charge egress |
| Database, queue, KV, R2, Durable Objects | **$0 — not used** |

Sources:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Static assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Observability pricing (from 1 December 2026)](https://developers.cloudflare.com/observability/pricing/)
- [Zero Trust / Access plans](https://www.cloudflare.com/sase/products/access)

## Free allowances (Workers Free)

| Limit | Free plan | What it means here |
| --- | --- | --- |
| Requests | 100,000/day, reset at midnight UTC | Only `/api/*` requests count; static UI is separate |
| CPU time | 10 ms per request | Waiting on S3 does not count; SigV4 signing and XML parsing do |
| Subrequests | 50 per invocation | Bounds how many objects one queued operation can touch |
| Memory | 128 MB per isolate | Not a practical constraint for this app |
| Worker script size | 64 MiB uncompressed | Bundle is ~686 KiB raw / ~132 KiB gzip |
| Static asset files | 20,000 per version, 25 MiB each | This app publishes 3 files |
| Workers per account | 100 | — |
| Log events | 200,000/day, 3 days retention | Until 1 December 2026 |

### Important: the free plan fails, it does not bill

On Workers Free, exceeding an allowance produces an error rather than a charge:

- More than 100,000 requests in a UTC day → **Error 1027**.
- Sustained CPU over 10 ms per request → the invocation is terminated.

There is no automatic upgrade and no overage invoice. Money appears only when you
choose a paid plan or product.

## Request and subrequest budgets

**Requests.** The UI polls `GET /api/operations` every 1.2 seconds while a tab is
open:

```
1 request / 1.2 s = 3,000 requests/hour ≈ 72,000 requests/day
```

That single idle tab consumes most of the 100,000/day allowance. Two idle tabs
will exhaust it. Practical guidance:

- Close the tab when you are done.
- Browsing costs little: one request per 1,000 keys listed, one per download.
- A daily session of normal use is a few thousand requests, not tens of thousands.

**Subrequests.** Each S3 call is one subrequest from the Worker invocation.

| Operation | Subrequests per object | Practical ceiling (50 budget) |
| --- | --- | --- |
| Download | 2 (`HeadObject` + `GetObject`) | One object per request |
| Copy | 1 (`CopyObject`) | ~50 objects |
| Move | 2 (copy + delete) | ~25 objects |
| Rename | 2 (copy + delete) | One object |
| Delete | 1 (`DeleteObjects`) | ~50 objects |

A single queued operation runs inside one invocation, so a bulk move of 100
objects will fail part-way. Batch large jobs. Failures are reported per operation;
they are not silent, but they are also not rolled back.

The auth layer adds an occasional subrequest for the Access signing keys — cached
for five minutes, not per request.

**CPU.** 10 ms per invocation is the risk worth watching. The AWS SDK signs each
request and parses XML; a 1,000-key listing is the heaviest single request. Normal
usage sits well under the limit. If you ever see sustained CPU terminations, the
documented fallback is a smaller SigV4 signer instead of the full SDK — that is
future work, not implemented.

## Workers Logs pricing note

Until 30 November 2026, Workers Logs includes 200,000 log events/day on the Free
plan with 3-day retention. From **1 December 2026**, Workers Logs moves to
Cloudflare's unified Observability pricing: the Free plan includes **0.5 GB of
ingestion per day with 7-day retention and no overage purchase** — ingestion stops
at the allowance instead of billing.

`observability.enabled: true` stays in `wrangler.jsonc` because the Worker logs one
line on unexpected errors. That is far below either allowance, and on the Free plan
it cannot generate a charge.

## Cloudflare Access

Access is part of the Zero Trust platform. The Free plan is $0 and is aimed at
teams under 50 users; larger deployments move to per-user pricing (roughly
$7/user/month on pay-as-you-go). For a personal or small-team S3 console, this is
inside the free tier.

Access brings its own limits (session duration, policy rules, log retention of
about 24 hours on Free). Those are configuration constraints rather than billing
ones.

## What could still cost money

1. **A Workers Paid subscription** ($5/month minimum). Not required and not
   configured by this project. If you enable it, requests, CPU and logs start
   billing past their included usage.
2. **More than 50 Access users**, which moves the Zero Trust account to a paid
   plan.
3. **AWS S3** storage, requests, and data transfer out of AWS. Also any other AWS
   feature you enable: versioning storage, S3 server access logs, CloudTrail data
   events.
4. **Custom domains** are not required and are not used. (Cloudflare zone hosting
   is free, but avoid introducing a second moving part.)
5. **A larger Worker** if you add heavy dependencies: the size limit is 64 MiB
   uncompressed, and the 10 ms CPU ceiling bites long before that.

## Cost-control checklist

- [ ] Account is on **Workers Free**; no payment method attached for Workers
- [ ] No KV, D1, R2, Queues or Durable Objects created for this project
- [ ] Access is the only Zero Trust feature enabled; user count under 50
- [ ] `observability.enabled` left at default; no high-volume logging added
- [ ] Tabs are closed after use (the 1.2 s poll is the biggest request consumer)
- [ ] Bulk moves/copies/deletes are batched to stay under subrequest limits
- [ ] AWS IAM key is scoped to the buckets you meant to expose, so accidental AWS
      spend is bounded too

## Estimating your own usage

Rough daily request count:

```
requests/day ≈ (minutes with a tab open × 50) + (folders browsed × pages) + downloads
```

A one-hour session with a tab open is about 3,000 poll requests plus a few dozen
real ones. That is comfortably free; leaving a tab open around the clock is what
gets near the ceiling.

Check actual usage in the Cloudflare dashboard under the Worker's metrics (requests
and CPU time per day).
