import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import { performance } from "node:perf_hooks";

const [command, dataRoot, worldIdOrRounds, headOrWorkload, rounds, workload] =
  process.argv.slice(2);

if (command === "seed") {
  const { buildFixture } = await import("./fixture.mjs");
  const result = await buildFixture(
    dataRoot,
    Number(worldIdOrRounds),
    headOrWorkload,
  );
  console.log(JSON.stringify(result));
} else {
  const worldId = worldIdOrRounds;
  const head = headOrWorkload;
  const worldPrefix = join(dataRoot, "worlds-file-native", worldId) + sep;
  const readFile = fs.readFile;
  let active;

  fs.readFile = async (path, ...args) => {
    const counts = active;
    if (
      counts === undefined ||
      typeof path !== "string" ||
      !path.startsWith(worldPrefix)
    )
      return readFile(path, ...args);
    const relative = path.slice(worldPrefix.length).split(sep).join("/");
    counts.fileReadAttempts++;
    const contents = await readFile(path, ...args);
    if (/^runtime\/turns\/\d+\.json$/u.test(relative)) counts.turnRecords++;
    if (/^runtime\/play-contexts\/[^/]+\/summaries\//u.test(relative))
      counts.timelineSummaries++;
    if (relative === "runtime/head.json") counts.ledgerHeads++;
    if (relative === "runtime/activity.json") counts.activity++;
    return contents;
  };
  syncBuiltinESMExports();

  async function measure(run) {
    const reads = {
      fileReadAttempts: 0,
      turnRecords: 0,
      timelineSummaries: 0,
      ledgerHeads: 0,
      activity: 0,
    };
    active = reads;
    const started = performance.now();
    try {
      const value = await run();
      return { value, sample: { ms: performance.now() - started, reads } };
    } finally {
      active = undefined;
    }
  }

  async function measureOpen() {
    const { V1Runtime } = await import("../../src/runtime/V1Runtime.ts");
    const initStarted = performance.now();
    const runtime = new V1Runtime({
      dataRoot,
      configRoot: join(dataRoot, "config"),
    });
    await runtime.initialize();
    const initializeMs = performance.now() - initStarted;
    const open = () => runtime.handle({ type: "world.read", worldId });
    const cold = await measure(open);
    const warm = await measure(open);
    const firstPage = warm.value.result.playTimeline;
    for (const {
      value: { result },
    } of [cold, warm]) {
      assert.equal(result.head, head);
      assert.equal(result.playTimeline.items.length, 40);
      assert(result.playTimeline.nextCursor);
      assert.equal(
        result.playerViews.views[0].items[0].value,
        workload === "state" ? Number(rounds) : 0,
      );
    }
    const older = await measure(() =>
      runtime.handle({
        type: "play.timeline.page",
        worldId,
        limit: 40,
        cursor: firstPage.nextCursor,
      }),
    );
    const earlier = older.value.result;
    assert.equal(earlier.items.length, 40);
    assert(earlier.items.at(-1).event.id < firstPage.items[0].event.id);
    return {
      initializeMs,
      cold: cold.sample,
      warm: warm.sample,
      older: older.sample,
    };
  }

  async function measureMaintenance() {
    const { FileNativeWorldStore } =
      await import("../../src/runtime/world/FileNativeWorldStore.ts");
    const worlds = new FileNativeWorldStore(dataRoot);
    // Warm world storage independently. First statistics read has no facts cached.
    assert.equal(await worlds.currentHead(worldId), head);
    const rebuild = await measure(() =>
      worlds.readDocumentMaintenance(worldId, head),
    );
    const warm = await measure(() =>
      worlds.readDocumentMaintenance(worldId, head),
    );
    const facts = rebuild.value["current-situation"];
    assert.deepEqual(rebuild.value, warm.value);
    assert.equal(
      facts.lastBodyWrite.round,
      workload === "state" ? Number(rounds) : 0,
    );
    assert.equal(facts.bodyChangedContexts, workload === "state" ? 1 : 0);
    return { rebuild: rebuild.sample, cached: warm.sample };
  }

  assert(["open", "maintenance"].includes(command), "Unknown worker command");
  console.log(
    JSON.stringify(
      await (command === "open" ? measureOpen() : measureMaintenance()),
    ),
  );
}
