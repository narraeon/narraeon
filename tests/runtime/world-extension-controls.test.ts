import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { createMinimalFileNativePreviewInput } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup(extraRequests: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "world-extension-controls-"));
  roots.push(root);
  const options = { dataRoot: root, configRoot: join(root, "config") };
  const runtime = new V1Runtime(options);
  const worlds = new FileNativeWorldStore(root);
  const preview = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "test",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    playerInput: "hello",
    playerInputPlacement: "append",
  });
  const declaration = {
    id: "stable-one",
    displayName: "Same name",
    enabled: false,
    mount: "story",
    prompt: { role: "author_instruction", markdown: "prompts/one.md" },
    artifacts: [
      {
        name: "panel",
        channel: "panel",
        strategy: "replace",
        contentType: "text/markdown",
        save: "commit",
        invalidation: "explicit_clear",
      },
    ],
    maxArtifactBytes: 32768,
  };
  const files = [
    ...minimalFileNativeContentScaffold().map((file) =>
      file.path === "control/player-views.yaml"
        ? {
            ...file,
            contents: stringify({
              format: "narraeon.player-views/v1",
              views: [
                {
                  id: "status",
                  title: "Current fields",
                  items: [
                    {
                      id: "current",
                      label: "Situation",
                      select: { document: "@current-situation" },
                    },
                  ],
                },
              ],
            }),
          }
        : file,
    ),
    {
      path: "control/followups.yaml",
      contents: stringify(
        {
          format: "narraeon.package-followups/v1",
          followups: [
            declaration,
            ...extraRequests.map((id) => ({
              ...declaration,
              id,
              displayName: id,
              enabled: true,
            })),
          ],
        },
        { aliasDuplicateObjects: false },
      ),
    },
    { path: "control/prompts/one.md", contents: "Request one" },
  ];
  const result = await worlds.createFromContentPackage({
    operationId: "create-one",
    sourcePackageId: "source",
    sourcePackageTitle: "World",
    packageFiles: files,
    prompt: {
      hostBinding: preview.hostBinding,
      modelBinding: { ...preview.modelBinding, endpointFingerprint: "fixture" },
    },
  });
  return {
    root,
    options,
    runtime,
    worlds,
    files,
    preview,
    worldId: result.world.worldId,
  };
}

test("Runtime 枚举关闭项，世界覆盖持久且组优先保留子选择，恢复默认不改 Authority", async () => {
  const { runtime, options, worlds, worldId } = await setup();
  const read = async (rt = runtime) =>
    (await rt.handle({ type: "world.extensions.read", worldId })).result as {
      items: {
        key: string;
        kind: string;
        enabled: boolean;
        selected: boolean;
        overridden: boolean;
      }[];
    };
  const before = await worlds.readAuthorityHistory(worldId);
  const first = await read();
  const child = first.items.find((item) => item.key === "package:stable-one")!;
  expect(child).toMatchObject({
    kind: "request",
    enabled: false,
    overridden: false,
  });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: child.key,
    value: "on",
  });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "group:package",
    value: "off",
  });
  expect(
    (await read()).items.find((item) => item.key === child.key),
  ).toMatchObject({ enabled: false, selected: true, overridden: true });
  const cold = new V1Runtime(options);
  await cold.handle({
    type: "world.extensions.set",
    worldId,
    key: "group:package",
    value: "on",
  });
  expect(
    (await read(cold)).items.find((item) => item.key === child.key),
  ).toMatchObject({ enabled: true, selected: true });
  await cold.handle({
    type: "world.extensions.set",
    worldId,
    key: child.key,
    value: "default",
  });
  expect(
    (await read(cold)).items.find((item) => item.key === child.key),
  ).toMatchObject({ enabled: false, overridden: false });
  expect(await worlds.readAuthorityHistory(worldId)).toEqual(before);
});

import {
  FileNativePlayPresetStore,
  presetHostBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import type {
  ModelHost,
  ModelHostResponse,
} from "../../src/runtime/model/ModelHost.ts";

test("关闭在途请求中止独立信号，迟到产物只留诊断；重开不复活，下次正常发送才重新派发", async () => {
  const { root, options, runtime, worlds, worldId } = await setup();
  const preset = await new FileNativePlayPresetStore(
    options.configRoot,
  ).bindCurrent();
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:stable-one",
    value: "on",
  });
  const started = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<ModelHostResponse>();
  const modelBinding = {
    provider: "chat_completions" as const,
    modelId: "test",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    endpointFingerprint: "fixture",
    protocolConfigFingerprint: "fixture",
  };
  const requests: string[] = [];
  let signal: AbortSignal | undefined;
  const host: ModelHost = {
    binding: () => modelBinding,
    async exchange(request, observer) {
      requests.push(request.requestId!);
      if (request.requestId === "package:stable-one") {
        signal = observer?.signal;
        started.resolve();
        return delayed.promise;
      }
      return {
        text: "The story is committed.",
        providerState: {
          protocol: "chat_completions",
          assistantMessage: {
            role: "assistant",
            content: "The story is committed.",
          },
        },
      };
    },
  };
  const artifacts = new FileNativeArtifactStore(root);
  const chain = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );
  const running = chain.start({
    worldId,
    chainId: "chain",
    exchangeId: "one",
    playerText: "go",
    hostBinding: presetHostBinding(preset),
    playPreset: preset,
    modelBinding,
    modelHost: host,
  });
  await Promise.race([
    started.promise,
    running.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  const head = await worlds.currentHead(worldId);
  await worlds.extensionControls(worldId, preset, "en", {
    key: "package:stable-one",
    value: "off",
  });
  expect(signal?.aborted).toBe(true);
  await worlds.extensionControls(worldId, preset, "en", {
    key: "package:stable-one",
    value: "on",
  });
  delayed.resolve({
    toolCalls: [
      {
        id: "late",
        name: "artifact_emit",
        arguments: { output: "panel", payload: "LATE" },
      },
    ],
  });
  expect((await running).status).toBe("ready");
  expect(await worlds.currentHead(worldId)).toBe(head);
  expect(
    (await runtime.handle({ type: "artifacts.read", worldId })).result,
  ).toEqual([]);
  expect(
    (await runtime.handle({ type: "artifacts.debug", worldId })).result,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ payload: "LATE" })]),
  );
  expect(requests.filter((id) => id === "package:stable-one")).toHaveLength(1);
  await chain.append({
    worldId,
    chainId: "chain",
    exchangeId: "two",
    playerText: "continue",
    modelHost: host,
    resolvePrompt: () =>
      Promise.resolve({
        hostBinding: presetHostBinding(preset),
        playPreset: preset,
      }),
  });
  expect(requests.filter((id) => id === "package:stable-one")).toHaveLength(2);
  expect(
    (await new V1Runtime(options).handle({ type: "artifacts.read", worldId }))
      .result,
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ payload: "LATE" })]),
  );
});

import type { WorldExtensionsView } from "../../src/protocol/worldExtensions.ts";
import type { FrontendPlayerViewPanelProjection } from "../../src/runtime/extension/PlayerViewPanelProjector.ts";
import type { RenderedPlayerView } from "../../src/protocol/playerViews.ts";

test("纯界面关闭抑制 fallback，重开读取当前字段；同端点通知、重启及 fork 偏好独立且零模型请求", async () => {
  const { runtime, options, worlds, worldId } = await setup();
  const store = new FileNativePlayPresetStore(options.configRoot);
  const preset = await store.bindCurrent();
  const files = { ...preset.files };
  const manifest = parse(files["preset.yaml"]!) as Record<string, unknown>;
  manifest.playerViewPanels = [
    {
      id: "current",
      source: { kind: "player_view", view: "status" },
      channel: "current",
      key: "current",
      mount: "sidebar",
      config: {
        title: "Current panel",
        layout: "stack",
        theme: "calm",
        empty: "message",
        emptyMessage: "Empty",
        groups: [],
      },
    },
  ];
  files["preset.yaml"] = stringify(manifest);
  await store.save({ presetId: preset.id, name: preset.name, files });
  await store.select(preset.id);
  expect((await store.bindCurrent()).definition.playerViewPanels).toHaveLength(
    1,
  );
  interface Decorations {
    head: string;
    playerViews: { views: RenderedPlayerView[]; diagnostics: [] };
    playerViewPanels: FrontendPlayerViewPanelProjection[];
    suppressedPlayerViewIds: string[];
    extensionControls: WorldExtensionsView;
  }
  const read = async (rt = runtime, id = worldId) =>
    (await rt.handle({ type: "world.play-decorations.read", worldId: id }))
      .result as Decorations;
  const before = await read();
  expect(before.playerViewPanels).toHaveLength(1);
  const panel = before.extensionControls.items.find(
    (item) => item.kind === "panel",
  )!;
  const observedBefore = await runtime.readConversation({
    kind: "play",
    id: worldId,
  });
  let notifications = 0;
  const unsubscribe = runtime.subscribeConversation(
    { kind: "play", id: worldId },
    () => {
      notifications++;
    },
  );
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: panel.key,
    value: "off",
  });
  const hidden = await read();
  expect(hidden.head).toBe(before.head);
  expect(hidden.playerViewPanels).toEqual([]);
  expect(hidden.suppressedPlayerViewIds).toContain("status");
  expect(notifications).toBe(1);
  unsubscribe();
  const observedAfter = await runtime.readConversation({
    kind: "play",
    id: worldId,
  });
  expect(observedAfter).not.toEqual(observedBefore);
  const cold = new V1Runtime(options);
  expect((await read(cold)).playerViewPanels).toEqual([]);
  const fork = (
    await cold.handle({
      type: "world.derive",
      sourceWorldId: worldId,
      sourceHead: before.head,
      operationId: "fork-controls",
    })
  ).result as { world: { worldId: string } };
  const forkId = fork.world.worldId;
  expect((await read(cold, forkId)).playerViewPanels).toEqual([]);
  await cold.handle({
    type: "world.extensions.set",
    worldId: forkId,
    key: panel.key,
    value: "on",
  });
  expect((await read(cold, forkId)).playerViewPanels[0]?.payload).toEqual(
    before.playerViewPanels[0]?.payload,
  );
  expect((await read(cold)).playerViewPanels).toEqual([]);
  expect(await worlds.currentHead(worldId)).toBe(before.head);
});

test("改名排序保持身份与覆盖，删除定义拒绝旧 key，同名新项不继承；包脚本授权独立", async () => {
  const { runtime, worlds, worldId, preview } = await setup(["second"]);
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:stable-one",
    value: "on",
  });
  const controls = await worlds.readSurface(worldId, "control");
  const original = controls.find((file) => file.path === "followups.yaml")!;
  const declaration = parse(original.contents) as {
    followups: { id: string; displayName: string; enabled: boolean }[];
  };
  const update = async () => {
    await worlds.saveControlDraft(
      worldId,
      controls.map((file) =>
        file.path === original.path
          ? { ...file, contents: stringify(declaration) }
          : file,
      ),
    );
    await worlds.applyControlDraft(worldId, {
      hostBinding: preview.hostBinding,
      modelBinding: preview.modelBinding,
    });
  };
  declaration.followups[0]!.displayName = "Renamed";
  declaration.followups.reverse();
  await update();
  const read = async () =>
    (await runtime.handle({ type: "world.extensions.read", worldId }))
      .result as WorldExtensionsView;
  expect(
    (await read()).items.find((item) => item.key === "package:stable-one"),
  ).toMatchObject({ name: "Renamed", selected: true, overridden: true });
  declaration.followups = declaration.followups.map((item) =>
    item.id === "stable-one"
      ? { ...item, id: "new-identity", displayName: "Same name" }
      : item,
  );
  await update();
  expect(
    (await read()).items.find((item) => item.key === "package:new-identity"),
  ).toMatchObject({ selected: false, overridden: false });
  await expect(
    runtime.handle({
      type: "world.extensions.set",
      worldId,
      key: "package:stable-one",
      value: "on",
    }),
  ).rejects.toThrow("no longer exists");
  expect(
    (await runtime.handle({ type: "world.package-scripts.read", worldId }))
      .result,
  ).toEqual({ enabled: false });
});

test("关闭再开未派发项不补跑本轮，其他请求继续并保留已提交剧情", async () => {
  const { root, options, worlds, worldId } = await setup([
    "queued",
    "remaining",
  ]);
  const preset = await new FileNativePlayPresetStore(
    options.configRoot,
  ).bindCurrent();
  await worlds.extensionControls(worldId, preset, "en", {
    key: "package:stable-one",
    value: "on",
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<ModelHostResponse>();
  const requests: string[] = [];
  const binding = {
    provider: "chat_completions" as const,
    modelId: "test",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    endpointFingerprint: "fixture",
    protocolConfigFingerprint: "fixture",
  };
  const host: ModelHost = {
    binding: () => binding,
    async exchange(request) {
      requests.push(request.requestId!);
      if (request.requestId === "package:stable-one") {
        started.resolve();
        return release.promise;
      }
      return {
        text: "Committed story",
        providerState: {
          protocol: "chat_completions",
          assistantMessage: { role: "assistant", content: "Committed story" },
        },
      };
    },
  };
  const chain = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    new FileNativeArtifactStore(root),
  );
  const running = chain.start({
    worldId,
    chainId: "queued-chain",
    exchangeId: "one",
    playerText: "go",
    hostBinding: presetHostBinding(preset),
    playPreset: preset,
    modelBinding: binding,
    modelHost: host,
  });
  await Promise.race([
    started.promise,
    running.then((result) => {
      throw new Error(JSON.stringify(result));
    }),
  ]);
  const head = await worlds.currentHead(worldId);
  await worlds.extensionControls(worldId, preset, "en", {
    key: "package:queued",
    value: "off",
  });
  await worlds.extensionControls(worldId, preset, "en", {
    key: "package:queued",
    value: "on",
  });
  release.resolve({ text: "No output" });
  expect((await running).status).toBe("ready");
  expect(requests).toEqual([
    "play_call_chain",
    "package:stable-one",
    "package:remaining",
  ]);
  expect(await worlds.currentHead(worldId)).toBe(head);
});

test("合法子请求名 followups 与内容包组分别控制，关闭组不抹除子选择", async () => {
  const { runtime, worldId } = await setup(["followups"]);
  const read = async () =>
    (await runtime.handle({ type: "world.extensions.read", worldId }))
      .result as WorldExtensionsView;
  const before = await read();
  expect(
    before.items.find((item) => item.key === "group:package"),
  ).toMatchObject({ kind: "group", enabled: true });
  expect(
    before.items.find((item) => item.key === "package:followups"),
  ).toMatchObject({ kind: "request", enabled: true });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:followups",
    value: "off",
  });
  expect(
    (await read()).items.find((item) => item.key === "group:package")?.enabled,
  ).toBe(true);
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "group:package",
    value: "off",
  });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "group:package",
    value: "on",
  });
  expect(
    (await read()).items.find((item) => item.key === "package:followups"),
  ).toMatchObject({ enabled: false, overridden: true });
});
