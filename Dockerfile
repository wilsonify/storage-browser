FROM node:22-alpine

WORKDIR /app

COPY s3-browser/package.json s3-browser/package-lock.json ./
RUN npm ci --omit=dev

COPY s3-browser/index.html s3-browser/server.mjs s3-browser/s3-ops.mjs s3-browser/operations-store.mjs s3-browser/operations-worker.mjs ./
COPY s3-browser/assets ./assets

ENV S3_BROWSER_HOST=0.0.0.0 \
    S3_BROWSER_NO_OPEN=1

USER node

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3737/ >/dev/null || exit 1

CMD ["node", "server.mjs"]
