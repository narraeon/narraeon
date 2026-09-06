import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { FileNativePlayPresetStore } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import type { ModelHostExchange } from "../../src/runtime/model/ModelHost.ts";

test("v0.4.0 实际发布代码写出的预设、世界、原生请求与产物可冷升级", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("./fixtures/released-v040/storage.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  ) as {
    worldId: string;
    presetId: string;
    presetRevision: string;
    head: string;
    files: Record<string, string>;
    requests: ModelHostExchange[];
    artifacts: { payload: unknown }[];
  };
  const root = await mkdtemp(join(tmpdir(), "released-preset-upgrade-"));
  try {
    for (const [path, contents] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const worlds = new FileNativeWorldStore(root);
    expect(await worlds.currentHead(fixture.worldId)).toBe(fixture.head);
    const endpoint = await worlds.recoverEndpoint(fixture.worldId);
    expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
      "门外传来三声短促的铃响。\n",
      "Released player.\n",
      "Released narrative.\n",
    ]);
    const contexts = await worlds.playTimeline.readAllContexts(fixture.worldId);
    expect(contexts).toHaveLength(1);
    expect(
      (await worlds.playTimeline.readCurrent(fixture.worldId))!.value
        .lastRequest,
    ).toEqual(fixture.requests[1]);
    expect(contexts[0]!.transcript.slice(0, 3)).toEqual(
      fixture.requests[1]!.appended,
    );
    const artifacts = new FileNativeArtifactStore(root);
    expect(
      (await artifacts.readActiveProjection(fixture.worldId)).map(
        ({ payload }) => payload,
      ),
    ).toEqual(fixture.artifacts.map(({ payload }) => payload));
    const presets = new FileNativePlayPresetStore(join(root, "config"));
    const old = await presets.readRevision(
      fixture.presetId,
      fixture.presetRevision,
    );
    const library = await presets.list();
    const preset = library.presets.find(({ id }) => id === fixture.presetId)!;
    expect(preset.structure!.migrationNotice).toContain("归并");
    expect(preset.structure!.playPrompts).toContainEqual(
      expect.objectContaining({
        kind: "user",
        enabled: false,
        body: "# Disabled old original\n\nPreserve **every** word & punctuation.\n",
      }),
    );
    await presets.save({
      presetId: preset.id,
      name: preset.name,
      files: preset.files,
      structure: preset.structure!,
    });
    await presets.select(preset.id);
    const current = await presets.bindCurrent();
    expect(current.files["renderers/released.html"]).toBe(
      "<p>Released resource</p>",
    );
    expect(
      await presets.readRevision(fixture.presetId, fixture.presetRevision),
    ).toEqual(old);
    expect(
      (
        await new FileNativeWorldStore(root).playTimeline.readAllContexts(
          fixture.worldId,
        )
      )[0]!.transcript,
    ).toEqual(contexts[0]!.transcript);
    const savedRequests = Object.entries(fixture.files).filter(([path]) =>
      path.includes("/runtime/play-requests/"),
    );
    expect(savedRequests).toHaveLength(2);
    for (const [path, exactBytes] of savedRequests)
      expect(await readFile(join(root, path), "utf8")).toBe(exactBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
