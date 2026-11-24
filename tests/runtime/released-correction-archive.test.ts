import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { archiveStores } from "../support/worldArchiveFixture.ts";

test("发布版归档导入后保留旧修正轮、两个端点、故事与冻结调用详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-released-correction-"));
  try {
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    await runtime.initialize();
    const archive = new URL(
      "./fixtures/correction-v0.9.0-preview.3/archive.zip",
      import.meta.url,
    );
    const upload = await runtime.worldArchives.upload(
      createReadStream(archive),
    );
    const { result } = await runtime.handle({
      type: "world.archive.import",
      operationId: "released-correction-import",
      ...upload,
    });
    const {
      world: { worldId },
    } = result as { world: { worldId: string } };
    expect(typeof worldId).toBe("string");
    const { worlds } = archiveStores(root);
    const { commits } = await worlds.readAuthorityHistory(worldId);
    expect(commits.at(-1)).toMatchObject({
      head: "commit:3",
      mode: "correction",
      corrects: "commit:2",
      correctionTargets: ["situation.current"],
    });
    const before = await worlds.recoverEndpoint(worldId, "commit:2");
    const after = await worlds.recoverEndpoint(worldId, "commit:3");
    expect(before.state[0]?.contents).toContain("Alex守在旅店门边。");
    expect(after.state[0]?.contents).toContain(
      "Alex在旅店门边点亮了一盏蓝灯。",
    );
    expect(after.history).toEqual(before.history);
    expect(after.history.map(({ exactText }) => exactText.trim())).toEqual([
      "门外传来三声短促的铃响。",
      "我推开旅店的大门。",
      "Alex抬起头，向你点头致意。",
    ]);
    const [context] = await worlds.playTimeline.readAllContexts(worldId);
    expect(context?.lastRequest).toBeDefined();
    if (context === undefined) throw new Error("Missing frozen play context");
    const event = context.events.find(({ kind }) => kind === "assistant");
    if (event === undefined) throw new Error("Missing assistant event");
    const frozen = await runtime.handle({
      type: "play.timeline.context",
      worldId,
      chainId: context.chainId,
      eventId: event.id,
    });
    expect(frozen.result).toMatchObject({ status: "available" });
    expect(JSON.stringify(frozen.result)).toContain("我推开旅店的大门。");
    expect(JSON.stringify(frozen.result)).toContain("Alex守在旅店门边。");
    expect(JSON.stringify(frozen.result)).not.toContain("点亮了一盏蓝灯");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
