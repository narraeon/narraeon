import assert from "node:assert/strict";
import test from "node:test";

import { verifyRelease } from "./check-release.mjs";

const manifest = {
  name: "narraeon",
  version: "0.1.0",
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
});
