# Getting started (users)

This is the guide for someone who has been given access to a hosted S3 Browser.
You do not need AWS keys, a Cloudflare account, or anything installed.

If you are the person deploying it, start with
[Cloudflare deployment](cloudflare-deployment.md) instead.

## 1. Open the application

Your admin will give you a URL that looks like:

```
https://s3-browser.<your-subdomain>.workers.dev
```

Open it in a normal browser. You will be redirected to a Cloudflare Access login
page before the application loads. Sign in with the identity your admin
configured (an emailed one-time PIN, or your organisation's identity provider).

There is no separate password for S3 Browser. Access issues the session; the
application trusts it.

If the page loads but every operation fails, see
[Troubleshooting](#troubleshooting) below — the two failures look different:

| What you see | Meaning |
| --- | --- |
| A Cloudflare login or "Forbidden" page before the app appears | Access is doing its job; your account is not covered by the policy, or your session expired |
| The app loads, but buckets fail with *Unauthorized* | The Worker did not receive a valid Access token — almost always a deployment/configuration problem for your admin, not something you can fix |
| The app loads, but buckets fail with *Authentication is not available* | The deployment is missing `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` or cannot reach the signing keys; this is an admin fix |

## 2. Understand what you are looking at

- **Left sidebar** — the buckets your deployment can see. A bucket allow-list may
  hide buckets that your AWS account technically has.
- **Breadcrumb bar** — where you are inside the bucket.
- **Table** — folders first, then objects, with name, size and modified date.
- **Operations panel** — copy/move/rename/delete jobs and their progress.

Folders are S3 prefixes, not real directories. A prefix "containing" objects is
only an illusion of shared name segments; that is why an empty folder may
disappear.

## 3. Browse

| Action | How |
| --- | --- |
| Open a folder | Double-click, or select and press `Enter` |
| Go up one level | `Backspace`, or the **Up** button |
| Back / forward through history | The ← and → toolbar buttons (no keyboard shortcut) |
| Refresh the current folder | The **Refresh** button |
| Sort | Click a column header (name, size, date) |
| Filter this folder | Type in the search box, or press `Ctrl+F` (`Cmd+F` on macOS) or `/` |

Filtering and sorting apply to what is currently loaded. Large prefixes load in
pages of 1,000 objects as you scroll; scroll to the end before concluding
something is missing.

## 4. Select objects

| Action | How |
| --- | --- |
| Select one | Click a row |
| Add or remove one | `Ctrl`-click (`Cmd`-click) |
| Select a range | `Shift`-click, or `Shift+↑` / `Shift+↓` |
| Select all loaded | `Ctrl+A` (`Cmd+A`) |
| Move focus without selecting | `↑` / `↓`, `Home`, `End` |

Right-click a row or the empty area for the context menu.

## 5. Download a file

Select the file and press `Enter`, double-click it, or use **Download** in the
context menu. The object opens in a new tab and is streamed through the Worker.

Files are streamed in full. Seeking inside a large audio or video file is not
supported, and very large downloads are limited by your browser and by the time
you keep the tab open.

Folder download is not supported; download the objects you need.

## 6. Copy, move, rename and delete

These are queued operations. The UI returns immediately and reports progress in
the operations panel; a queued operation is not a finished one.

| Action | How | Notes |
| --- | --- | --- |
| Copy | `Ctrl+C`, navigate, then `Ctrl+V` | Or drag rows onto a folder |
| Cut / move | `Ctrl+X`, navigate, then `Ctrl+V` | Implemented as copy-then-delete — see the warning below |
| Drag to move | Drag rows onto a folder or a bucket | Same bucket only for an internal move |
| Rename | Select one item, press `F2` | Prompts for a new name |
| Delete | `Delete`, or the context menu | Asks for confirmation, then deletes |

**Move is copy-then-delete, not atomic.** If a move fails part-way you can end up
with both copies or with some objects moved and others not. Read the operation's
error and result before assuming it completed. Retry a failed operation from the
operations panel rather than repeating the whole action.

Deleting a folder prefix deletes the object keys under it. There is no recycle
bin and no versioning UI; recovery depends entirely on your bucket's AWS
configuration.

## 7. Watch operations

The operations panel polls while the page is open. Each operation shows queued,
running, completed, failed or cancelled, with progress and any error.

- **Retry** is available only for failed operations.
- **Cancel** sets a flag that the running operation checks between objects. Work
  already done is not rolled back: a cancelled move may have moved some objects.

Close the tab when you are finished. An idle open tab keeps polling the Worker,
which consumes your deployment's daily free request allowance
([costs and limits](costs-and-limits.md)).

## 8. Limits you should expect in hosted mode

- **This is not a full local-file manager.** Dropping files from your computer
  into the browser does not upload them in the hosted variant. The Worker rejects
  that operation because it cannot read your filesystem.
- **Long operations can fail part-way.** A single queued operation runs inside one
  Worker invocation, which has a subrequest budget. Copying or moving more than
  roughly 25 objects, or deleting more than roughly 50, in one go can hit that
  ceiling. Split large jobs into batches.
- **History is not durable.** If the Worker restarts between requests, the
  operations list resets. Do not rely on it as an audit log.
- **Everyone admitted by the Access policy shares the same S3 permissions.** There
  are no per-user roles inside the app.

## Troubleshooting

| Symptom | Likely cause | Who can fix it |
| --- | --- | --- |
| Login loop, or "Forbidden" | Email/identity not in the Access policy | Admin |
| `401 Unauthorized` on every API call, app UI still loads | No valid `Cf-Access-Jwt-Assertion` reached the Worker — the Access application is not attached to the route you are using, or the Worker is being reached by another route | Admin |
| `503 Authentication is not available` | `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` missing, or the JWKS endpoint is unreachable from the Worker | Admin |
| `503 Object storage is not configured` | AWS secrets are missing on the Worker | Admin |
| `400 Invalid operation type: syncLocalToS3` | You dropped local files; unsupported in hosted mode | Nobody — use the local/desktop app |
| Operations fail with AWS permission errors | The deployment's IAM key lacks the action, or the bucket is outside the allow-list | Admin |
| Operations are lost after a while | Non-durable, module-local queue | Known limitation |

When reporting a problem, say which of these messages you saw. That distinction
("the app did not load" vs "the app loaded and the API refused") is the fastest
way to route it.
