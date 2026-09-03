import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { contentTreeFingerprint } from "../../src/runtime/content/ContentTreeFingerprint.ts";
import {
  ScriptedModelHost,
  type ModelHost,
  type ModelHostBinding,
  type ScriptedModelHostStep,
} from "../../src/runtime/model/ModelHost.ts";
import {
  builtinDefaultPlayPresetBinding,
  presetHostBinding,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeSettingImprovementStore } from "../../src/runtime/setting/FileNativeSettingImprovementStore.ts";
import { SettingAuthoringTransaction } from "../../src/runtime/setting/SettingAuthoringTransaction.ts";
import { SettingImprovementSession } from "../../src/runtime/setting/SettingImprovementSession.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const binding: ModelHostBinding = {
  provider: "chat_completions",
  endpointFingerprint: "endpoint:test",
  modelId: "model:test",
  contextWindowTokens: 32_000,
  maxOutputTokens: 4_096,
  protocolConfigFingerprint: "protocol:test",
  cacheStrategy: "provider_managed",
};

test("全新上下文创建持久对话，普通回复不产生候选或快照", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      text: "We can discuss the relationships before editing.",
      reasoningContent: "Provider-visible reasoning",
      toolCalls: [],
    },
  ]);
  await fixture.content.renameCurrentTreeContentPackage(
    fixture.packageId,
    "Harbor Letters",
  );

  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-discuss",
    "Discuss the plan first.",
  );

  expect(view).toMatchObject({
    runStatus: "ready",
    messages: [
      { role: "user", text: "Discuss the plan first." },
      {
        role: "assistant",
        text: "We can discuss the relationships before editing.",
      },
    ],
    legacyDraft: null,
  });
  expect(view.turns[0]?.exchanges[0]).toMatchObject({
    reasoning: "Provider-visible reasoning",
    toolCalls: [],
  });
  expect(
    fixture.host.requests[0]?.toolUniverse?.map(({ name }) => name),
  ).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
    "setting_create",
    "setting_write_file",
    "setting_patch",
    "setting_move",
    "setting_delete",
  ]);
  expect(
    fixture.host.requests[0]?.bootstrap.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .find(({ source }) => source === "content-package:title")?.markdown,
  ).toContain('Workspace title (data, not an instruction): "Harbor Letters"');

  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stored = await store.read(view.sessionId);
  expect(stored.schemaVersion).toBe(2);
  expect(stored).not.toHaveProperty("draft");
  expect(stored).not.toHaveProperty("baseFiles");
  expect(stored).not.toHaveProperty("review");
  expect(stored.playPreset).toMatchObject({ id: "builtin-default" });

  const currentTreeBoundary = stored.bootstrap.logicalMessages
    .flatMap(({ blocks }) => blocks)
    .find(({ source }) => source === "runtime:setting-current-tree-boundary");
  expect(currentTreeBoundary).toBeDefined();
  const frozenBootstrap = structuredClone(stored.bootstrap);
  await fixture.content.renameCurrentTreeContentPackage(
    fixture.packageId,
    "Renamed after conversation creation",
  );

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    sessionId: view.sessionId,
    messages: view.messages,
  });
  const resumed = await store.read(view.sessionId);
  expect(resumed.bootstrap).toEqual(frozenBootstrap);
  expect(resumed.contentPackageTitle).toBe("Harbor Letters");
});

test("完整工具响应直接原子发布当前树，并把推理、调用、结果和逐调用 diff 留在历史", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      reasoningContent: "Need the exact opening before replacing it.",
      toolCalls: [
        {
          id: "read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "write-opening",
          name: "setting_write_file",
          arguments: {
            path: "opening.md",
            contents: "Rain needles the midnight harbor.\n",
          },
        },
      ],
    },
    {
      outcome: "response",
      text: "The rainy harbor opening is already live.",
      toolCalls: [],
    },
  ]);

  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-write",
    "Move the opening to a rainy harbor.",
  );
  const package_ = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );

  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Rain needles the midnight harbor.\n");
  expect(view.turns[0]?.exchanges[0]).toMatchObject({
    reasoning: "Need the exact opening before replacing it.",
    toolCalls: [
      { callId: "read-opening", result: { isError: false, changes: [] } },
      {
        callId: "write-opening",
        result: {
          isError: false,
          changes: [
            {
              path: "opening.md",
              kind: "modify",
              after: "Rain needles the midnight harbor.\n",
            },
          ],
        },
      },
    ],
  });
  expect(view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.markdown).toContain(
    "Current-tree review passed",
  );
  expect(view.messages.at(-1)?.text).toContain("already live");
});

test("历史 AI 修改可按文件回滚到精确前像，重试保持幂等且对话历史不变", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "rollback-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "rollback-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "AI changed opening.\n" },
        },
      ],
    },
    { outcome: "response", text: "The edit is live.", toolCalls: [] },
  ]);
  const before = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const beforeOpening = before.files.find(
    ({ path }) => path === "opening.md",
  )!.contents;
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-rollback",
    "Change the opening",
  );
  const changeSetId =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changeSetId;
  expect(changeSetId).toMatch(/^change-set:[0-9]+$/u);
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted write did not expose a rollback identity");

  const rolledBack = await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId,
    path: "opening.md",
  });
  expect(rolledBack).toEqual({
    status: "rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [
      {
        path: "opening.md",
        kind: "modify",
        before: "AI changed opening.\n",
        after: beforeOpening,
      },
    ],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(beforeOpening);
  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: view.sessionId,
      changeSetId,
      path: "opening.md",
    }),
  ).resolves.toEqual({
    status: "already_rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [],
  });
  await expect(
    fixture.session.readSession(fixture.packageId, view.sessionId),
  ).resolves.toMatchObject({ turns: view.turns });
});

test("所选文件后来被修改时仍直接覆盖为历史前像", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "conflict-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "conflict-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "AI edit.\n" },
        },
      ],
    },
    { outcome: "response", text: "Done.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-conflicting-rollback",
    "Change the opening",
  );
  const changeSetId =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changeSetId;
  const beforeOpening =
    view.turns[0]?.exchanges[0]?.toolCalls[1]?.result?.changes[0]?.before;
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted write did not expose a rollback identity");
  if (beforeOpening === null || beforeOpening === undefined)
    throw new Error("The accepted write did not retain its previous file");
  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    current.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Later manual edit.\n" }
        : file,
    ),
  );

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: view.sessionId,
      changeSetId,
      path: "opening.md",
    }),
  ).resolves.toEqual({
    status: "rolled_back",
    changeSetId,
    path: "opening.md",
    changes: [
      {
        path: "opening.md",
        kind: "modify",
        before: "Later manual edit.\n",
        after: beforeOpening,
      },
    ],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(beforeOpening);
});

test("move 的两个文件变化可以分别选择回滚", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-rollback-note",
          name: "setting_create",
          arguments: {
            path: "world/notes/rollback.yaml",
            ref: "rollback-note",
            title: "Rollback note",
            summary: "A note used to verify atomic move rollback.",
            aliases: [],
            body: "status: active\n",
          },
        },
        {
          id: "move-rollback-note",
          name: "setting_move",
          arguments: {
            from: "@rollback-note",
            to: "world/archive/rollback.yaml",
          },
        },
      ],
    },
    { outcome: "response", text: "Moved.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-move-rollback",
    "Create and move a note",
  );
  const move = view.turns[0]?.exchanges[0]?.toolCalls[1]?.result;
  expect(move?.changes).toHaveLength(2);
  if (move?.changeSetId === null || move?.changeSetId === undefined)
    throw new Error("The accepted move did not expose a rollback identity");

  await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId: move.changeSetId,
    path: "world/notes/rollback.yaml",
  });
  const afterSourceRollback = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files.map(({ path }) => path);
  expect(afterSourceRollback).toContain("world/notes/rollback.yaml");
  expect(afterSourceRollback).toContain("world/archive/rollback.yaml");

  await fixture.session.rollback({
    packageId: fixture.packageId,
    sessionId: view.sessionId,
    changeSetId: move.changeSetId,
    path: "world/archive/rollback.yaml",
  });
  const afterDestinationRollback = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files.map(({ path }) => path);
  expect(afterDestinationRollback).toContain("world/notes/rollback.yaml");
  expect(afterDestinationRollback).not.toContain("world/archive/rollback.yaml");
});

test("回滚所选删除文件会直接恢复历史前像", async () => {
  const path = "world/notes/deleted-rollback.yaml";
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-delete-rollback-note",
          name: "setting_create",
          arguments: {
            path,
            ref: "deleted-rollback",
            title: "Deleted rollback note",
            summary: "A note used to verify delete rollback.",
            aliases: [],
            body: "status: active\n",
          },
        },
      ],
    },
    { outcome: "response", text: "Created.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "delete-rollback-note",
          name: "setting_delete",
          arguments: { document: "@deleted-rollback" },
        },
      ],
    },
    { outcome: "response", text: "Deleted.", toolCalls: [] },
  ]);
  const created = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-create-delete-rollback",
    "Create a temporary note",
  );
  const deleted = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-delete-rollback",
    message: "Delete the temporary note",
    continuation: {
      kind: "continue_context",
      sessionId: created.sessionId,
    },
  });
  const deletion = deleted.turns[1]?.exchanges[0]?.toolCalls[0]?.result;
  const before = deletion?.changes[0]?.before;
  if (deletion?.changeSetId === null || deletion?.changeSetId === undefined)
    throw new Error("The accepted delete did not expose a rollback identity");
  if (before === null || before === undefined)
    throw new Error("The accepted delete did not retain its previous file");

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: deleted.sessionId,
      changeSetId: deletion.changeSetId,
      path,
    }),
  ).resolves.toEqual({
    status: "rolled_back",
    changeSetId: deletion.changeSetId,
    path,
    changes: [{ path, kind: "create", before: null, after: before }],
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find((file) => file.path === path)?.contents,
  ).toBe(before);
});

test("所选创建文件即使已有后来引用也直接回滚", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "create-referenced-rollback-note",
          name: "setting_create",
          arguments: {
            path: "world/notes/referenced-rollback.yaml",
            ref: "referenced-rollback",
            title: "Referenced rollback note",
            summary: "A note that receives a later reference.",
            aliases: [],
            body: "status: active\n",
          },
        },
      ],
    },
    { outcome: "response", text: "Created.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read-situation-before-reference",
          name: "setting_read",
          arguments: { path: "@current-situation" },
        },
        {
          id: "add-later-reference",
          name: "setting_patch",
          arguments: {
            document: "@current-situation",
            op: "add",
            locator: ["rollbackReference"],
            value: { $ref: "@referenced-rollback" },
          },
        },
      ],
    },
    { outcome: "response", text: "Referenced.", toolCalls: [] },
  ]);
  const created = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-create-referenced-rollback",
    "Create the note",
  );
  const changeSetId =
    created.turns[0]?.exchanges[0]?.toolCalls[0]?.result?.changeSetId;
  if (changeSetId === null || changeSetId === undefined)
    throw new Error("The accepted create did not expose a rollback identity");
  await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-add-later-reference",
    message: "Reference the note",
    continuation: {
      kind: "continue_context",
      sessionId: created.sessionId,
    },
  });

  await expect(
    fixture.session.rollback({
      packageId: fixture.packageId,
      sessionId: created.sessionId,
      changeSetId,
      path: "world/notes/referenced-rollback.yaml",
    }),
  ).resolves.toMatchObject({
    status: "rolled_back",
    path: "world/notes/referenced-rollback.yaml",
  });
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.some(({ path }) => path === "world/notes/referenced-rollback.yaml"),
  ).toBe(false);
});

test("默认可继续精确历史上下文，显式全新上下文创建第二段对话", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First answer.", toolCalls: [] },
    { outcome: "response", text: "Fresh answer.", toolCalls: [] },
    { outcome: "response", text: "Continued first answer.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-first",
    "First context",
  );
  const fresh = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-fresh",
    "Fresh context",
  );
  expect(fresh.sessionId).not.toBe(first.sessionId);

  const resumed = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-resume-first",
    message: "Continue the first context",
    continuation: { kind: "continue_context", sessionId: first.sessionId },
  });
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.messages.map(({ text }) => text)).toEqual([
    "First context",
    "First answer.",
    "Continue the first context",
    "Continued first answer.",
  ]);
  expect(fixture.host.requests[2]?.appended).toEqual(
    expect.arrayContaining([
      { kind: "user", text: "First context" },
      expect.objectContaining({ kind: "assistant", text: "First answer." }),
      { kind: "user", text: "Continue the first context" },
    ]),
  );

  const overview = await fixture.session.overview(fixture.packageId);
  expect(overview.latest?.sessionId).toBe(first.sessionId);
  expect(overview.history.map(({ sessionId }) => sessionId)).toEqual([
    first.sessionId,
    fresh.sessionId,
  ]);
  await expect(
    fixture.session.readSession(fixture.packageId, fresh.sessionId),
  ).resolves.toMatchObject({ sessionId: fresh.sessionId });
});

test("另一个对话改动当前树后，旧对话的读取授权失效并要求重新读取", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "a-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
      ],
    },
    { outcome: "response", text: "I read it.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "b-read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "b-write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Changed by B.\n" },
        },
      ],
    },
    { outcome: "response", text: "B changed it.", toolCalls: [] },
    {
      outcome: "response",
      toolCalls: [
        {
          id: "a-stale-write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Stale A write.\n" },
        },
      ],
    },
    { outcome: "response", text: "I need to reread it.", toolCalls: [] },
  ]);
  const conversationA = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-a-read",
    "Read the opening",
  );
  await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-b-write",
    "Change the opening",
  );
  const resumedA = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-a-stale-write",
    message: "Now replace it without reading again",
    continuation: {
      kind: "continue_context",
      sessionId: conversationA.sessionId,
    },
  });

  expect(
    resumedA.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result,
  ).toMatchObject({ isError: true, changes: [] });
  expect(
    resumedA.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result?.markdown,
  ).toContain("Read opening.md completely before replacing it");
  const package_ = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Changed by B.\n");
});

test("全新上下文的 requestId 可幂等重试且不会创建重复历史", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Only once.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-idempotent",
    "Only once",
  );
  const retry = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-idempotent",
    "Only once",
  );
  expect(retry.sessionId).toBe(first.sessionId);
  expect(fixture.host.requests).toHaveLength(1);
  expect(
    (await fixture.session.overview(fixture.packageId)).history,
  ).toHaveLength(1);
});

test("完整工具响应若缺少原树结算意图，恢复会失败关闭而不在更新的树上重放", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Seed response.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-unconfirmed-seed",
    "Seed a conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const damaged = await store.read(view.sessionId);
  const seedAssistant = damaged.modelItems.find(
    (item) => item.kind === "assistant",
  );
  if (
    seedAssistant?.kind !== "assistant" ||
    seedAssistant.providerState === undefined
  )
    throw new Error("Seed response did not retain Provider continuation state");
  const now = Date.now();
  damaged.messages.push({
    id: "message-unconfirmed-tool-step",
    role: "user",
    text: "Replace the opening",
    createdAt: now,
  });
  damaged.modelItems.push(
    { kind: "user", text: "Replace the opening" },
    {
      kind: "assistant",
      text: "",
      providerState: seedAssistant.providerState,
      toolCalls: [
        {
          id: "unconfirmed-write",
          name: "setting_write_file",
          arguments: {
            path: "opening.md",
            contents: "Must never be replayed.\n",
          },
        },
      ],
    },
  );
  damaged.runStatus = "running";
  damaged.activeRequestId = "request-unconfirmed-write";
  damaged.pendingSettlement = null;
  damaged.updatedAt = now;
  await store.save(damaged);

  const current = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    current.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Newer current-tree edit.\n" }
        : file,
    ),
  );

  const recovered = await serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  ).readSession(fixture.packageId, view.sessionId);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Newer current-tree edit.\n");
  expect(recovered.turns.at(-1)?.exchanges[0]?.toolCalls[0]).toMatchObject({
    callId: "unconfirmed-write",
    result: {
      isError: true,
      changes: [],
    },
  });
  expect(
    recovered.turns.at(-1)?.exchanges[0]?.toolCalls[0]?.result?.markdown,
  ).toContain("without the persisted current-tree revision");
  expect((await store.read(view.sessionId)).pendingSettlement).toBeNull();
});

test("完整工具响应和原树指纹落盘后，重启只在该 revision 上继续结算", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Seed response.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-confirmed-seed",
    "Seed a conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const confirmed = await store.read(view.sessionId);
  const seedAssistant = confirmed.modelItems.find(
    (item) => item.kind === "assistant",
  );
  if (
    seedAssistant?.kind !== "assistant" ||
    seedAssistant.providerState === undefined
  )
    throw new Error("Seed response did not retain Provider continuation state");
  const files = (
    await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
  ).files;
  const now = Date.now();
  confirmed.messages.push({
    id: "message-confirmed-tool-step",
    role: "user",
    text: "Replace the opening",
    createdAt: now,
  });
  confirmed.modelItems.push({ kind: "user", text: "Replace the opening" });
  const assistantItemIndex = confirmed.modelItems.length;
  confirmed.modelItems.push({
    kind: "assistant",
    text: "",
    providerState: seedAssistant.providerState,
    toolCalls: [
      {
        id: "confirmed-read",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "confirmed-write",
        name: "setting_write_file",
        arguments: {
          path: "opening.md",
          contents: "Recovered from confirmed response.\n",
        },
      },
    ],
  });
  confirmed.runStatus = "running";
  confirmed.activeRequestId = "request-confirmed-tool-step";
  confirmed.pendingSettlement = {
    phase: "response_confirmed",
    assistantItemIndex,
    beforeFingerprint: contentTreeFingerprint(files),
  };
  confirmed.updatedAt = now;
  await store.save(confirmed);

  const recovered = await serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  ).readSession(fixture.packageId, view.sessionId);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Recovered from confirmed response.\n");
  expect(recovered.turns.at(-1)?.exchanges[0]?.toolCalls[1]).toMatchObject({
    callId: "confirmed-write",
    result: {
      isError: false,
      changes: [
        { path: "opening.md", after: "Recovered from confirmed response.\n" },
      ],
    },
  });
  expect((await store.read(view.sessionId)).pendingSettlement).toBeNull();
});

test("发布前中断留下结算意图；重启只重放完整工具响应并补齐收据", async () => {
  const root = await temporaryRoot("narraeon-setting-recovery-");
  let failPublish = true;
  const interruptedContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        if (!failPublish) return;
        failPublish = false;
        throw new Error("simulated crash before current-tree publish");
      },
    },
  });
  const created = await interruptedContent.createCurrentTreeContentPackage();
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-before-crash",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write-before-crash",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "Recovered change.\n" },
          },
        ],
      },
    ],
  });
  const interrupted = serviceFor(root, interruptedContent, host);
  const failed = await sendFresh(
    interrupted,
    created.localId,
    "request-crash",
    "Change the opening",
  );
  expect(failed.runStatus).toBe("interrupted");
  const pending = await new FileNativeSettingImprovementStore(root).read(
    failed.sessionId,
  );
  expect(pending.pendingSettlement).not.toBeNull();

  const recoveredContent = new ContentWorkspace(root, { locale: () => "en" });
  const restarted = serviceFor(
    root,
    recoveredContent,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  const recovered = await restarted.readSession(
    created.localId,
    failed.sessionId,
  );
  expect(recovered.runStatus).toBe("interrupted");
  const recoveredCalls = recovered.turns[0]?.exchanges[0]?.toolCalls;
  expect(recoveredCalls?.[0]).toMatchObject({
    callId: "read-before-crash",
    result: { isError: false },
  });
  expect(recoveredCalls?.[1]).toMatchObject({
    callId: "write-before-crash",
    result: {
      isError: false,
      changes: [{ path: "opening.md" }],
    },
  });
  const package_ = await recoveredContent.readCurrentTreeContentPackage(
    created.localId,
  );
  expect(
    package_.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("Recovered change.\n");
  expect(
    (await new FileNativeSettingImprovementStore(root).read(failed.sessionId))
      .pendingSettlement,
  ).toBeNull();
});

test("当前树已发布但收据未落盘时，重启确认既有结算而不重复发布", async () => {
  const root = await temporaryRoot("narraeon-setting-after-publish-");
  let interruptPublish = true;
  const interruptedContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        if (!interruptPublish) return;
        interruptPublish = false;
        throw new Error("simulated crash after settlement intent");
      },
    },
  });
  const created = await interruptedContent.createCurrentTreeContentPackage();
  const interrupted = serviceFor(
    root,
    interruptedContent,
    new ScriptedModelHost({
      binding,
      steps: [
        {
          outcome: "response",
          toolCalls: [
            {
              id: "read-published-opening",
              name: "setting_read",
              arguments: { path: "opening.md" },
            },
            {
              id: "write-published-opening",
              name: "setting_write_file",
              arguments: {
                path: "opening.md",
                contents: "Already published change.\n",
              },
            },
          ],
        },
      ],
    }),
  );
  const failed = await sendFresh(
    interrupted,
    created.localId,
    "request-after-publish",
    "Change the opening",
  );
  const store = new FileNativeSettingImprovementStore(root);
  const pending = await store.read(failed.sessionId);
  expect(pending.pendingSettlement).not.toBeNull();

  const before = await interruptedContent.readCurrentTreeContentPackage(
    created.localId,
  );
  await interruptedContent.replaceCurrentTreeContentPackage(
    created.localId,
    before.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Already published change.\n" }
        : file,
    ),
  );

  let repeatedPublish = false;
  const recoveredContent = new ContentWorkspace(root, {
    locale: () => "en",
    currentTree: {
      beforeCurrentTreeReplace: () => {
        repeatedPublish = true;
        throw new Error("recovery must not publish an already-current tree");
      },
    },
  });
  const recovered = await serviceFor(
    root,
    recoveredContent,
    new ScriptedModelHost({ binding, steps: [] }),
  ).readSession(created.localId, failed.sessionId);

  expect(repeatedPublish).toBe(false);
  expect(recovered.turns[0]?.exchanges[0]?.toolCalls[1]).toMatchObject({
    callId: "write-published-opening",
    result: {
      isError: false,
      changes: [{ path: "opening.md", after: "Already published change.\n" }],
    },
  });
  expect((await store.read(failed.sessionId)).pendingSettlement).toBeNull();
});

test("当前树限制只拒绝越界调用，不回滚同响应中已接受的写入", async () => {
  const root = await temporaryRoot("narraeon-setting-limit-rejection-");
  const content = new ContentWorkspace(root, {
    locale: () => "en",
    limits: { maxFileBytes: 1_024, maxTotalBytes: 8_192 },
  });
  const created = await content.createCurrentTreeContentPackage();
  const openingBefore = (
    await content.readCurrentTreeContentPackage(created.localId)
  ).files.find(({ path }) => path === "opening.md")!.contents;
  const host = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "read-before-oversized-write",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "accepted-write",
            name: "setting_write_file",
            arguments: {
              path: "opening.md",
              contents: "Accepted sibling change.\n",
            },
          },
          {
            id: "oversized-write",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: "x".repeat(1_100) },
          },
        ],
      },
      {
        outcome: "response",
        text: "The valid edit is live; the oversized sibling was rejected.",
        toolCalls: [],
      },
    ],
  });
  const view = await sendFresh(
    serviceFor(root, content, host),
    created.localId,
    "request-oversized-write",
    "Replace the opening with a very long draft",
  );

  expect(openingBefore).not.toBe("Accepted sibling change.\n");
  expect(
    (await content.readCurrentTreeContentPackage(created.localId)).files.find(
      ({ path }) => path === "opening.md",
    )?.contents,
  ).toBe("Accepted sibling change.\n");
  expect(view.turns[0]?.exchanges[0]?.toolCalls).toMatchObject([
    { callId: "read-before-oversized-write", result: { isError: false } },
    {
      callId: "accepted-write",
      result: {
        isError: false,
        changes: [{ path: "opening.md", after: "Accepted sibling change.\n" }],
      },
    },
    {
      callId: "oversized-write",
      result: { isError: true, changes: [] },
    },
  ]);
  expect(view.turns[0]?.exchanges[0]?.toolCalls[2]?.result?.markdown).toContain(
    "size limit",
  );
  expect(host.requests[1]?.appended.at(-1)).toMatchObject({
    kind: "tool",
    toolCallId: "oversized-write",
    isError: true,
  });
  expect(
    (await new FileNativeSettingImprovementStore(root).read(view.sessionId))
      .pendingSettlement,
  ).toBeNull();
});

test("schema-v1 隔离草稿严格迁移为审计历史，不改当前树", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Legacy seed.", toolCalls: [] },
  ]);
  const current = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-legacy-seed",
    "Seed",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const v2 = await store.read(current.sessionId);
  const packageBefore = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const openingBefore = packageBefore.files.find(
    ({ path }) => path === "opening.md",
  )!.contents;
  const legacyDraftFiles = packageBefore.files.map((file) =>
    file.path === "opening.md"
      ? { ...file, contents: "Unapplied legacy candidate.\n" }
      : file,
  );
  const legacyPreset = builtinDefaultPlayPresetBinding("en");
  const legacyPreview = new SettingAuthoringTransaction({
    baseFiles: legacyDraftFiles,
    locale: "en",
    preview: (snapshot) => {
      const openingMessage = "legacy-setting-authoring.genesis";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return new FileNativePromptCompiler({ locale: "en" }).preview(
        {
          endpoint: { id: "legacy-setting", commit: "draft-v1" },
          hostBinding: presetHostBinding(legacyPreset),
          world: {
            controlFingerprint: "legacy-setting",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Inspect the legacy setting draft.",
          modelBinding: binding,
        },
        legacyPreset,
      );
    },
  }).review().preview;
  expect(legacyPreview).not.toBeNull();
  const legacyBootstrap = structuredClone(v2.bootstrap);
  const legacyRuntime = legacyBootstrap.logicalMessages.find(
    ({ role }) => role === "runtime_system",
  )!;
  legacyRuntime.markdown =
    "# Legacy isolated draft\n\nAll writes enter an isolated draft and require Apply.";
  legacyRuntime.blocks = [
    {
      source: "runtime:setting-draft-boundary",
      markdown: legacyRuntime.markdown,
    },
  ];
  legacyBootstrap.provider.messages = [
    {
      role: "system",
      content:
        "# Legacy isolated draft\n\nAll writes enter an isolated draft and require Apply.",
    },
    ...legacyBootstrap.provider.messages.filter(
      ({ role }) => role !== "system",
    ),
  ];
  const legacy = {
    schemaVersion: 1,
    sessionId: v2.sessionId,
    packageId: v2.packageId,
    contentPackageTitle: v2.contentPackageTitle,
    locale: v2.locale,
    lifecycle: "open",
    runStatus: "running",
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    baseFingerprint: contentTreeFingerprint(packageBefore.files),
    baseFiles: packageBefore.files,
    draftVersion: 1,
    draft: {
      files: legacyDraftFiles,
      readWorldDocumentIds: [],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["opening.md"],
    },
    review: {
      status: "usable",
      diff: [
        {
          path: "opening.md",
          kind: "modify",
          before: openingBefore,
          after: "Unapplied legacy candidate.\n",
        },
      ],
      diagnostics: [],
      preview: legacyPreview,
      playCoverage: null,
    },
    bootstrap: legacyBootstrap,
    modelBinding: v2.modelBinding,
    modelItems: v2.modelItems,
    messages: v2.messages,
    usage: v2.usage,
    exchange: v2.exchange,
    toolCalls: v2.toolCalls,
    activeRequestId: "legacy-in-flight-request",
    completedRequestIds: v2.completedRequestIds,
    lastFailure: null,
    applyRequest: null,
    appliedAt: null,
  };
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${v2.sessionId}.json`,
  );
  await mkdir(dirname(path), { recursive: true });
  const malformedLegacySources = [
    { ...legacy, lifecycle: "unknown" },
    {
      ...legacy,
      review: { ...legacy.review, diff: [{ path: 7 }] },
    },
    {
      ...legacy,
      modelItems: [
        ...legacy.modelItems,
        { kind: "assistant", text: "Missing required toolCalls" },
      ],
    },
  ];
  for (const malformed of malformedLegacySources) {
    await writeFile(path, `${JSON.stringify(malformed)}\n`, "utf8");
    await expect(
      new FileNativeSettingImprovementStore(fixture.root).read(v2.sessionId),
    ).rejects.toThrow("Legacy setting-improvement conversation is damaged");
    await expect(
      readFile(
        join(
          fixture.root,
          "setting-improvements",
          "sessions",
          `${v2.sessionId}.schema-v1.json`,
        ),
        "utf8",
      ),
    ).rejects.toThrow();
  }
  const legacySource = `${JSON.stringify(legacy)}\n`;
  await writeFile(path, legacySource, "utf8");

  const continuedHost = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        text: "Continued against the current tree.",
        toolCalls: [],
      },
    ],
  });
  const restarted = serviceFor(fixture.root, fixture.content, continuedHost);
  const migrated = await restarted.readSession(fixture.packageId, v2.sessionId);
  expect(migrated.legacyDraft).toMatchObject({
    outcome: "unapplied_dropped",
    changes: [{ path: "opening.md", after: "Unapplied legacy candidate.\n" }],
  });
  expect(migrated.runStatus).toBe("interrupted");
  const packageAfter = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  expect(
    packageAfter.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(openingBefore);
  await expect(
    readFile(
      join(
        fixture.root,
        "setting-improvements",
        "sessions",
        `${v2.sessionId}.schema-v1.json`,
      ),
      "utf8",
    ),
  ).resolves.toBe(legacySource);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    schemaVersion: 2,
  });
  const migratedStored = await new FileNativeSettingImprovementStore(
    fixture.root,
  ).read(v2.sessionId);
  expect(migratedStored.completedRequestIds).toContain(
    "legacy-in-flight-request",
  );
  expect(migratedStored.playPreset).toBeUndefined();
  expect(JSON.stringify(migratedStored.bootstrap)).toContain(
    "Legacy isolated draft",
  );
  expect(migratedStored.modelItems).toEqual(v2.modelItems);
  const migratedSystemMessages = migratedStored.bootstrap.provider.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => String(content));
  expect(migratedSystemMessages).toEqual([
    expect.stringContaining("Legacy isolated draft"),
    expect.stringContaining("Runtime system contract replaces"),
  ]);
  expect(
    migratedStored.bootstrap.logicalMessages.find(
      ({ role }) => role === "runtime_system",
    )?.markdown,
  ).toContain("Runtime system contract replaces");

  await restarted.send({
    packageId: fixture.packageId,
    requestId: "legacy-in-flight-request",
    message: "Do not resend this unknown legacy request",
    continuation: { kind: "continue_context", sessionId: v2.sessionId },
  });
  expect(continuedHost.requests).toHaveLength(0);

  await restarted.send({
    packageId: fixture.packageId,
    requestId: "request-continue-migrated",
    message: "Continue this old conversation",
    continuation: { kind: "continue_context", sessionId: v2.sessionId },
  });
  expect(continuedHost.requests[0]?.bootstrap).toEqual(
    migratedStored.bootstrap,
  );
  expect(continuedHost.requests[0]?.appended.at(-1)).toEqual({
    kind: "user",
    text: "Continue this old conversation",
  });

  const receiptCases = [
    { current: "base", expected: "unapplied_dropped" },
    { current: "draft", expected: "applied" },
    { current: "other", expected: "apply_outcome_unknown" },
  ] as const;
  for (const receiptCase of receiptCases) {
    const created = await fixture.content.createCurrentTreeContentPackage();
    const base = await fixture.content.readCurrentTreeContentPackage(
      created.localId,
    );
    const baseOpening = base.files.find(
      ({ path }) => path === "opening.md",
    )!.contents;
    const draftFiles = base.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Legacy Apply target.\n" }
        : file,
    );
    const otherFiles = base.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Unrelated later current tree.\n" }
        : file,
    );
    if (receiptCase.current !== "base")
      await fixture.content.replaceCurrentTreeContentPackage(
        created.localId,
        receiptCase.current === "draft" ? draftFiles : otherFiles,
      );
    const receiptSessionId = store.createId();
    const receiptLegacy = {
      ...legacy,
      sessionId: receiptSessionId,
      packageId: created.localId,
      contentPackageTitle: created.title,
      runStatus: "ready",
      baseFingerprint: contentTreeFingerprint(base.files),
      baseFiles: base.files,
      draft: {
        ...legacy.draft,
        files: draftFiles,
      },
      review: {
        ...legacy.review,
        diff: [
          {
            path: "opening.md",
            kind: "modify",
            before: baseOpening,
            after: "Legacy Apply target.\n",
          },
        ],
      },
      activeRequestId: null,
      completedRequestIds: [],
      applyRequest: {
        expectedDraftVersion: legacy.draftVersion,
        draftFingerprint: contentTreeFingerprint(draftFiles),
      },
    };
    const receiptPath = join(
      fixture.root,
      "setting-improvements",
      "sessions",
      `${receiptSessionId}.json`,
    );
    await writeFile(receiptPath, `${JSON.stringify(receiptLegacy)}\n`, "utf8");
    const currentBeforeMigration = contentTreeFingerprint(
      (await fixture.content.readCurrentTreeContentPackage(created.localId))
        .files,
    );

    const receiptMigrated = await new FileNativeSettingImprovementStore(
      fixture.root,
      { content: fixture.content },
    ).read(receiptSessionId);

    expect(receiptMigrated.legacyDraft?.outcome).toBe(receiptCase.expected);
    expect(
      contentTreeFingerprint(
        (await fixture.content.readCurrentTreeContentPackage(created.localId))
          .files,
      ),
    ).toBe(currentBeforeMigration);
    if (receiptCase.expected === "apply_outcome_unknown")
      expect(receiptMigrated.lastFailure).toContain("cannot be proven");
  }
});

test("状态轮询只返回所选对话的轻量进度和持久 revision", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Done.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-status",
    "Status",
  );
  const status = await fixture.session.status(
    fixture.packageId,
    view.sessionId,
  );
  expect(status).toMatchObject({
    selected: {
      sessionId: view.sessionId,
      runStatus: "ready",
      progress: { exchange: 1, toolCalls: 0 },
    },
  });
  expect(status.revision).not.toBe("");
  expect(JSON.stringify(status)).not.toContain("Done.");
  expect(JSON.stringify(status)).not.toContain("opening.md");
});

test("删除历史对话只移除会话文件，不改内容包当前树", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "First conversation.", toolCalls: [] },
    { outcome: "response", text: "Second conversation.", toolCalls: [] },
  ]);
  const first = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-delete-first",
    "Keep this first conversation",
  );
  const second = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-delete-second",
    "Keep this second conversation",
  );
  const before = contentTreeFingerprint(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  );

  const overview = await fixture.session.deleteSession(
    fixture.packageId,
    first.sessionId,
  );

  expect(overview.latest?.sessionId).toBe(second.sessionId);
  expect(overview.history.map(({ sessionId }) => sessionId)).toEqual([
    second.sessionId,
  ]);
  await expect(
    new FileNativeSettingImprovementStore(fixture.root).read(first.sessionId),
  ).rejects.toThrow("does not exist");
  expect(
    contentTreeFingerprint(
      (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
        .files,
    ),
  ).toBe(before);
});

test("正在接收 Provider 响应的对话不能被历史删除", async () => {
  const root = await temporaryRoot("narraeon-setting-delete-running-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scripted = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "Finished.", toolCalls: [] }],
  });
  const host: ModelHost = {
    binding: () => scripted.binding(),
    exchange: (request, observer) => {
      started.resolve();
      return release.promise.then(() => scripted.exchange(request, observer));
    },
  };
  const session = serviceFor(root, content, host);
  const sending = sendFresh(
    session,
    created.localId,
    "request-delete-running",
    "Wait before answering",
  );
  await started.promise;
  const running = await session.overview(created.localId);
  const sessionId = running.latest?.sessionId;
  if (sessionId === undefined) throw new Error("Running session was not saved");

  await expect(
    session.deleteSession(created.localId, sessionId),
  ).rejects.toThrow("cannot be deleted");
  release.resolve();
  await sending;
  await expect(
    session.deleteSession(created.localId, sessionId),
  ).resolves.toMatchObject({ latest: null, history: [] });
});

test("schema-v2 对未知字段和损坏的非 opaque 结构 fail closed", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Codec seed.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-v2-codec",
    "Create a strict codec fixture",
  );
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    view.sessionId,
  );
  const path = join(
    fixture.root,
    "setting-improvements",
    "sessions",
    `${view.sessionId}.json`,
  );
  const pendingModelItems = [
    ...stored.modelItems,
    { kind: "user", text: "Pending write" } as const,
    {
      kind: "assistant",
      text: "",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: { role: "assistant", content: null },
      },
      toolCalls: [
        {
          id: "pending-write",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Pending\n" },
        },
      ],
    } as const,
  ];
  const validPreparedSettlement = {
    phase: "publication_prepared" as const,
    assistantItemIndex: pendingModelItems.length - 1,
    beforeFingerprint: "sha256:before",
    afterFingerprint: "sha256:after",
    toolResults: [
      {
        toolCallId: "pending-write",
        markdown: "# Current-tree write accepted",
        isError: false,
        changes: [],
      },
    ],
    authorization: {
      revision: "sha256:after",
      readWorldDocumentIds: [],
      readableDamagedWorldPaths: [],
      readOpaquePaths: ["opening.md"],
    },
  };
  const validPendingSession = {
    ...stored,
    runStatus: "interrupted" as const,
    modelItems: pendingModelItems,
    pendingSettlement: validPreparedSettlement,
  };
  await writeFile(path, `${JSON.stringify(validPendingSession)}\n`, "utf8");
  await expect(
    new FileNativeSettingImprovementStore(fixture.root).read(view.sessionId),
  ).resolves.toMatchObject({
    pendingSettlement: { phase: "publication_prepared" },
  });
  const damaged: unknown[] = [
    { ...stored, unknownRootField: true },
    { ...stored, bootstrap: { ...stored.bootstrap, unknownBootstrapField: 1 } },
    { ...stored, usage: { ...stored.usage, totalTokens: "invalid" } },
    {
      ...stored,
      pendingSettlement: {
        phase: "response_confirmed",
        assistantItemIndex: 0,
        beforeFingerprint: "sha256:before",
        unknownSettlementField: true,
      },
    },
    {
      ...validPendingSession,
      pendingSettlement: {
        ...validPreparedSettlement,
        toolResults: [
          {
            ...validPreparedSettlement.toolResults[0],
            toolCallId: "different-call",
          },
        ],
      },
    },
    {
      ...validPendingSession,
      pendingSettlement: {
        ...validPreparedSettlement,
        authorization: {
          ...validPreparedSettlement.authorization,
          revision: "sha256:not-after",
        },
      },
    },
  ];
  for (const value of damaged) {
    await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
    await expect(
      new FileNativeSettingImprovementStore(fixture.root).read(view.sessionId),
    ).rejects.toThrow(
      "Setting-improvement conversation does not match its durable schema",
    );
  }
});

test("恢复写入使用 CAS，过期副本不能覆盖更新后的对话", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Durable answer.", toolCalls: [] },
  ]);
  const view = await sendFresh(
    fixture.session,
    fixture.packageId,
    "request-cas",
    "Create one durable conversation",
  );
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stale = await store.read(view.sessionId);
  const newer = structuredClone(stale);
  newer.lastFailure = "newer state";
  newer.updatedAt += 1;
  await store.save(newer);
  const staleRecovery = structuredClone(stale);
  staleRecovery.lastFailure = "stale recovery";
  staleRecovery.updatedAt += 2;

  await expect(store.saveIfUnchanged(stale, staleRecovery)).resolves.toBe(
    false,
  );
  await expect(store.read(view.sessionId)).resolves.toMatchObject({
    lastFailure: "newer state",
  });
});

async function createFixture(steps: ScriptedModelHostStep[]) {
  const root = await temporaryRoot("narraeon-setting-conversation-");
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const host = new ScriptedModelHost({ binding, steps });
  return {
    root,
    content,
    packageId: created.localId,
    host,
    session: serviceFor(root, content, host),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sendFresh(
  session: SettingImprovementSession,
  packageId: string,
  requestId: string,
  message: string,
) {
  return session.send({
    packageId,
    requestId,
    message,
    continuation: { kind: "fresh_context" },
  });
}

function serviceFor(
  root: string,
  content: ContentWorkspace,
  host: ModelHost,
  playPreset: PlayPresetBinding = builtinDefaultPlayPresetBinding("en"),
): SettingImprovementSession {
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  return new SettingImprovementSession({
    store: new FileNativeSettingImprovementStore(root),
    content,
    compiler,
    locale: () => "en",
    bindModelHost: () => Promise.resolve(host),
    bindExistingModelHost: (frozenBinding) => {
      if (JSON.stringify(frozenBinding) !== JSON.stringify(host.binding()))
        throw new Error("Frozen model binding is unavailable");
      return Promise.resolve(host);
    },
    bindPlayPreset: () => Promise.resolve(structuredClone(playPreset)),
    preview: (snapshot, modelBinding, frozenPreset) => {
      if (frozenPreset === undefined)
        throw new Error(
          "New setting-improvement conversations freeze a preset",
        );
      const openingMessage = "setting-authoring.message.genesis.narrator";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return compiler.preview(
        {
          endpoint: { id: "setting-authoring", commit: "current-tree" },
          hostBinding: presetHostBinding(frozenPreset),
          world: {
            controlFingerprint: "setting-authoring",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Inspect the content package current tree.",
          modelBinding,
        },
        frozenPreset,
      );
    },
  });
}
