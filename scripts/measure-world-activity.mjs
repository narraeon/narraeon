import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { minimalFileNativeContentScaffold } from "../src/runtime/content/ContentWorkspace.ts";
import { createMinimalFileNativePreviewInput } from "../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldStore } from "../src/runtime/world/FileNativeWorldStore.ts";
import { V1Runtime } from "../src/runtime/V1Runtime.ts";

// node scripts/measure-world-activity.mjs /absolute/path/to/baseline-checkout
// Both runtimes read the same 100 real worlds, with no Provider calls.
const baselineRoot = process.argv[2];
if (baselineRoot === undefined)
  throw new Error("Pass a baseline checkout with its dependencies installed");
const { V1Runtime: BaselineRuntime } = await import(
  pathToFileURL(join(resolve(baselineRoot), "src/runtime/V1Runtime.ts")).href
);
const root = await mkdtemp(join(tmpdir(), "narraeon-activity-benchmark-"));
try {
  const store = new FileNativeWorldStore(root);
  const prompt = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "benchmark-no-provider",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    playerInput: "preview",
    playerInputPlacement: "append",
  });
  const packageFiles = minimalFileNativeContentScaffold("en");
  for (let index = 0; index < 100; index++)
    await store.createFromContentPackage({
      operationId: `benchmark-${index}`,
      sourcePackageId: "benchmark-package",
      sourcePackageTitle: `World ${String(index).padStart(3, "0")}`,
      packageFiles,
      prompt,
    });
  const options = { dataRoot: root, configRoot: join(root, "config") };
  const before = new BaselineRuntime(options);
  await before.initialize();
  const after = new V1Runtime(options);
  await after.initialize();
  const timings = { before: [], after: [] };
  for (let round = 0; round < 33; round++) {
    // Alternate order to reduce cache/order bias; omit three warm-up rounds.
    const order = round % 2 === 0 ? ["before", "after"] : ["after", "before"];
    for (const label of order) {
      const runtime = label === "before" ? before : after;
      const start = performance.now();
      const response = await runtime.handle({ type: "workspace.read" });
      const elapsed = performance.now() - start;
      if (response.result.worlds.length !== 100)
        throw new Error("Expected exactly 100 worlds");
      if (round >= 3) timings[label].push(elapsed);
    }
  }
  const summarize = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      samples: sorted.length,
      medianMs: Number(((sorted[14] + sorted[15]) / 2).toFixed(2)),
      p95Ms: Number(sorted[28].toFixed(2)),
      minMs: Number(sorted[0].toFixed(2)),
      maxMs: Number(sorted.at(-1).toFixed(2)),
    };
  };
  console.log(
    JSON.stringify(
      {
        worlds: 100,
        historyPerWorld: "one committed opening",
        cache: "valid, warm filesystem cache",
        node: process.version,
        baseline: resolve(baselineRoot),
        before: summarize(timings.before),
        after: summarize(timings.after),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
