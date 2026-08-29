ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --registry=https://registry.npmjs.org/

COPY index.html vite.config.ts ./
COPY tsconfig.base.json tsconfig.node.json tsconfig.web.json tsconfig.build.json ./
COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ENV HOME=/home/node \
    NODE_ENV=production \
    NARRAEON_CONFIG_ROOT=/var/lib/narraeon/config \
    NARRAEON_DATA_ROOT=/var/lib/narraeon/data \
    NARRAEON_HOST=0.0.0.0 \
    NARRAEON_LOG_ROOT=/var/lib/narraeon/log \
    NARRAEON_PORT=4317

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org/ \
    && npm cache clean --force
COPY --from=build --chown=1000:1000 /app/dist ./dist

RUN install -d -o 1000 -g 1000 \
    /var/lib/narraeon/config \
    /var/lib/narraeon/data \
    /var/lib/narraeon/log

USER 1000:1000
VOLUME ["/var/lib/narraeon"]
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "--eval", "const port = process.env.NARRAEON_PORT ?? '4317'; fetch('http://127.0.0.1:' + port + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT ["node", "dist/node/cli/main.js"]
CMD ["web", "--no-open"]
