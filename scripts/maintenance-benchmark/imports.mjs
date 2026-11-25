import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import { post } from "./common.mjs";
import { archiveSizes, buildArchives } from "./fixtures.mjs";

const worker = new URL("./import-worker.mjs", import.meta.url);

async function runWorker({
  layer,
  size,
  temperature,
  mode,
  fixtureRoot,
  root,
  treeFingerprint,
}) {
  // Keep client serialization and the outgoing buffer out of server RSS.
  const body =
    layer === "api" && mode === "import"
      ? await readFile(join(fixtureRoot, `${size}.rpc.json`))
      : null;
  const warmup =
    layer === "api" && temperature === "warm"
      ? await readFile(join(fixtureRoot, "small.rpc.json"))
      : null;
  const child = fork(
    worker,
    [layer, size, temperature, mode, fixtureRoot, root, treeFingerprint],
    {
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const timeout = setTimeout(() => child.kill(), 75_000);
  try {
    return await new Promise((resolve, reject) => {
      let measurement;
      let rpcResult;
      child.on("message", (message) => {
        if (message.measurement) {
          measurement = message.measurement;
          return;
        }
        const measured = message.step === "measure";
        void post(message.url, measured ? body : warmup, {
          allowFailure: measured,
        })
          .then(({ bytes, elapsedMs, status }) => {
            const receipt = JSON.parse(bytes);
            assert.equal(
              status,
              200,
              `${size} content.import: ${receipt.error?.message ?? receipt.message}`,
            );
            assert.equal(receipt.result.status, "usable");
            if (measured) {
              assert.equal(
                contentTreeFingerprint(receipt.result.files),
                treeFingerprint,
              );
              rpcResult = {
                elapsedMs,
                responseBytes: bytes.byteLength,
                httpStatus: status,
              };
            }
            child.send({ consumed: true });
          })
          .catch(reject);
      });
      child.on("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0 && measurement)
          resolve({ ...measurement, ...rpcResult });
        else
          reject(
            new Error(
              `Import worker: ${layer}/${size}/${temperature}/${mode} exited with ${code ?? signal}`,
            ),
          );
      });
    });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }
    await rm(root, { recursive: true, force: true });
  }
}

export async function measureImports(root, repeats) {
  const fixtureRoot = join(root, "archives");
  const workloads = await buildArchives(fixtureRoot);
  const samples = [];
  for (const layer of ["api", "workspace"]) {
    for (const temperature of ["cold", "warm"]) {
      console.error(`import ${layer}/${temperature}, ${repeats} repeats`);
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const sizes = repeat % 2 ? archiveSizes : [...archiveSizes].reverse();
        const idle = {};
        for (const size of sizes) {
          const run = (mode) =>
            runWorker({
              layer,
              size,
              temperature,
              mode,
              fixtureRoot,
              root: join(root, "isolated-runtime"),
              treeFingerprint: workloads[size].treeFingerprint,
            });
          const idleSize = layer === "api" ? "shared" : size;
          idle[idleSize] ??= await run("idle");
          const work = await run("import");
          assert.equal(idle[idleSize].publishedPackages, 0);
          assert.equal(work.publishedPackages, 1);
          samples.push({
            layer,
            temperature,
            size,
            repeat,
            elapsedMs: work.elapsedMs,
            responseBytes: work.responseBytes ?? null,
            httpStatus: work.httpStatus ?? null,
            failure: null,
            publishedPackages: work.publishedPackages,
            baseline: idle[idleSize],
            workload: { before: work.before, after: work.after },
            peakAboveIdleBytes:
              work.after.processPeakRssBytes -
              idle[idleSize].after.processPeakRssBytes,
            peakRiseInWorkerBytes:
              work.after.processPeakRssBytes - work.before.processPeakRssBytes,
          });
        }
      }
    }
  }
  return { workloads, samples };
}
