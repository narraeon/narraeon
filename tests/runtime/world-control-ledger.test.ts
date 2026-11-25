import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { RuntimeDomainError } from "../../src/runtime/RuntimeDomainError.ts";
import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  createHistoryQuery,
  historyEntries,
} from "../../src/runtime/history/HistoryTools.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  applyChanges,
  beginTurn,
  forgetLedger,
  listTurns,
  type WorldTurnFileChange,
} from "../../src/runtime/world/WorldTurnLedger.ts";
import { createZip } from "../support/createZip.ts";

// 控制随轮账本：控制编辑应用、世界修订应用、回退与分叉之间的一致性（#106）。

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const frameV1 = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`;

// 新建的控制文档 D：frame 引用它，修订与控制编辑都以此为可观察的变化。
const frameWithArchive = frameV1.replace(
  "  - markdown: blocks/world.md\n",
  "  - markdown: blocks/world.md\n  - markdown: blocks/archive.md\n",
);

const prompt = {
  hostBinding: {
    hostPresetId: "host",
    files: {
      "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - markdown: blocks/style.md\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
      "blocks/style.md": "# Style\n",
    },
  },
  modelBinding: {
    provider: "chat_completions" as const,
    modelId: "test",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
  },
};

test("世界修订应用是一轮：回退到应用之前时 control/ 与 state/ 同时恢复，世界照常可游玩", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const before = await snapshot(fixture.store, fixture.worldId);

  const applied = await applyRevision(fixture);
  expect(applied.apply).toMatchObject({
    phase: "committed",
    committedHead: "commit:2",
  });
  expect(modesOf(await listTurns(fixture.worldRoot))).toEqual([
    "play",
    "revision_apply",
  ]);
  expect(
    (await fixture.store.readSurface(fixture.worldId, "control")).map(
      ({ path }) => path,
    ),
  ).toContain("blocks/archive.md");

  await fixture.store.rewindPlayerRevision(fixture.worldId, "commit:1");

  expect(await snapshot(fixture.store, fixture.worldId)).toEqual(before);
  await expect(
    fixture.store.recoverEndpoint(fixture.worldId),
  ).resolves.toMatchObject({ head: "commit:1" });
  const binding = await fixture.store.bindPlayCallChain(fixture.worldId);
  expect(binding.files["control/blocks/world.md"]).toBe(
    before.control.find(({ path }) => path === "blocks/world.md")?.contents,
  );
  await fixture.store.commitPlayStep({
    operationId: "play-after-rewind",
    worldId: fixture.worldId,
    parentHead: "commit:1",
    historyAppend: [{ role: "player", exactText: "回退后继续。" }],
    nextMaterials: [],
    stateChanges: [],
  });
  // 回退本身是第 3 轮，之后的游玩是第 4 轮：轮号不重用。
  expect(await fixture.store.currentHead(fixture.worldId)).toBe("commit:4");
});

test("控制编辑应用是一轮 control_apply：只推进一轮，回退到应用之前时控制恢复", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  const searchHistory = async () => {
    const binding = await fixture.store.bindPlayCallChain(fixture.worldId);
    return createHistoryQuery(
      fixture.worldId,
      historyEntries(binding.history, binding.historyBackgrounds),
      binding.historyVersion,
    );
  };
  const firstPage = (await searchHistory()).search({
    queries: ["第一句", "quiet"],
    limit: 1,
  });
  if (!firstPage.ok || firstPage.nextCursor === null)
    throw new Error("Expected two matching messages");
  const before = await fixture.store.readSurface(fixture.worldId, "control");

  await fixture.store.saveControlDraft(fixture.worldId, [
    ...before.map((file) =>
      file.path === "frame.yaml"
        ? { ...file, contents: frameWithArchive }
        : file,
    ),
    { path: "blocks/archive.md", contents: "# 档案\n" },
  ]);
  await fixture.store.applyControlDraft(fixture.worldId, prompt);

  expect(await fixture.store.currentHead(fixture.worldId)).toBe("commit:2");
  expect(modesOf(await listTurns(fixture.worldRoot))).toEqual([
    "play",
    "control_apply",
  ]);
  expect(
    (await fixture.store.readSurface(fixture.worldId, "control")).find(
      ({ path }) => path === "blocks/archive.md",
    )?.contents,
  ).toBe("# 档案\n");
  expect(
    (await searchHistory()).search({ cursor: firstPage.nextCursor }),
  ).toMatchObject({
    ok: true,
    matches: 2,
    nextCursor: null,
    messages: [{ message: { position: 1, isOpening: true } }],
  });

  await fixture.store.rewindPlayerRevision(fixture.worldId, "commit:1");

  expect(await fixture.store.readSurface(fixture.worldId, "control")).toEqual(
    before,
  );
});

test("control apply rechecks the confirmed draft against the latest state", async () => {
  const { store, worldId, worldRoot } = await world();
  const control = await store.readSurface(worldId, "control");
  const draft = control.map((file) =>
    file.path === "player-views.yaml"
      ? {
          ...file,
          contents: `format: narraeon.player-views/v1
views:
  - id: status
    title: Status
    items:
      - id: situation
        label: Situation
        select: { document: "@current-situation", locator: { yaml: [情况] } }
`,
        }
      : file,
  );

  store.freezeControl(worldId, "control-preview-running");
  const { fingerprint } = await store.saveControlDraft(worldId, draft);
  const preview = await store.previewControlDraft(worldId, prompt, fingerprint);
  expect(preview.diagnosticBinding.controlFingerprint).toBe(fingerprint);
  await expect(
    store.applyControlDraft(worldId, prompt, fingerprint),
  ).rejects.toMatchObject({
    code: "operation_conflict",
  });
  store.releaseControl(worldId, "control-preview-running");

  const before = initialSituation();
  const after = before.replace("情况: 安静", "状态: 安静");
  const hash = (contents: string) =>
    `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  await store.commitPlayStep({
    worldId,
    operationId: "remove-draft-only-view-source",
    parentHead: "genesis",
    historyAppend: [],
    nextMaterials: [],
    stateChanges: [
      {
        kind: "replace",
        documentId: "situation.current",
        stableShortRef: "current-situation",
        relativePath: "current-situation.yaml",
        codec: "yaml",
        expectedPreviousHash: hash(before),
        nextHash: hash(after),
        canonicalNextBytes: after,
      },
    ],
  });
  await expect(
    store.applyControlDraft(worldId, prompt, fingerprint),
  ).rejects.toThrow("Player views in the control draft cannot be applied");
  expect(await store.currentHead(worldId)).toBe("commit:1");
  expect(modesOf(await listTurns(worldRoot))).toEqual(["play"]);
  expect(await store.readSurface(worldId, "control")).toEqual(control);
});

test("the draft receipt also identifies text saved through the legacy Base64 field", async () => {
  const { store, worldId } = await world();
  const originals = await store.readSurface(worldId, "control");
  const rule = "# World rules\n\nRetain continuity.\n";
  const files = originals.map((file) =>
    file.path === "blocks/world.md"
      ? {
          ...file,
          encoding: "base64" as const,
          contents: Buffer.from(rule).toString("base64"),
        }
      : file,
  );

  const { fingerprint } = await store.saveControlDraft(worldId, files);
  const preview = await store.previewControlDraft(worldId, prompt, fingerprint);
  expect(preview.diagnosticBinding.controlFingerprint).toBe(fingerprint);
  await store.applyControlDraft(worldId, prompt, fingerprint);
  expect(await store.readSurface(worldId, "control")).toContainEqual({
    path: "blocks/world.md",
    contents: rule,
  });
});

const resourcePath = "assets/icon.bin";
const resourceBytes = Buffer.from([0xff, 0x00, 0xfe]);
const encodedResource = {
  path: resourcePath,
  contents: resourceBytes.toString("base64"),
  encoding: "base64" as const,
};

test("editing control text retains an opaque resource from an imported package", async () => {
  const { store, worldId, worldRoot } = await world(resourceBytes);
  const live = join(worldRoot, "control", resourcePath);
  const staged = join(worldRoot, "runtime/control-draft", resourcePath);
  expect(await readFile(live)).toEqual(resourceBytes);

  const before = await store.readSurface(worldId, "control");
  expect(before).toContainEqual(encodedResource);
  const files = before.map((file) =>
    file.path === "blocks/world.md"
      ? { ...file, contents: "# Updated rules\n" }
      : file,
  );
  const { fingerprint } = await store.saveControlDraft(worldId, files);
  expect(await readFile(staged)).toEqual(resourceBytes);
  expect(await readFile(live)).toEqual(resourceBytes);
  await expect(
    store.previewControlDraft(worldId, prompt, fingerprint),
  ).resolves.toMatchObject({
    diagnosticBinding: { controlFingerprint: fingerprint },
  });
  await store.applyControlDraft(worldId, prompt, fingerprint);

  expect(await readFile(live)).toEqual(resourceBytes);
  expect(await store.readSurface(worldId, "control")).toEqual(files);
  const turns = await listTurns(worldRoot);
  expect(modesOf(turns)).toEqual(["control_apply"]);
  expect(
    turns[0]?.files.filter(({ path }) => path.startsWith("control/")),
  ).toMatchObject([{ path: "control/blocks/world.md" }]);
  expect(await store.readSurface(worldId, "control", "genesis")).toEqual(
    before,
  );
  const fork = await store.deriveWorld({
    operationId: "fork-with-opaque-control-resource",
    sourceWorldId: worldId,
    sourceHead: "genesis",
    hostPresetId: "host",
  });
  expect(await readFile(join(fork.worldRoot, "control", resourcePath))).toEqual(
    resourceBytes,
  );
  await store.rewindPlayerRevision(worldId, "genesis");
  expect(await readFile(live)).toEqual(resourceBytes);
  expect(await store.readSurface(worldId, "control")).toEqual(before);
});

test("control draft receipts identify bytes rather than their decoded replacement characters or Base64 spelling", async () => {
  const { store, worldId, worldRoot } = await world(resourceBytes);
  const control = await store.readSurface(worldId, "control");
  const { fingerprint } = await store.saveControlDraft(
    worldId,
    control.map((file) =>
      file.path === resourcePath ? encodedResource : file,
    ),
  );
  const staged = join(worldRoot, "runtime/control-draft", resourcePath);
  expect(await readFile(staged)).toEqual(resourceBytes);
  // Simulate a draft persisted by an older Runtime before re-opening it here.
  await writeFile(staged, resourceBytes.toString("utf8"));
  await expect(
    store.previewControlDraft(worldId, prompt, fingerprint),
  ).rejects.toMatchObject({
    message: "World-control draft was replaced or removed",
  });
  await writeFile(staged, encodedResource.contents);
  await expect(
    store.applyControlDraft(worldId, prompt, fingerprint),
  ).rejects.toMatchObject({
    message: "World-control draft was replaced or removed",
  });
  await expect(store.applyControlDraft(worldId, prompt)).rejects.toThrow(
    /read-only/u,
  );
  expect(await store.currentHead(worldId)).toBe("genesis");
  expect(await readFile(join(worldRoot, "control", resourcePath))).toEqual(
    resourceBytes,
  );
});

test("saving a replacement, removal, or new opaque resource leaves the previous draft intact", async () => {
  const { store, worldId, worldRoot } = await world(resourceBytes);
  const before = await store.readSurface(worldId, "control");
  const text = before.filter(({ path }) => path !== resourcePath);
  const { fingerprint } = await store.saveControlDraft(worldId, before);

  for (const files of [
    text,
    [...text, { path: resourcePath, contents: "replacement" }],
    [
      ...text,
      { ...encodedResource, contents: Buffer.from([0xfe]).toString("base64") },
    ],
    [...before, { ...encodedResource, path: "assets/another.bin" }],
  ]) {
    const failure = await store
      .saveControlDraft(worldId, files)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeDomainError);
    if (!(failure instanceof RuntimeDomainError)) throw failure;
    const protocolError = failure.toProtocolError("world.control-draft.save");
    expect(protocolError).toMatchObject({
      code: "invalid_request",
      details: { reason: "control_resource_read_only" },
    });
    expect(protocolError?.message).toContain("Restore");
  }

  expect(
    await readFile(join(worldRoot, "runtime/control-draft", resourcePath)),
  ).toEqual(resourceBytes);
  await expect(
    store.previewControlDraft(worldId, prompt, fingerprint),
  ).resolves.toMatchObject({
    diagnosticBinding: { controlFingerprint: fingerprint },
  });
});

test("回退到较早的回退轮后可以重新打开和分叉", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "保留这句话。");
  await commitPlay(fixture, "commit:1", "第一次丢弃。");
  await fixture.store.rewindPlayerRevision(fixture.worldId, "commit:1");

  await commitPlay(fixture, "commit:1", "第二次丢弃。");
  await fixture.store.rewindPlayerRevision(fixture.worldId, "commit:3");

  const reopened = new FileNativeWorldStore(fixture.root);
  expect(await reopened.currentHead(fixture.worldId)).toBe("commit:1");
  expect(await reopened.recoverEndpoint(fixture.worldId, "commit:5")).toEqual(
    await reopened.recoverEndpoint(fixture.worldId, "commit:1"),
  );
  await expect(
    reopened.recoverEndpoint(fixture.worldId, "commit:3"),
  ).rejects.toMatchObject({
    code: "endpoint_discarded",
  });
  const fork = await reopened.deriveWorld({
    operationId: "fork-after-rewind",
    sourceWorldId: fixture.worldId,
    sourceHead: "commit:1",
    hostPresetId: "host",
  });
  expect(await reopened.recoverEndpoint(fork.world.worldId)).toEqual({
    ...(await reopened.recoverEndpoint(fixture.worldId)),
    worldId: fork.world.worldId,
  });
});

test("在修订之前的端点分叉：新世界的 control 等于该端点的控制，来源世界保持应用后的控制", async () => {
  const fixture = await world();
  const genesisControl = await fixture.store.readSurface(
    fixture.worldId,
    "control",
  );
  await applyRevision(fixture);

  const derived = await fixture.store.deriveWorld({
    operationId: "fork-before-revision",
    sourceWorldId: fixture.worldId,
    sourceHead: "genesis",
    hostPresetId: "host",
  });

  expect(
    await fixture.store.readSurface(derived.world.worldId, "control"),
  ).toEqual(genesisControl);
  expect(
    (await fixture.store.readSurface(fixture.worldId, "control")).map(
      ({ path }) => path,
    ),
  ).toContain("blocks/archive.md");
});

test("世界修订应用在推进中途崩溃：重启后 state 与 control 回到应用前，epoch 仍可再次应用，且只推进一次", async () => {
  const fixture = await world();
  const before = await snapshot(fixture.store, fixture.worldId);
  const epoch = await reviseWorldFiles(fixture);
  const changes = revisionChanges(epoch.files, before);

  vi.spyOn(fixture.store, "commitWorldRevisionApply").mockImplementationOnce(
    async () => {
      // 写入本轮记录并替换全部文件，然后在发布端点之前退出。
      await beginTurn(fixture.worldRoot, { mode: "revision_apply", changes });
      await applyChanges(fixture.worldRoot, changes);
      forgetLedger(fixture.worldRoot);
      throw new Error("process exited before the endpoint was published");
    },
  );
  await expect(
    fixture.workspace.apply(applyInput(fixture, epoch)),
  ).rejects.toThrow("process exited");

  // 重新打开世界时，未完成的轮先被回滚，再读取任何内容。
  const reopened = new FileNativeWorldStore(fixture.root);
  expect(await reopened.currentHead(fixture.worldId)).toBe("genesis");
  expect(await snapshot(reopened, fixture.worldId)).toEqual(before);

  const recovered = workspaceOn(fixture.root, reopened);
  expect((await recovered.latest(fixture.worldId))?.lifecycle).toBe("applying");
  const applied = await recovered.apply(applyInput(fixture, epoch));
  expect(applied).toMatchObject({
    lifecycle: "applied",
    apply: { phase: "committed", committedHead: "commit:1" },
  });
  expect(await reopened.currentHead(fixture.worldId)).toBe("commit:1");
  expect(modesOf(await listTurns(fixture.worldRoot))).toEqual([
    "revision_apply",
  ]);
  expect(
    (await reopened.readSurface(fixture.worldId, "control")).find(
      ({ path }) => path === "blocks/archive.md",
    )?.contents,
  ).toBe("# 档案\n");

  const afterRestart = new FileNativeWorldStore(fixture.root);
  expect(await afterRestart.currentHead(fixture.worldId)).toBe("commit:1");
  expect(await listTurns(fixture.worldRoot)).toHaveLength(1);
});

test("世界修订应用已发布但阶段未记录：重新应用返回同一提交，端点不再推进", async () => {
  const fixture = await world();
  const epoch = await reviseWorldFiles(fixture);
  const original = fixture.store.commitWorldRevisionApply.bind(fixture.store);

  vi.spyOn(fixture.store, "commitWorldRevisionApply").mockImplementationOnce(
    async (input) => {
      await original(input);
      throw new Error("process exited before the apply phase was recorded");
    },
  );
  await expect(
    fixture.workspace.apply(applyInput(fixture, epoch)),
  ).rejects.toThrow("process exited");
  expect(await fixture.store.currentHead(fixture.worldId)).toBe("commit:1");

  const reopened = new FileNativeWorldStore(fixture.root);
  const applied = await workspaceOn(fixture.root, reopened).apply(
    applyInput(fixture, epoch),
  );

  expect(applied).toMatchObject({
    lifecycle: "applied",
    apply: { phase: "committed", committedHead: "commit:1" },
  });
  expect(await reopened.currentHead(fixture.worldId)).toBe("commit:1");
  expect(await listTurns(fixture.worldRoot)).toHaveLength(1);
});

test("升级前的旧轮没有 control 前像：回退越过它们时 control 保持不变，不报错", async () => {
  const fixture = await world();
  await commitPlay(fixture, "genesis", "第一句。");
  // 旧版本的控制写入不经过账本：磁盘上的 control 已变化，而第 1 轮的记录里没有它的前像。
  await writeFile(
    join(fixture.worldRoot, "control/blocks/world.md"),
    "# 旧版本写入的控制\n",
  );

  await fixture.store.rewindPlayerRevision(fixture.worldId, "genesis");

  expect(await fixture.store.currentHead(fixture.worldId)).toBe("genesis");
  expect(
    (await fixture.store.readSurface(fixture.worldId, "control")).find(
      ({ path }) => path === "blocks/world.md",
    )?.contents,
  ).toBe("# 旧版本写入的控制\n");
});

test("src 中不再有控制目录的 staged／previous 交换与对应阶段记录", async () => {
  const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const forbidden =
    /replaceWorldRevisionControl|\.revision-control-|\.control-old-|\.control-apply-|state_committed|control_published/u;
  // The one-time v0.7.4 epoch upgrade is the only place that names the legacy phases (ADR-0034).
  const legacyUpgrade =
    "runtime/world-revision/LegacyWorldRevisionEpochUpgrade.ts";
  const offenders: string[] = [];
  for (const entry of await readdir(sourceRoot, { recursive: true })) {
    if (!/\.(?:ts|tsx)$/u.test(entry) || entry === legacyUpgrade) continue;
    const text = await readFile(join(sourceRoot, entry), "utf8");
    if (forbidden.test(text)) offenders.push(entry);
  }
  expect(offenders).toEqual([]);
});

async function commitPlay(
  fixture: Awaited<ReturnType<typeof world>>,
  parentHead: string,
  exactText: string,
): Promise<void> {
  playSteps += 1;
  await fixture.store.commitPlayStep({
    operationId: `play-step-${playSteps}`,
    worldId: fixture.worldId,
    parentHead,
    historyAppend: [{ role: "player", exactText }],
    nextMaterials: [],
    stateChanges: [],
  });
}

let playSteps = 0;

// 修订：状态改为“骚动”，并新建控制文档 D 且让 frame 引用它。
async function reviseWorldFiles(fixture: Awaited<ReturnType<typeof world>>) {
  const opened = await fixture.workspace.open(fixture.worldId);
  return fixture.workspace.replace({
    worldId: fixture.worldId,
    epochId: opened.epochId,
    expectedRevision: opened.revision,
    files: [
      ...opened.files.map((file) => {
        if (file.path === "state/current-situation.yaml")
          return {
            ...file,
            contents: file.contents.replace("情况: 安静", "情况: 骚动"),
          };
        if (file.path === "control/frame.yaml")
          return { ...file, contents: frameWithArchive };
        return file;
      }),
      { path: "control/blocks/archive.md", contents: "# 档案\n" },
    ],
  });
}

async function applyRevision(fixture: Awaited<ReturnType<typeof world>>) {
  const epoch = await reviseWorldFiles(fixture);
  return fixture.workspace.apply(applyInput(fixture, epoch));
}

function applyInput(
  fixture: Awaited<ReturnType<typeof world>>,
  epoch: { epochId: string; revision: string },
) {
  return {
    worldId: fixture.worldId,
    epochId: epoch.epochId,
    expectedRevision: epoch.revision,
  };
}

function workspaceOn(root: string, worlds: FileNativeWorldStore) {
  return new WorldRevisionWorkspace({
    store: new FileNativeWorldRevisionStore(root),
    worlds,
  });
}

// 崩溃现场要写入的改动：修订中与应用前不同的 state 与 control 文件。
function revisionChanges(
  files: readonly { path: string; contents: string }[],
  before: {
    state: readonly { path: string; contents: string }[];
    control: readonly { path: string; contents: string }[];
  },
): WorldTurnFileChange[] {
  const current = new Map<string, string>([
    ...before.state.map((file): [string, string] => [
      `state/${file.path}`,
      file.contents,
    ]),
    ...before.control.map((file): [string, string] => [
      `control/${file.path}`,
      file.contents,
    ]),
  ]);
  return files
    .filter(({ path }) => /^(?:state|control)\//u.test(path))
    .filter(({ path, contents }) => current.get(path) !== contents)
    .map(({ path, contents }) => ({ path, content: contents }));
}

function modesOf(turns: readonly { mode: string }[]): string[] {
  return turns.map(({ mode }) => mode);
}

async function snapshot(store: FileNativeWorldStore, worldId: string) {
  return {
    state: await store.readSurface(worldId, "state"),
    control: await store.readSurface(worldId, "control"),
  };
}

async function world(resource?: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-world-control-ledger-"));
  roots.push(root);
  const store = new FileNativeWorldStore(root);
  const fixture = [
    {
      path: "opening.md",
      contents:
        "The room falls quiet, leaving the present situation for your response.\n",
    },
    { path: "world/current-situation.yaml", contents: initialSituation() },
    { path: "control/frame.yaml", contents: frameV1 },
    { path: "control/blocks/world.md", contents: "# World Rules\n" },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
  const imported =
    resource === undefined
      ? null
      : await new ContentWorkspace(root).importPortableContentPackageArchive(
          createZip([
            ...fixture,
            { path: `control/${resourcePath}`, contents: resource },
          ]),
        );
  const created = await store.createFromContentPackage({
    operationId: `create-${roots.length}`,
    sourcePackageId: imported?.localId ?? "package",
    sourcePackageTitle: imported?.title ?? "Test content package",
    packageFiles: imported?.files ?? fixture,
    prompt,
  });
  const worldId = created.world.worldId;
  return {
    root,
    store,
    worldId,
    worldRoot: join(root, "worlds-file-native", worldId),
    workspace: workspaceOn(root, store),
  };
}

function initialSituation() {
  return `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前情境\n  summary: 当前局面。\n  aliases: []\n情况: 安静\n`;
}
