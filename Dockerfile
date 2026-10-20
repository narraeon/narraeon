ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# The image does not build from source. It installs the validated npm tarball
# (the same file published to the registry) from the `package` build context:
#   docker build --build-context package=<dir with narraeon-*.tgz> .
# The package has no native dependencies, so it is installed once on the build
# platform and copied into each target platform's runtime stage.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS install

RUN --mount=type=bind,from=package,target=/package \
    npm install --global --ignore-scripts --no-audit --no-fund \
      --registry=https://registry.npmjs.org/ /package/narraeon-*.tgz \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ENV HOME=/home/node \
    NODE_ENV=production \
    NARRAEON_CONFIG_ROOT=/var/lib/narraeon/config \
    NARRAEON_DATA_ROOT=/var/lib/narraeon/data \
    NARRAEON_HOST=0.0.0.0 \
    NARRAEON_LOG_ROOT=/var/lib/narraeon/log \
    NARRAEON_PORT=4317

COPY --from=install --chown=1000:1000 /usr/local/lib/node_modules/narraeon /app
WORKDIR /app

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
