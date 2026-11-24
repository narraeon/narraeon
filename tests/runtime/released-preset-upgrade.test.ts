import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  FileNativePlayPresetStore,
  isPlayPresetBinding,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import {
  ScriptedModelHost,
  type ModelHostExchange,
  type ScriptedModelHostStep,
} from "../../src/runtime/model/ModelHost.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";

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
    retryWorldId: string;
    retryRequest: ModelHostExchange;
  };
  const root = await mkdtemp(join(tmpdir(), "released-preset-upgrade-"));
  try {
    for (const [path, contents] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    const config = join(root, "config");
    const presets = new FileNativePlayPresetStore(config);
    await presets.initialize();
    expect(presets.recovery).toBeNull();
    expect(
      await readFile(join(config, "file-native-play-presets.json"), "utf8"),
    ).toBe(fixture.files["config/file-native-play-presets.json"]);
    for (const [path, contents] of Object.entries(fixture.files))
      if (path.startsWith("worlds-file-native/"))
        expect(await readFile(join(root, path), "utf8")).toBe(contents);
    const worlds = new FileNativeWorldStore(root);
    expect(await worlds.currentHead(fixture.worldId)).toBe(fixture.head);
    const endpoint = await worlds.recoverEndpoint(fixture.worldId);
    expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
      "门外传来三声短促的铃响。\n",
      "Released player.\n",
      "Released narrative.\n",
    ]);
    expect(
      endpoint.history.every((message) => message.background === undefined),
    ).toBe(true);
    expect(
      (await worlds.bindPlayCallChain(fixture.worldId)).historyBackgrounds,
    ).toEqual({});
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
    const old = await presets.readRevision(
      fixture.presetId,
      fixture.presetRevision,
    );
    const library = await presets.list();
    const preset = library.presets.find(({ id }) => id === fixture.presetId)!;
    const current = await presets.bindCurrent();
    expect(current.definition.format).toBe("narraeon.orchestration/v1");
    expect(current.revision).not.toBe(fixture.presetRevision);
    expect(isPlayPresetBinding(current)).toBe(true);
    expect(isPlayPresetBinding(old)).toBe(true);
    expect(current.definition.followups).toEqual(old.definition.followups);
    expect(current.definition.mounts).toEqual(old.definition.mounts);
    expect(current.definition.followupItems?.slice(0, 2)).toEqual(
      old.definition.followups.map(({ id }) => ({
        id,
        kind: "user",
        enabled: true,
      })),
    );
    expect(
      preset
        .structure!.playPrompts!.filter(
          (item) => item.kind === "builtin" && item.enabled,
        )
        .map(({ id }) => id),
    ).toEqual(["play.mechanics", "play.model-prompt"]);
    expect(
      preset.structure!.playPrompts!.flatMap((item) =>
        item.kind === "world"
          ? ["world"]
          : item.kind === "user" && item.enabled
            ? [item.name]
            : [],
      ),
    ).toEqual([
      "General narrative presentation",
      "General player-agency and adjudication boundaries",
      "General state-maintenance criteria",
      "world",
      "Player-visible narrative rules",
    ]);
    expect(preset.structure!.playPrompts).toContainEqual(
      expect.objectContaining({
        kind: "user",
        enabled: false,
        body: "# Disabled old original\n\nPreserve **every** word & punctuation.\n",
      }),
    );
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
      path.includes(`/${fixture.worldId}/runtime/play-requests/`),
    );
    expect(savedRequests).toHaveLength(2);
    // The context keeps only its latest request, byte for byte, in its own directory.
    const latestDigest = createHash("sha256")
      .update(JSON.stringify(fixture.requests[1]))
      .digest("hex");
    const contextsRoot = join(
      root,
      "worlds-file-native",
      fixture.worldId,
      "runtime",
      "play-contexts",
    );
    const [contextDirectory] = await readdir(contextsRoot);
    expect(
      await readFile(
        join(
          contextsRoot,
          contextDirectory!,
          "requests",
          `${latestDigest}.json`,
        ),
        "utf8",
      ),
    ).toBe(
      savedRequests.find(([path]) =>
        path.endsWith(`/${latestDigest}.json`),
      )![1],
    );
    expect(
      await readdir(join(contextsRoot, contextDirectory!, "requests")),
    ).toEqual([`${latestDigest}.json`]);
    await expect(
      readdir(
        join(
          root,
          "worlds-file-native",
          fixture.worldId,
          "runtime",
          "play-requests",
        ),
      ),
    ).rejects.toThrow();

    const chains = new PlayCallChain(worlds, undefined, artifacts);
    const historical = await chains.inspectWorld(fixture.worldId);
    expect(historical?.status).toBe("ready");
    const oldFollowup = historical!.events.find(
      ({ kind }) => kind === "followup",
    )!;
    await expect(
      worlds.playTimeline.readDetail(
        fixture.worldId,
        historical!.chainId,
        oldFollowup.id,
      ),
    ).resolves.toMatchObject({ kind: "followup", followupId: "status" });

    const followups: ScriptedModelHostStep[] = [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "status-panel",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 8 } },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "options-panel",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "Continue" } },
          },
        ],
      },
    ];
    const modelBinding = contexts[0]!.modelBinding!;
    const continuing = new ScriptedModelHost({
      binding: modelBinding,
      steps: [
        {
          outcome: "response",
          text: "Continued with the migrated orchestration.",
        },
        ...followups,
      ],
    });
    await expect(
      chains.append({
        worldId: fixture.worldId,
        chainId: historical!.chainId,
        exchangeId: "continue-after-orchestration-migration",
        playerText: "Open the door.",
        modelHost: continuing,
        resolvePrompt: () =>
          Promise.resolve({
            playPreset: current,
            hostBinding: presetHostBinding(current),
          }),
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(
      (await worlds.recoverEndpoint(fixture.worldId)).history.at(-1)?.exactText,
    ).toBe("Continued with the migrated orchestration.");

    const interrupted = await chains.inspectWorld(fixture.retryWorldId);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      canRetry: true,
    });
    const retry = new ScriptedModelHost({
      binding: modelBinding,
      steps: [
        { outcome: "response", text: "Released request retried." },
        ...followups,
      ],
    });
    await expect(
      chains.append({
        worldId: fixture.retryWorldId,
        chainId: interrupted!.chainId,
        exchangeId: "retry-after-orchestration-migration",
        playerText: "",
        modelHost: retry,
        resolvePrompt: () =>
          Promise.reject(
            new Error("An exact retry must use the frozen request"),
          ),
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(retry.requests[0]).toEqual(fixture.retryRequest);
    expect(
      (await worlds.recoverEndpoint(fixture.retryWorldId)).history.map(
        ({ exactText }) => exactText,
      ),
    ).toEqual([
      "门外传来三声短促的铃响。\n",
      "Retry the released player input.\n",
      "Released request retried.",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
