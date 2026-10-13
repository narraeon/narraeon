import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { WorldArchives } from "../../src/runtime/archive/WorldArchives.ts";
import {
  archivePath,
  extractArchive,
  type ArchiveLimits,
} from "../../src/runtime/archive/WorldArchiveZip.ts";
import { worldArchiveLimits } from "../../src/protocol/worldArchives.ts";
import { PackageScriptPermissions } from "../../src/runtime/extension/PackageScriptPermissions.ts";
import { WorldExtensionControls } from "../../src/runtime/extension/WorldExtensionControls.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { presetHostBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  archiveModelBinding,
  archiveStores,
  worldArchiveFixture,
} from "../support/worldArchiveFixture.ts";
import { createZip, type ZipFixtureEntry } from "../support/createZip.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const value = await worldArchiveFixture();
  roots.push(value.root);
  return value;
}
async function empty() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-archive-target-"));
  roots.push(root);
  const value = archiveStores(root);
  await value.archives.initialize();
  return value;
}
async function exported(source: Awaited<ReturnType<typeof fixture>>) {
  const metadata = await source.archives.exportWorld({
    worldId: source.worldId,
    operationId: "export-backup",
  });
  return {
    metadata,
    zip: join(source.root, "world-archives/exports/export-backup/archive.zip"),
  };
}
async function entries(zip: string): Promise<ZipFixtureEntry[]> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-archive-edit-"));
  roots.push(root);
  const found = await extractArchive(zip, root, worldArchiveLimits);
  return Promise.all(
    [...found.keys()].map(async (path) => ({
      path,
      contents: await readFile(join(root, path)),
    })),
  );
}
async function importBuffer(
  target: Awaited<ReturnType<typeof empty>>,
  buffer: Buffer,
) {
  const upload = await target.archives.upload(Readable.from([buffer]));
  return target.archives.importWorld({
    operationId: "import-backup",
    ...upload,
  });
}
function updateManifest(files: ZipFixtureEntry[]) {
  const manifest = files.find((file) => file.path === "narraeon-world.json")!;
  const value = JSON.parse(String(manifest.contents)) as {
    files: { path: string; bytes: number; sha256: string }[];
  };
  value.files = files
    .filter((file) => file.path.startsWith("world/"))
    .map((file) => {
      const data = Buffer.isBuffer(file.contents)
        ? file.contents
        : Buffer.from(file.contents ?? "");
      return {
        path: file.path,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    });
  manifest.contents = JSON.stringify(value);
}

test("便携归档排除分叉新建的本地活动缓存，导入忽略来源缓存", async () => {
  const source = await fixture();
  const derive = source.chains.deriveWorld.bind(source.chains);
  const cache = "source-machine-local-activity";
  const spy = vi
    .spyOn(source.chains, "deriveWorld")
    .mockImplementation(async (input) => {
      const fork = await derive(input);
      await writeFile(join(fork.worldRoot, "runtime", "activity.json"), cache);
      return fork;
    });
  const archive = await exported(source);
  spy.mockRestore();
  const files = await entries(archive.zip);
  expect(
    files.some((file) => file.path === "world/runtime/activity.json"),
  ).toBe(false);
  files.push({ path: "world/runtime/activity.json", contents: cache });
  updateManifest(files);
  const target = await empty();
  const result = await importBuffer(target, createZip(files));
  const importedCache = await readFile(
    join(
      target.root,
      "worlds-file-native",
      result.world.worldId,
      "runtime",
      "activity.json",
    ),
    "utf8",
  ).catch(() => null);
  expect(importedCache).not.toBe(cache);
});

test("故事之后的世界修正端点归档保留完整页面轨迹与调用详情", async () => {
  const source = await fixture();
  await source.worlds.commitCorrection({
    worldId: source.worldId,
    parentHead: await source.worlds.currentHead(source.worldId),
    operationId: "after-story-correction",
    nextMaterials: [],
    stateChanges: [],
  });
  const before = await source.worlds.playTimeline.readPage(source.worldId, 40);
  const archive = await exported(source);
  const target = await empty();
  const result = await target.archives.importWorld({
    operationId: "corrected-import",
    ...(await target.archives.upload(createReadStream(archive.zip))),
  });
  const after = await target.worlds.playTimeline.readPage(
    result.world.worldId,
    40,
  );
  expect(after.items.map((item) => item.kind)).toEqual(
    before.items.map((item) => item.kind),
  );
  expect(await target.chains.inspectWorld(result.world.worldId)).toMatchObject({
    events: source.story.events,
  });
});

test("多上下文世界应用修订后归档保留全部冻结调用详情和最新控制", async () => {
  const source = await fixture();
  await source.chains.start({
    worldId: source.worldId,
    chainId: "second-source-context",
    exchangeId: "second-source-send",
    playerText: "我在大堂坐下。",
    hostBinding: presetHostBinding(source.preset),
    playPreset: source.preset,
    modelBinding: archiveModelBinding,
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: "大堂的炉火正旺。" }],
    }),
  });
  const workspace = new WorldRevisionWorkspace({
    worlds: source.worlds,
    store: new FileNativeWorldRevisionStore(source.root),
  });
  let epoch = await workspace.open(source.worldId);
  epoch = await workspace.replace({
    worldId: source.worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
    files: epoch.files.map((file) => ({
      ...file,
      contents:
        file.path === "control/blocks/world.md"
          ? `${file.contents}\n修订后保留完整备份。\n`
          : file.contents,
    })),
  });
  await workspace.apply({
    worldId: source.worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  });
  const before = await source.worlds.playTimeline.readAllContexts(
    source.worldId,
  );
  expect(before).toHaveLength(2);
  const archive = await exported(source);
  const target = await empty();
  const result = await target.archives.importWorld({
    operationId: "revision-import",
    ...(await target.archives.upload(createReadStream(archive.zip))),
  });
  const after = await target.worlds.playTimeline.readAllContexts(
    result.world.worldId,
  );
  const details = (context: (typeof before)[number]) => ({
    events: context.events,
    transcript: context.transcript,
    bootstrap: context.bootstrap,
    parentHead: context.parentHead,
    lastRequest: context.lastRequest,
    modelBinding: context.modelBinding,
  });
  expect(after.map(details)).toEqual(before.map(details));
  expect(
    await target.worlds.readSurface(result.world.worldId, "control"),
  ).toEqual(await source.worlds.readSurface(source.worldId, "control"));
  expect(
    await target.worlds.readAuthorityHistory(result.world.worldId),
  ).toEqual(await source.worlds.readAuthorityHistory(source.worldId));
});

test.each(["matching", "different"])(
  "本机新上下文之后从导入旧端点分叉仍需全新上下文（%s Provider 绑定）",
  async (provider) => {
    const source = await fixture();
    const archive = await exported(source);
    const target = await empty();
    const result = await target.archives.importWorld({
      operationId: "context-isolation-import",
      ...(await target.archives.upload(createReadStream(archive.zip))),
    });
    const old = (await target.chains.inspectWorld(result.world.worldId))!;
    const binding =
      provider === "matching"
        ? archiveModelBinding
        : { ...archiveModelBinding, endpointFingerprint: "local-provider" };
    await target.chains.start({
      worldId: result.world.worldId,
      chainId: "local-context",
      exchangeId: "local-send",
      playerText: "我用本机新上下文继续。",
      hostBinding: presetHostBinding(source.preset),
      playPreset: source.preset,
      modelBinding: binding,
      modelHost: new ScriptedModelHost({
        binding,
        steps: [{ outcome: "response", text: "本机主持回应。" }],
      }),
    });
    const cold = archiveStores(target.root);
    expect(
      await cold.worlds.archiveNeedsFreshContext(result.world.worldId),
    ).toBe(false);
    const branch = await cold.chains.deriveWorld({
      operationId: "old-imported-context-fork",
      sourceWorldId: result.world.worldId,
      sourceHead: old.parentHead,
      hostPresetId: "host",
    });
    expect(
      await cold.worlds.archiveNeedsFreshContext(branch.world.worldId),
    ).toBe(true);
    const forked = (await cold.chains.inspectWorld(branch.world.worldId))!;
    const oldHost = new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: "不应续传旧链。" }],
    });
    await expect(
      cold.chains.append({
        worldId: branch.world.worldId,
        chainId: forked.chainId,
        exchangeId: "old-fork-append",
        playerText: "继续",
        modelHost: oldHost,
      }),
    ).rejects.toThrow("fresh context");
    expect(oldHost.requests).toHaveLength(0);
    const forkFreshHost = new ScriptedModelHost({
      binding,
      steps: [{ outcome: "response", text: "分叉使用本机全新上下文。" }],
    });
    await cold.chains.start({
      worldId: branch.world.worldId,
      chainId: "fork-local-context",
      exchangeId: "fork-local-send",
      playerText: "以本机选择重新开始。",
      hostBinding: presetHostBinding(source.preset),
      playPreset: source.preset,
      modelBinding: binding,
      modelHost: forkFreshHost,
    });
    expect(
      forkFreshHost.requests[0]!.appended.some(
        (item) => item.kind === "assistant",
      ),
    ).toBe(false);
    expect(
      await cold.worlds.archiveNeedsFreshContext(branch.world.worldId),
    ).toBe(false);
    const localHost = new ScriptedModelHost({
      binding,
      steps: [{ outcome: "response", text: "本机上下文仍可正常继续。" }],
    });
    await cold.chains.append({
      worldId: result.world.worldId,
      chainId: "local-context",
      exchangeId: "local-append",
      playerText: "我再问一句。",
      modelHost: localHost,
    });
    expect(localHost.requests).toHaveLength(1);
  },
);

test("本机新上下文之后修改导入旧玩家消息不能沿来源上下文继续", async () => {
  const source = await fixture();
  await source.chains.append({
    worldId: source.worldId,
    chainId: source.story.chainId,
    exchangeId: "second-origin-player",
    playerText: "我走上楼梯。",
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: "楼梯传来脚步声。" }],
    }),
  });
  const archive = await exported(source);
  const target = await empty();
  const result = await target.archives.importWorld({
    operationId: "old-edit-import",
    ...(await target.archives.upload(createReadStream(archive.zip))),
  });
  const old = (await target.chains.inspectWorld(result.world.worldId))!;
  await target.chains.start({
    worldId: result.world.worldId,
    chainId: "local-before-edit",
    exchangeId: "local-before-edit-send",
    playerText: "我开启本机上下文。",
    hostBinding: presetHostBinding(source.preset),
    playPreset: source.preset,
    modelBinding: archiveModelBinding,
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "response", text: "本机回应。" }],
    }),
  });
  const cold = archiveStores(target.root);
  const head = await cold.worlds.currentHead(result.world.worldId);
  const player = old.events.findLast((event) => event.kind === "player")!;
  const revision = {
    operationId: "old-imported-player-edit",
    worldId: result.world.worldId,
    chainId: old.chainId,
    eventId: player.id,
    replacementExchangeId: "old-edit-replacement",
    replacementText: "我从侧门走入。",
  };
  await expect(
    cold.chains.revisePlayer({
      ...revision,
      continuation: "continue_context",
    }),
  ).rejects.toThrow("fresh context");
  expect(await cold.worlds.currentHead(result.world.worldId)).toBe(head);
  await cold.chains.revisePlayer({
    ...revision,
    continuation: "fresh_context",
    freshContext: {
      hostBinding: presetHostBinding(source.preset),
      playPreset: source.preset,
      modelBinding: archiveModelBinding,
    },
  });
  expect(
    (await cold.worlds.recoverEndpoint(result.world.worldId)).history.at(-1)
      ?.exactText,
  ).toBe(revision.replacementText);
  const oldPrefix = await cold.chains.deriveWorld({
    operationId: "imported-prefix-after-fresh-edit",
    sourceWorldId: result.world.worldId,
    sourceHead: "commit:2",
    hostPresetId: "host",
  });
  expect(
    await cold.worlds.archiveNeedsFreshContext(oldPrefix.world.worldId),
  ).toBe(true);
  expect(
    (await cold.chains.inspectWorld(oldPrefix.world.worldId))?.events
      .filter((event) => event.kind === "player")
      .map((event) => event.text),
  ).toEqual(["我推开旅店的大门。"]);
});

test("归档完整保留已结束的失败调用记录和冻结请求", async () => {
  const source = await fixture();
  const failed = await source.chains.start({
    worldId: source.worldId,
    chainId: "failed-source-context",
    exchangeId: "failed-source-send",
    playerText: "我查看阁楼。",
    hostBinding: presetHostBinding(source.preset),
    playPreset: source.preset,
    modelBinding: archiveModelBinding,
    modelHost: new ScriptedModelHost({
      binding: archiveModelBinding,
      steps: [{ outcome: "failure", message: "Provider rejected request" }],
    }),
  });
  expect(failed.status).toBe("interrupted");
  const encoding = {
    provider: "chat_completions" as const,
    method: "POST" as const,
    endpointPath: "/v1/chat/completions",
    headerNames: ["Content-Type"],
    body: { messages: [{ role: "user", content: "我查看阁楼。" }] },
  };
  await source.worlds.playTimeline.recordInitialEncoding(
    source.worldId,
    failed.chainId,
    encoding,
  );
  const before = await source.worlds.playTimeline.readAllContexts(
    source.worldId,
  );
  const archive = await exported(source);
  const target = await empty();
  const imported = await target.archives.importWorld({
    operationId: "failed-context-import",
    ...(await target.archives.upload(createReadStream(archive.zip))),
  });
  const after = await target.worlds.playTimeline.readAllContexts(
    imported.world.worldId,
  );
  expect(
    await target.worlds.playTimeline.readInitialEncoding(
      imported.world.worldId,
      after.at(-1)!.chainId,
    ),
  ).toEqual(encoding);
  expect(
    after.map((context) => ({
      events: context.events,
      transcript: context.transcript,
      lastRequest: context.lastRequest,
      lastFailure: context.lastFailure,
      status: context.status,
    })),
  ).toEqual(
    before.map((context) => ({
      events: context.events,
      transcript: context.transcript,
      lastRequest: context.lastRequest,
      lastFailure: context.lastFailure,
      status: context.status,
    })),
  );
});

test("完整世界跨根往返保留 Authority、故事、冻结产物与名称，独立导入并强制全新上下文", async () => {
  const source = await fixture();
  const sourceRoot = join(source.root, "worlds-file-native", source.worldId);
  await source.worlds.renameWorld(source.worldId, "雨夜 旅店");
  await PackageScriptPermissions.write(sourceRoot, ["a".repeat(64)]);
  const controls = await WorldExtensionControls.read(sourceRoot);
  controls.revision += 1;
  await WorldExtensionControls.write(sourceRoot, controls);
  const assistant = source.story.events.find(
    (event) => event.kind === "assistant" && event.committedHead,
  )!;
  if (assistant.kind !== "assistant") throw new Error("Missing story");
  const operation = {
    worldId: source.worldId,
    parentHead: "commit:1",
    operationId: "archive-artifact",
    playPresetId: "preset",
    playPresetRevision: "rev",
    playPresetScriptsEnabled: true,
    attachment: {
      contextId: "archive-chain",
      eventId: assistant.id,
      head: assistant.committedHead!,
      runId: "archive-send",
    },
  };
  const request = {
    ...operation,
    requestId: "decorate",
    requestAttempt: 1,
    maxArtifactBytes: 4096,
    declarations: [
      {
        name: "panel",
        channel: "ui.panel",
        strategy: "replace" as const,
        contentType: "text/plain" as const,
        save: "commit" as const,
        invalidation: "never" as const,
        required: false,
        maxEmits: 1,
        rendererMode: "document" as const,
      },
    ],
    frozenResources: {
      files: { "panel.html": "<b>冻结资源</b>" },
      mount: "story" as const,
    },
  };
  await source.artifacts.beginOperation(operation);
  await source.artifacts.markCoreCommitted(operation, assistant.committedHead!);
  await source.artifacts.beginExtension(operation);
  await source.artifacts.beginRequestAttempt(request);
  await source.artifacts.emit({
    context: request,
    output: "panel",
    payload: "备份保留正文",
    toolCallId: "emit",
  });
  await source.artifacts.completeExtension(operation.operationId, [
    request.requestId,
  ]);
  const archive = await exported(source);
  expect(archive.metadata.fileName).toBe("雨夜-旅店.narraeon-world.zip");
  expect(await source.worlds.listWorlds()).toHaveLength(1);
  const before = await source.worlds.readAuthorityHistory(source.worldId);
  const surfaces = await Promise.all(
    (["state", "control", "history"] as const).map((surface) =>
      source.worlds.readSurface(source.worldId, surface),
    ),
  );
  const sourcePage = await source.worlds.playTimeline.readPage(
    source.worldId,
    40,
  );
  // Keep only the ZIP: neither the original world nor its artifacts may supply an imported read.
  await source.worlds.deleteWorld(source.worldId);
  await rm(join(source.root, "artifact-store"), {
    recursive: true,
    force: true,
  });
  const target = await empty();
  const upload = await target.archives.upload(createReadStream(archive.zip));
  const first = await target.archives.importWorld({
    operationId: "import-first",
    ...upload,
  });
  expect(first.world.title).toBe("雨夜 旅店");
  expect(
    await target.archives.importWorld({
      operationId: "import-first",
      ...upload,
    }),
  ).toEqual(first);
  const second = await target.archives.importWorld({
    operationId: "import-second",
    ...(await target.archives.upload(createReadStream(archive.zip))),
  });
  expect(second.world.worldId).not.toBe(first.world.worldId);
  expect(await target.worlds.readAuthorityHistory(first.world.worldId)).toEqual(
    before,
  );
  expect(
    await Promise.all(
      (["state", "control", "history"] as const).map((surface) =>
        target.worlds.readSurface(first.world.worldId, surface),
      ),
    ),
  ).toEqual(surfaces);
  const page = await target.worlds.playTimeline.readPage(
    first.world.worldId,
    40,
  );
  expect(
    page.items.map((item) => (item.kind === "event" ? item.event : item.kind)),
  ).toEqual(
    sourcePage.items.map((item) =>
      item.kind === "event" ? item.event : item.kind,
    ),
  );
  expect(page.activeChainId).not.toBe(sourcePage.activeChainId);
  expect(
    await target.artifacts.readActiveProjection(first.world.worldId),
  ).toMatchObject([
    {
      payload: "备份保留正文",
      frozenPresentation: { files: { "panel.html": "<b>冻结资源</b>" } },
    },
  ]);
  const targetRoot = join(
    target.root,
    "worlds-file-native",
    first.world.worldId,
  );
  expect(await PackageScriptPermissions.read(targetRoot)).toEqual([]);
  expect(await WorldExtensionControls.read(targetRoot)).toEqual(controls);
  expect(
    await target.worlds.archiveNeedsFreshContext(first.world.worldId),
  ).toBe(true);
  const restored = await target.chains.inspectWorld(first.world.worldId);
  if (!restored) throw new Error("Missing restored call chain");
  await expect(
    target.chains.append({
      worldId: first.world.worldId,
      chainId: restored.chainId,
      exchangeId: "old-append",
      playerText: "继续",
      modelHost: new ScriptedModelHost({
        binding: archiveModelBinding,
        steps: [],
      }),
    }),
  ).rejects.toThrow("fresh context");
  const importedFork = await target.chains.deriveWorld({
    operationId: "imported-fork",
    sourceWorldId: first.world.worldId,
    sourceHead: restored.parentHead,
    hostPresetId: "host",
  });
  expect(
    await target.worlds.archiveNeedsFreshContext(importedFork.world.worldId),
  ).toBe(true);
  const binding = {
    ...archiveModelBinding,
    endpointFingerprint: "another-machine",
  };
  const host = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "新旅程继续。" }],
  });
  await target.chains.start({
    worldId: first.world.worldId,
    chainId: "target-fresh",
    exchangeId: "target-send",
    playerText: "我向Alex问好。",
    hostBinding: presetHostBinding(source.preset),
    playPreset: source.preset,
    modelBinding: binding,
    modelHost: host,
  });
  expect(host.requests).toHaveLength(1);
  expect(
    host.requests[0]!.appended.some((item) => item.kind === "assistant"),
  ).toBe(false);
  expect(
    await target.worlds.archiveNeedsFreshContext(first.world.worldId),
  ).toBe(false);
  expect(await target.worlds.currentHead(second.world.worldId)).toBe(
    before.head,
  );
  // Fresh-context player editing remains available against preserved old page events.
  const player = restored.events.find((event) => event.kind === "player")!;
  await target.chains.revisePlayer({
    operationId: "imported-edit",
    worldId: second.world.worldId,
    chainId: (await target.chains.inspectWorld(second.world.worldId))!.chainId,
    eventId: player.id,
    replacementExchangeId: "edited-send",
    replacementText: "我轻轻敲门。",
    continuation: "fresh_context",
    freshContext: {
      hostBinding: presetHostBinding(source.preset),
      playPreset: source.preset,
      modelBinding: binding,
    },
  });
  expect(
    (await target.worlds.recoverEndpoint(second.world.worldId)).history.at(-1)
      ?.exactText,
  ).toBe("我轻轻敲门。");
});

test.each([
  "changed-file",
  "changed-blob-and-manifest",
  "extra",
  "missing",
  "traversal",
  "symlink",
  "duplicate",
  "case-conflict",
  "format",
  "non-utf8",
  "backslash",
  "absolute",
])("拒绝损坏归档 %s 并清理隔离与上传", async (kind) => {
  const source = await fixture();
  const archive = await exported(source);
  const files = await entries(archive.zip);
  const target = await empty();
  const state = files.find((file) => file.path.startsWith("world/state/"))!;
  if (kind === "changed-file") state.contents = "changed";
  if (kind === "changed-blob-and-manifest") {
    const blob =
      files.find((file) => /authority-v3\/.*blobs/u.test(file.path)) ??
      files.find((file) => /authority-v3\/.*state/u.test(file.path));
    if (!blob)
      throw new Error(
        `Missing Authority blob: ${files.map((file) => file.path).join()}`,
      );
    blob.contents = "tampered immutable object";
    updateManifest(files);
  }
  if (kind === "extra")
    files.push({ path: "world/extra.txt", contents: "extra" });
  if (kind === "missing") files.splice(files.indexOf(state), 1);
  if (kind === "traversal")
    files.push({ path: "world/../../escape", contents: "escape" });
  if (kind === "symlink")
    files.push({
      path: "world/link",
      contents: "../outside",
      unixMode: 0o120777,
    });
  if (kind === "duplicate") files.push({ ...state });
  if (kind === "case-conflict")
    files.push({ ...state, path: state.path.toUpperCase() });
  if (kind === "backslash")
    files.push({ path: "world\\escape", contents: "bad" });
  if (kind === "absolute")
    files.push({ path: "/world/escape", contents: "bad" });
  if (kind === "format") {
    const manifest = files.find((file) => file.path === "narraeon-world.json")!;
    manifest.contents = String(manifest.contents).replace(
      "narraeon.world-archive/v1",
      "narraeon.world-archive/v99",
    );
  }
  let zip = createZip(files);
  if (kind === "non-utf8") {
    const bad = createZip([{ path: "world/abcdef", contents: "bad" }]);
    const name = Buffer.from("world/abcdef");
    let offset = bad.indexOf(name);
    while (offset >= 0) {
      bad[offset + 6] = 0xff;
      offset = bad.indexOf(name, offset + name.length);
    }
    zip = bad;
  }
  const code = [
    "traversal",
    "symlink",
    "duplicate",
    "case-conflict",
    "non-utf8",
    "backslash",
    "absolute",
  ].includes(kind)
    ? "unsafe_path"
    : kind === "format"
      ? "unsupported_format"
      : "integrity_failed";
  await expect(importBuffer(target, zip)).rejects.toMatchObject({ code });
  expect(await target.worlds.listWorlds()).toEqual([]);
  expect(await readdir(join(target.root, "world-archives/quarantine"))).toEqual(
    [],
  );
  expect(await readdir(join(target.root, "world-archives/uploads"))).toEqual(
    [],
  );
});

test("不信任归档的可变 state/history 投影；从 Authority 重建", async () => {
  const source = await fixture();
  const archive = await exported(source);
  const files = await entries(archive.zip);
  const target = await empty();
  files.find((file) => file.path.startsWith("world/state/"))!.contents =
    "wrong projected state";
  files.find((file) => file.path.startsWith("world/history/"))!.contents =
    "wrong projected story";
  updateManifest(files);
  const result = await importBuffer(target, createZip(files));
  expect(
    await target.worlds.readSurface(result.world.worldId, "state"),
  ).toEqual(await source.worlds.readSurface(source.worldId, "state"));
  expect(
    await target.worlds.readSurface(result.world.worldId, "history"),
  ).toEqual(await source.worlds.readSurface(source.worldId, "history"));
});

test.each(["archiveBytes", "extractedBytes", "entries", "entryBytes"] as const)(
  "流式体积限制 %s",
  async (limit) => {
    const target = await empty();
    const limits: ArchiveLimits = {
      ...worldArchiveLimits,
      [limit]: limit === "entries" ? 1 : 20,
    };
    const archives = new WorldArchives({
      dataRoot: target.root,
      worlds: target.worlds,
      chains: target.chains,
      limits,
    });
    const buffer = createZip([
      { path: "narraeon-world.json", contents: "a".repeat(30) },
      { path: "world/x", contents: "x" },
    ]);
    if (limit === "archiveBytes")
      await expect(
        archives.upload(
          Readable.from([buffer.subarray(0, 10), buffer.subarray(10)]),
        ),
      ).rejects.toMatchObject({ code: "limit_exceeded" });
    else {
      const upload = await archives.upload(Readable.from([buffer]));
      await expect(
        archives.importWorld({ operationId: "over-limit", ...upload }),
      ).rejects.toMatchObject({ code: "limit_exceeded" });
    }
    expect(await target.worlds.listWorlds()).toEqual([]);
    expect(await readdir(join(target.root, "world-archives/uploads"))).toEqual(
      [],
    );
  },
);

test("导出拒绝活动修订、生成与待修复物化", async () => {
  const source = await fixture();
  const input = { worldId: source.worldId, operationId: "blocked-export" };
  const revision = await source.worlds.acquireWorldRevisionLock(
    source.worldId,
    "epoch",
  );
  if (revision.kind !== "acquired") throw new Error("Lock failed");
  await expect(source.archives.exportWorld(input)).rejects.toThrow(
    "apply or discard",
  );
  await source.worlds.releaseWorldRevisionLock(revision.handle);
  source.worlds.freezeControl(source.worldId, "generating");
  await expect(source.archives.exportWorld(input)).rejects.toMatchObject({
    code: "operation_conflict",
  });
  source.worlds.releaseControl(source.worldId, "generating");
  await rm(
    join(
      source.root,
      "worlds-file-native",
      source.worldId,
      "runtime/materialized-head.json",
    ),
  );
  await expect(source.archives.exportWorld(input)).rejects.toMatchObject({
    code: "inconsistent_materialization",
  });
  expect(await source.worlds.listWorlds()).toHaveLength(1);
});

test.each([
  "quarantine",
  "unpack",
  "audit",
  "derivation_after_target_staging",
  "derivation_before_publish",
  "derivation_after_publish",
  "publish",
])(
  "进程崩溃 %s 后同 operation 重试只有一个完整世界",
  async (edge) => {
    const source = await fixture();
    const archive = await exported(source);
    const target = await empty();
    const upload = await target.archives.upload(createReadStream(archive.zip));
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve("tests/runtime/fixtures/world-archive-worker.ts"),
          target.root,
          upload.uploadId,
          edge,
        ],
        { env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe" },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 89 || signal === "SIGKILL"
          ? resolveExit(code ?? 88)
          : reject(new Error(stderr || `Worker exit ${code}`)),
      );
    });
    expect([88, 89]).toContain(code);
    const cold = archiveStores(target.root);
    // Some retries happen immediately, others after startup cleanup and re-upload.
    let retryUpload = upload;
    if (["audit", "derivation_after_publish", "publish"].includes(edge)) {
      await cold.archives.initialize();
      retryUpload = await cold.archives.upload(createReadStream(archive.zip));
    }
    const result = await cold.archives.importWorld({
      operationId: "crash-import",
      ...retryUpload,
    });
    expect(
      await cold.archives.importWorld({
        operationId: "crash-import",
        ...retryUpload,
      }),
    ).toEqual(result);
    expect(await cold.worlds.listWorlds()).toHaveLength(1);
    expect(
      await cold.worlds.readAuthorityHistory(result.world.worldId),
    ).toEqual(await source.worlds.readAuthorityHistory(source.worldId));
    expect(
      await readdir(join(target.root, "world-archives/quarantine")),
    ).toEqual([]);
    expect(
      (await readdir(join(target.root, "worlds-file-native"))).filter((name) =>
        name.startsWith(".staging"),
      ),
    ).toEqual([]);
  },
  30000,
);

test("启动清理上传和隔离区；下载到期拒绝并删除导出", async () => {
  const source = await fixture();
  const archive = await exported(source);
  await source.archives.upload(createReadStream(archive.zip));
  await source.archives.initialize();
  for (const name of ["uploads", "quarantine", "exports"])
    expect(await readdir(join(source.root, "world-archives", name))).toEqual(
      [],
    );
  expect(await source.worlds.listWorlds()).toHaveLength(1);
});

test.each([
  "world/CON.txt",
  "world/filename?.json",
  `world/${"x".repeat(256)}`,
  "world/name.",
  "world/name ",
])("拒绝跨平台不安全路径 %s", (path) => {
  expect(() => archivePath(path)).toThrow("unsafe path");
});

test("上传完成边界崩溃没有世界，启动清理上传残留", async () => {
  const source = await fixture();
  const archive = await exported(source);
  const target = await empty();
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve("tests/runtime/fixtures/world-archive-worker.ts"),
        target.root,
        archive.zip,
        "upload",
      ],
      { env: { ...process.env, NODE_ENV: "test" }, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", done);
  });
  expect(code).toBe(89);
  expect(await target.worlds.listWorlds()).toEqual([]);
  expect(
    await readdir(join(target.root, "world-archives/uploads")),
  ).toHaveLength(1);
  await archiveStores(target.root).archives.initialize();
  expect(await readdir(join(target.root, "world-archives/uploads"))).toEqual(
    [],
  );
});

test("一小时未下载的导出过期并删除", async () => {
  const source = await fixture();
  await exported(source);
  const old = new Date(Date.now() - 3605000);
  const root = join(source.root, "world-archives/exports/export-backup");
  await utimes(join(root, "download.json"), old, old);
  await expect(source.archives.download("export-backup")).rejects.toThrow(
    "expired",
  );
  expect(await readdir(join(source.root, "world-archives/exports"))).toEqual(
    [],
  );
});
