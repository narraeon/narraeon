import * as fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { createMinimalFileNativePreviewInput } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

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

test("下一次候选预览应用世界覆盖，与实际新发送后置清单一致而不发模型", async () => {
  const { runtime, worldId } = await setup(["queued"]);
  await runtime.handle({
    type: "model.save",
    connection: {
      name: "Preview only",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "fixture",
      modelId: "test",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:stable-one",
    value: "on",
  });
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:queued",
    value: "off",
  });
  const result = (
    await runtime.handle({ type: "world.play-context.read", worldId })
  ).result as {
    nextFreshContext: {
      preview: { playPreset: { followups: { id: string }[] } };
    };
  };
  expect(
    result.nextFreshContext.preview.playPreset.followups.map((item) => item.id),
  ).toEqual(["package:stable-one"]);
});

test("世界关闭与产物清除共享接受顺序，关闭后的旧 clear 不能清除其他请求产物", async () => {
  const { root, runtime, options, worldId } = await setup(["remaining"]);
  await runtime.handle({
    type: "world.extensions.set",
    worldId,
    key: "package:stable-one",
    value: "on",
  });
  const preset = await new FileNativePlayPresetStore(
    options.configRoot,
  ).bindCurrent();
  const controls = (
    await runtime.handle({ type: "world.extensions.read", worldId })
  ).result as WorldExtensionsView;
  const store = new FileNativeArtifactStore(root);
  const operation = {
    worldId,
    parentHead: "genesis",
    operationId: "race-clear",
    playPresetId: preset.id,
    playPresetRevision: preset.revision,
    playPresetScriptsEnabled: false,
  };
  const request = (id: string) => ({
    ...operation,
    requestId: id,
    requestAttempt: 1,
    maxArtifactBytes: 4096,
    extensionControl: {
      key: id,
      generation: controls.items.find((item) => item.key === id)!.generation,
    },
    declarations: [
      {
        name: "panel",
        channel: "shared",
        strategy: "replace" as const,
        contentType: "text/plain" as const,
        save: "commit" as const,
        invalidation: "explicit_clear" as const,
        required: false,
        maxEmits: 4,
      },
    ],
  });
  const old = request("package:stable-one"),
    remaining = request("package:remaining");
  await store.beginOperation(operation);
  await store.markCoreCommitted(operation, "genesis");
  await store.beginExtension(operation);
  await store.beginRequestAttempt(old);
  await store.beginRequestAttempt(remaining);
  await store.emit({
    context: remaining,
    output: "panel",
    payload: "OTHER",
    toolCallId: "other",
  });
  const checked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalRead = (await vi.importActual<typeof fs>("node:fs/promises"))
    .readFile;
  let pause = true;
  const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    const result = await originalRead(...args);
    if (
      pause &&
      typeof args[0] === "string" &&
      args[0].endsWith("extension-controls.json")
    ) {
      pause = false;
      checked.resolve();
      await release.promise;
    }
    return result;
  });
  const accepted: string[] = [];
  let clear: Promise<unknown> | undefined, close: Promise<unknown> | undefined;
  try {
    clear = store
      .clear({ context: old, output: "panel", toolCallId: "first-clear" })
      .then((value) => {
        accepted.push("clear");
        return value;
      });
    await checked.promise;
    close = runtime
      .handle({
        type: "world.extensions.set",
        worldId,
        key: "package:stable-one",
        value: "off",
      })
      .then((value) => {
        accepted.push("off");
        return value;
      });
    // Hold the filesystem read at the authorization edge while the other command
    // runs. The accepted order must remain clear-then-close, never close-then-clear.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release.resolve();
    await Promise.all([clear, close]);
    expect(accepted).toEqual(["clear", "off"]);
    await store.emit({
      context: remaining,
      output: "panel",
      payload: "KEEP",
      toolCallId: "other-again",
    });
    await store.clear({
      context: old,
      output: "panel",
      toolCallId: "late-clear",
    });
    expect(
      (await store.readActiveProjection(worldId)).map((item) => item.payload),
    ).toEqual(["KEEP"]);
  } finally {
    release.resolve();
    await Promise.allSettled([clear, close]);
    spy.mockRestore();
  }
});

test("source default edits and removal preserve frozen requests until an explicit world close", async () => {
  const { WorldExtensionControls } =
    await import("../../src/runtime/extension/WorldExtensionControls.ts");
  const { WorldExtensionRequests } =
    await import("../../src/runtime/extension/WorldExtensionRequests.ts");
  const root = await mkdtemp(join(tmpdir(), "world-extension-frozen-"));
  roots.push(root);
  const worldId = "frozen-world";
  const worldRoot = join(root, worldId);
  await fs.mkdir(worldRoot);
  const definitions = [
    {
      key: "group:package",
      id: "package:followups",
      name: "Package",
      kind: "group" as const,
      source: "package" as const,
      defaultEnabled: true,
    },
    {
      key: "package:one",
      id: "package:one",
      name: "One",
      kind: "request" as const,
      source: "package" as const,
      group: "group:package",
      defaultEnabled: true,
    },
  ];
  const initial = await WorldExtensionControls.resolve(
    worldRoot,
    definitions,
    "preset",
  );
  const requests = new WorldExtensionRequests(root);
  const record = {
    playPresetId: "preset",
    requestId: "package:one",
    extensionControl: {
      key: "package:one",
      generation: initial.items[1]!.generation,
    },
  };
  const lease = await requests.acquire(worldId, record);
  try {
    const next = await WorldExtensionControls.resolve(
      worldRoot,
      definitions.map((item) => ({ ...item, defaultEnabled: false })),
      "preset",
    );
    await requests.changed(worldId);
    expect(next.items.every((item) => !item.enabled)).toBe(true);
    expect(lease.signal.aborted).toBe(false);
    expect(await requests.visible(worldId, record)).toBe(true);
    await WorldExtensionControls.resolve(
      worldRoot,
      [definitions[0]!],
      "preset",
    );
    await requests.changed(worldId);
    expect(lease.signal.aborted).toBe(false);
    expect(await requests.visible(worldId, record)).toBe(true);
    await WorldExtensionControls.resolve(
      worldRoot,
      [definitions[0]!],
      "preset",
      { key: "group:package", value: "off" },
    );
    await requests.changed(worldId);
    expect(lease.signal.aborted).toBe(true);
    expect(await requests.visible(worldId, record)).toBe(false);
    await WorldExtensionControls.resolve(worldRoot, definitions, "preset", {
      key: "group:package",
      value: "on",
    });
    expect(await requests.visible(worldId, record)).toBe(false);
    const restored = await WorldExtensionControls.resolve(
      worldRoot,
      definitions,
      "preset",
    );
    expect(
      await requests.visible(worldId, {
        ...record,
        extensionControl: {
          key: "package:one",
          generation: restored.items[1]!.generation,
        },
      }),
    ).toBe(true);
  } finally {
    lease.release();
  }
});

test("restored defaults can enable new generations without reviving closed output", async () => {
  const { WorldExtensionControls } =
    await import("../../src/runtime/extension/WorldExtensionControls.ts");
  const { WorldExtensionRequests } =
    await import("../../src/runtime/extension/WorldExtensionRequests.ts");
  const root = await mkdtemp(join(tmpdir(), "world-extension-defaults-"));
  roots.push(root);
  const worldId = "defaults-world";
  const worldRoot = join(root, worldId);
  await fs.mkdir(worldRoot);
  const definition = {
    key: "preset:p:request:one",
    id: "one",
    name: "One",
    kind: "request" as const,
    source: "preset" as const,
    defaultEnabled: true,
  };
  const initial = await WorldExtensionControls.resolve(
    worldRoot,
    [definition],
    "p",
  );
  const requests = new WorldExtensionRequests(root);
  const record = {
    playPresetId: "p",
    requestId: "one",
    extensionControl: {
      key: definition.key,
      generation: initial.items[0]!.generation,
    },
  };
  await WorldExtensionControls.resolve(worldRoot, [definition], "p", {
    key: definition.key,
    value: "off",
  });
  await WorldExtensionControls.resolve(
    worldRoot,
    [{ ...definition, defaultEnabled: false }],
    "p",
    { key: definition.key, value: "default" },
  );
  const next = await WorldExtensionControls.resolve(
    worldRoot,
    [definition],
    "p",
  );
  expect(next.items[0]).toMatchObject({ enabled: true, overridden: false });
  expect(await requests.visible(worldId, record)).toBe(false);
  const lease = await requests.acquire(worldId, {
    ...record,
    extensionControl: {
      key: definition.key,
      generation: next.items[0]!.generation,
    },
  });
  try {
    expect(lease.signal.aborted).toBe(false);
  } finally {
    lease.release();
  }
});

test("world deletion waits for a controls read that initializes persistent defaults", async () => {
  const { root, runtime, worldId } = await setup();
  const controlPath = join(
    root,
    "worlds-file-native",
    worldId,
    "extension-controls.json",
  );
  await fs.rm(controlPath, { force: true });
  const originalRead = (await vi.importActual<typeof fs>("node:fs/promises"))
    .readFile;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const spy = vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (!held && args[0] === controlPath) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return originalRead(...args);
  });
  const accepted: string[] = [];
  let reading: Promise<unknown> | undefined;
  let deleting: Promise<unknown> | undefined;
  try {
    reading = runtime
      .handle({ type: "world.extensions.read", worldId })
      .then((value) => {
        accepted.push("read");
        return value;
      });
    await entered.promise;
    deleting = runtime
      .handle({ type: "world.delete", worldId })
      .then((value) => {
        accepted.push("delete");
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(accepted).toEqual([]);
    release.resolve();
    await Promise.all([reading, deleting]);
    expect(accepted).toEqual(["read", "delete"]);
    await expect(
      fs.stat(join(root, "worlds-file-native", worldId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve();
    await Promise.allSettled([reading, deleting]);
    spy.mockRestore();
  }
});
