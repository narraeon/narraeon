import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import { runtimeServer } from "./common.mjs";

const [layer, size, temperature, mode, fixtureRoot, root, expectedFingerprint] =
  process.argv.slice(2);

async function requestClient(url, step) {
  const consumed = once(process, "message");
  process.send({ url, step });
  await consumed;
}

function memory() {
  return {
    rssBytes: process.memoryUsage.rss(),
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function packageCount(root) {
  try {
    return (await readdir(join(root, "data", "content", "packages"))).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

let endpoint;
try {
  const api = layer === "api";
  if (api) endpoint = await runtimeServer(root);
  const workspace = api ? null : new ContentWorkspace(join(root, "data"));
  if (temperature === "warm") {
    if (api) {
      await requestClient(endpoint.url, "warmup");
    } else {
      const zip = await readFile(join(fixtureRoot, "small.zip"));
      const { status } = await workspace.importPortableContentPackageArchive(
        zip,
        { title: "Warm-up" },
      );
      assert.equal(status, "usable");
    }
  }

  const zip = api ? null : await readFile(join(fixtureRoot, `${size}.zip`));
  await setTimeout(50);
  const existingPackages = await packageCount(root);
  const before = memory();
  let elapsedMs = null;
  let after;
  if (mode === "idle") {
    await setTimeout(200);
    after = memory();
  } else if (api) {
    await requestClient(endpoint.url, "measure");
    after = memory();
  } else {
    const started = performance.now();
    const result = await workspace.importPortableContentPackageArchive(zip, {
      title: `Benchmark ${size}`,
    });
    elapsedMs = performance.now() - started;
    after = memory();
    assert.equal(result.status, "usable");
    assert.equal(contentTreeFingerprint(result.files), expectedFingerprint);
  }
  const publishedPackages = (await packageCount(root)) - existingPackages;
  process.send({
    measurement: { before, after, elapsedMs, publishedPackages },
  });
} finally {
  await endpoint?.server.close();
}
