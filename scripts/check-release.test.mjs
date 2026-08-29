import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyRelease } from "./check-release.mjs";

const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
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
