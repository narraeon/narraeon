import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyRelease } from "./check-release.mjs";

const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8",
);
const dockerfile = await readFile(
  new URL("../Dockerfile", import.meta.url),
  "utf8",
);
const dockerIgnore = await readFile(
  new URL("../.dockerignore", import.meta.url),
  "utf8",
);

const manifest = {
  name: "narraeon",
  version: "0.1.0",
  exports: {},
  bin: { narraeon: "dist/node/cli/main.js" },
  files: ["dist"],
  repository: {
    type: "git",
    url: "git+https://github.com/narraeon/narraeon.git",
  },
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
  },
  engines: { node: ">=24.12.0" },
};

test("accepts a stable release and selects latest", () => {
  assert.deepEqual(
    verifyRelease({
      manifest,
      releaseTag: "v0.1.0",
      releaseIsPrerelease: false,
    }),
    { distTag: "latest", name: "narraeon", version: "0.1.0" },
  );
});

test("accepts a prerelease and selects next", () => {
  const prereleaseManifest = { ...manifest, version: "0.2.0-rc.1" };
  assert.deepEqual(
    verifyRelease({
      manifest: prereleaseManifest,
      releaseTag: "v0.2.0-rc.1",
      releaseIsPrerelease: true,
    }),
    { distTag: "next", name: "narraeon", version: "0.2.0-rc.1" },
  );
});

test("rejects a release tag that does not match package.json", () => {
  assert.throws(
    () =>
      verifyRelease({
        manifest,
        releaseTag: "v0.2.0",
        releaseIsPrerelease: false,
      }),
    /does not match v0\.1\.0/u,
  );
});

test("rejects GitHub prerelease metadata that disagrees with SemVer", () => {
  assert.throws(
    () =>
      verifyRelease({
        manifest,
        releaseTag: "v0.1.0",
        releaseIsPrerelease: true,
      }),
    /is stable and must not be marked/u,
  );
});

test("rejects invalid SemVer and publish configuration drift", () => {
  assert.throws(
    () =>
      verifyRelease({
        manifest: { ...manifest, version: "0.1.0+build.1" },
        releaseTag: "v0.1.0+build.1",
        releaseIsPrerelease: false,
      }),
    /exact container tag without build metadata/u,
  );
  assert.throws(
    () =>
      verifyRelease({
        manifest: { ...manifest, version: "0.1.0-01" },
        releaseTag: "v0.1.0-01",
        releaseIsPrerelease: true,
      }),
    /not valid SemVer/u,
  );
  assert.throws(
    () =>
      verifyRelease({
        manifest: {
          ...manifest,
          publishConfig: {
            ...manifest.publishConfig,
            registry: "https://example.test/",
          },
        },
        releaseTag: "v0.1.0",
        releaseIsPrerelease: false,
      }),
    /publishConfig\.registry/u,
  );
  assert.throws(
    () =>
      verifyRelease({
        manifest: {
          ...manifest,
          exports: { ".": "./dist/node/cli/main.js" },
        },
        releaseTag: "v0.1.0",
        releaseIsPrerelease: false,
      }),
    /exports must be an empty object/u,
  );
});

test("passes release tarballs to npm as explicit filesystem paths", () => {
  const tarballGlobs = [
    ...publishWorkflow.matchAll(/^\s*packages=\((?<specifier>[^)]+)\)\s*$/gmu),
  ].map((match) => match.groups?.specifier);

  assert.equal(
    tarballGlobs.length,
    2,
    "validate and publish must each select exactly one tarball",
  );
  for (const tarballGlob of tarballGlobs) {
    assert.match(
      tarballGlob ?? "",
      /^(?:\.\.?\/|\/|"\$(?:GITHUB_WORKSPACE|PWD)"\/)/u,
      "npm publish requires an explicit local path, not an owner/repository-like specifier",
    );
  }
});

test("keeps npm publishing on the token-free OIDC path", () => {
  assert.doesNotMatch(
    publishWorkflow,
    /NPM_BOOTSTRAP_TOKEN|NODE_AUTH_TOKEN|_authToken/u,
    "the post-bootstrap workflow must not retain an npm write-token path",
  );
  assert.equal(
    publishWorkflow.match(/^\s+id-token:\s+write\s*$/gmu)?.length,
    1,
    "only the publish job should be allowed to mint an OIDC identity token",
  );
});

test("validates the runnable container before publishing either artifact", () => {
  assert.match(
    publishWorkflow,
    /^\s+- name: Build and test the release container\n\s+run: npm run test:container$/mu,
  );
  assert.ok(
    publishWorkflow.indexOf("npm run test:container") <
      publishWorkflow.indexOf("  publish:\n"),
    "the container smoke test must remain in the shared validate job",
  );
});

test("publishes a least-privilege multi-platform image after npm succeeds", () => {
  const jobStart = publishWorkflow.indexOf("  publish-container:\n");
  assert.notEqual(
    jobStart,
    -1,
    "the release workflow must publish a container",
  );
  const containerJob = publishWorkflow.slice(jobStart);

  assert.match(containerJob, /^\s+needs: \[validate, publish\]$/mu);
  assert.match(containerJob, /^\s+contents: read$/mu);
  assert.match(containerJob, /^\s+packages: write$/mu);
  assert.doesNotMatch(containerJob, /^\s+id-token: write$/mu);
  assert.match(containerJob, /^\s+platforms: linux\/amd64,linux\/arm64$/mu);
  assert.match(containerJob, /^\s+registry: ghcr\.io$/mu);
  assert.match(
    containerJob,
    /^\s+password: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/mu,
  );
  assert.doesNotMatch(containerJob, /GHCR_TOKEN|CR_PAT/u);
  assert.ok(containerJob.includes("images: ghcr.io/${{ github.repository }}"));
  assert.ok(
    containerJob.includes(
      "org.opencontainers.image.source=https://github.com/${{ github.repository }}",
    ),
  );
  assert.ok(
    containerJob.includes(
      "type=raw,value=${{ needs.validate.outputs.package_version }},priority=1000",
    ),
  );
  assert.ok(
    containerJob.includes(
      "type=raw,value=latest,enable=${{ github.event.release.prerelease == false }}",
    ),
  );
  assert.ok(
    containerJob.includes(
      "type=raw,value=next,enable=${{ github.event.release.prerelease == true }}",
    ),
  );
  assert.match(containerJob, /^\s+provenance: mode=max$/mu);
  assert.match(containerJob, /^\s+sbom: true$/mu);

  for (const action of [
    "docker/login-action@dbcb813823bdd20940b903addbd779551569679f",
    "docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302",
    "docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8",
    "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e",
    "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
  ])
    assert.ok(
      containerJob.includes(action),
      `${action} must remain SHA-pinned`,
    );
});

test("builds a pinned non-root runtime with one durable volume", () => {
  assert.match(
    dockerfile,
    /^ARG NODE_IMAGE=node:24\.20\.0-bookworm-slim@sha256:[a-f0-9]{64}$/mu,
  );
  assert.equal(
    dockerfile.match(/^FROM \$\{NODE_IMAGE\}/gmu)?.length,
    2,
    "build and runtime stages must share the pinned multi-platform base",
  );
  assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\} AS runtime$/mu);
  assert.match(dockerfile, /^USER 1000:1000$/mu);
  assert.match(dockerfile, /^VOLUME \["\/var\/lib\/narraeon"\]$/mu);
  assert.match(dockerfile, /^\s+NARRAEON_HOST=0\.0\.0\.0 \\$/mu);
  assert.match(dockerfile, /^\s+NARRAEON_PORT=4317$/mu);
  assert.match(dockerfile, /^HEALTHCHECK /mu);
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["node", "dist\/node\/cli\/main\.js"\]$/mu,
  );
  assert.match(dockerfile, /^CMD \["web", "--no-open"\]$/mu);

  for (const ignored of [
    ".git",
    ".env",
    ".env.*",
    "dist",
    "node_modules",
    "*.tgz",
  ])
    assert.ok(
      dockerIgnore.split("\n").includes(ignored),
      `.dockerignore must exclude ${ignored}`,
    );
});
