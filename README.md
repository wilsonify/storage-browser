# S3 Browser

A native HTML S3 file browser with a small local Node backend. No frontend
framework, no bundler, no transpiler — the UI is a single `index.html` with
vanilla HTML, CSS, and browser JavaScript.

## Features

- Browse buckets and folder prefixes with breadcrumb navigation
- Object listing with sizes, timestamps, sorting, filtering, and infinite scroll
- Multi-select with keyboard navigation, context menu, and copy/cut/paste
- Upload via drag-and-drop, download, rename, and delete with confirmation
- Background operation queue (copy, move, delete, rename, local folder sync)
  with progress, retry, and cancel
- AWS credentials stay server-side (environment variables or the local shared
  AWS profile) and are never exposed to the browser

## Repository layout

```
├── s3-browser/           # The application
│   ├── index.html        # Single-file vanilla HTML/CSS/JS UI
│   ├── server.mjs        # Local Node HTTP server + REST API
│   ├── s3-ops.mjs        # S3 operations layer (AWS SDK v3)
│   ├── operations-*.mjs  # Persistent background operation queue
│   ├── cloudflare/       # Cloudflare Workers deployment variant
│   ├── src-tauri/        # Tauri desktop shell
│   └── test/             # node:test suites
├── helm/                 # Helm chart for deploying to a local k3s cluster
└── Dockerfile            # Container image for the Node backend
```

See [s3-browser/README.md](s3-browser/README.md) for local development, the
Windows single-file distribution, and the Cloudflare Workers variant.

## Run locally

```bash
cd s3-browser
npm install
npm start                 # http://127.0.0.1:3737
```

Credentials default to the local shared AWS profile `personal`. Override with
`AWS_PROFILE`, standard AWS environment variables, or `AWS_REGION` /
`S3_ENDPOINT` (for S3-compatible stores such as MinIO).

## Deploy to k3s with Helm

Build the image and load it into k3s:

```bash
docker build -t s3-browser:latest .
k3s ctr images import -   # pipe the image in, or use nerdctl/ctr as appropriate
# e.g.: docker save s3-browser:latest | k3s ctr images import -
```

Install the chart:

```bash
helm upgrade --install s3-browser ./helm \
  --set aws.accessKeyId=AKIA... \
  --set aws.secretAccessKey=... \
  --set aws.region=us-east-1
```

Then open the app:

```bash
kubectl port-forward svc/s3-browser-s3-browser 3737:3737
# http://127.0.0.1:3737
```

Useful values (see [helm/values.yaml](helm/values.yaml)):

| Value | Purpose |
| --- | --- |
| `aws.existingSecret` | Reuse a pre-created Secret (keys `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) |
| `aws.endpoint` | Point at an S3-compatible endpoint such as MinIO |
| `persistence.enabled` | Persist the operation queue on a PVC (default `true`) |
| `persistence.size` | PVC size (default `1Gi`) |

## Security notes

- The backend never ships AWS credentials to the browser; the UI only talks to
  the local REST API.
- The Helm chart mounts credentials from a Kubernetes Secret and runs the
  container as a non-root user (`uid 1000`).
