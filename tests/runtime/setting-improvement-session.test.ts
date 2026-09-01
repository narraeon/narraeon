import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ContentWorkspace } from "../../src/runtime/content/ContentWorkspace.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  ScriptedModelHost,
  type ModelHost,
  type ModelHostBinding,
  type ScriptedModelHostStep,
} from "../../src/runtime/model/ModelHost.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  builtinDefaultPlayPresetBinding,
  parsePlayPresetFiles,
  presetHostBinding,
  revisionForPlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativeSettingImprovementStore } from "../../src/runtime/setting/FileNativeSettingImprovementStore.ts";
import {
  SettingImprovementSession,
  contentFingerprint,
} from "../../src/runtime/setting/SettingImprovementSession.ts";

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

test("普通消息直接形成持久对话；首轮工具全集不随讨论或修改意图变化", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      text: "我们可以先梳理人物关系，不需要现在修改文件。",
      toolCalls: [],
    },
  ]);

  const view = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-discuss",
    message: "先讨论一下计划",
  });

  expect(view).toMatchObject({
    runStatus: "ready",
    draftVersion: 0,
    canApply: false,
    messages: [{ role: "user", text: "先讨论一下计划" }, { role: "assistant" }],
  });
  expect(fixture.host.requests).toHaveLength(1);
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
  ]);
  expect(fixture.host.requests[0]?.appended).toEqual([
    { kind: "user", text: "先讨论一下计划" },
  ]);
  const stored = await new FileNativeSettingImprovementStore(fixture.root).read(
    view.sessionId,
  );
  expect(stored.playPreset).toMatchObject({
    id: "builtin-default",
    revision: "builtin-default-v1",
  });
  expect(stored.review.preview).toMatchObject({
    diagnosticBinding: {
      playPresetId: "builtin-default",
      playPresetRevision: "builtin-default-v1",
    },
    initialAppend: {
      logical: { kind: "player", text: "Preview the setting draft." },
    },
  });
  expect(JSON.stringify(stored.review.preview)).not.toContain(
    "message.genesis.narrator",
  );

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    sessionId: view.sessionId,
    messages: view.messages,
    draftVersion: 0,
  });
});

test("升级后既有开放对话保留内容并自动换用当前 ref-only 工具契约", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "Existing conversation.", toolCalls: [] },
  ]);
  const view = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-before-tool-upgrade",
    message: "Keep this conversation.",
  });
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const legacy = await store.read(view.sessionId);
  legacy.bootstrap.logicalMessages[0]!.markdown = "legacy runtime contract";
  legacy.bootstrap.tools = legacy.bootstrap.tools.filter(
    ({ name }) => name !== "setting_create",
  );
  legacy.bootstrap.toolUniverse = legacy.bootstrap.toolUniverse.filter(
    ({ name }) => name !== "setting_create",
  );
  await store.save(legacy);

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    sessionId: view.sessionId,
    draftVersion: 0,
    messages: view.messages,
  });
  const upgraded = await store.read(view.sessionId);
  expect(upgraded.bootstrap.toolUniverse.map(({ name }) => name)).toContain(
    "setting_create",
  );
  expect(
    upgraded.bootstrap.logicalMessages.find(
      ({ role }) => role === "runtime_system",
    )?.markdown,
  ).toContain("Every write tool call settles independently");
  expect(JSON.stringify(upgraded.bootstrap)).not.toContain("$document.id");
});

test("重启后继续使用会话冻结的玩法预设语义和 Preview，而不跟随当前选择", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-setting-preset-"));
  roots.push(root);
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const frozenPreset = presetWithFrozenStateMarker();
  const firstHost = new ScriptedModelHost({
    binding,
    steps: [{ outcome: "response", text: "We can continue.", toolCalls: [] }],
  });
  const first = serviceFor(root, content, firstHost, frozenPreset);
  const started = await first.send({
    packageId: created.localId,
    requestId: "request-freeze-preset",
    message: "Start with this preset.",
  });
  expect(JSON.stringify(firstHost.requests[0]?.bootstrap)).toContain(
    "FROZEN-PRESET-STATE-MARKER",
  );

  const nextHost = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-recovery-lore",
            name: "setting_create",
            arguments: {
              path: "world/lore/recovery.md",
              ref: "recovery",
              title: "Recovery",
              summary: "Confirms the frozen preset survives restart.",
              aliases: [],
              body: "# Recovery\n\nStill frozen.\n",
            },
          },
        ],
      },
      { outcome: "response", text: "The draft is updated.", toolCalls: [] },
    ],
  });
  const restartedWithDifferentCurrentPreset = serviceFor(
    root,
    content,
    nextHost,
    builtinDefaultPlayPresetBinding("en"),
  );
  const continued = await restartedWithDifferentCurrentPreset.send({
    packageId: created.localId,
    requestId: "request-after-preset-change",
    message: "Add one recovery note.",
  });

  expect(continued.sessionId).toBe(started.sessionId);
  expect(JSON.stringify(nextHost.requests[0]?.bootstrap)).toContain(
    "FROZEN-PRESET-STATE-MARKER",
  );
  expect(continued.review.preview?.diagnosticBinding).toMatchObject({
    playPresetId: frozenPreset.id,
    playPresetRevision: frozenPreset.revision,
  });
});

test("工具响应更新隔离草稿、自动检查，再由用户精确版本 Apply", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      text: "",
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
            contents:
              "Rain needles the night wharf. A ferryman raises his lamp.",
          },
        },
      ],
    },
    {
      outcome: "response",
      text: "已经把开场改成雨夜码头，草稿检查通过。",
      toolCalls: [],
    },
  ]);
  const before = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );

  const view = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-write",
    message: "直接把开场改成雨夜码头",
  });

  expect(view).toMatchObject({
    runStatus: "ready",
    draftVersion: 1,
    canApply: true,
    review: {
      status: "usable",
      diff: [{ path: "opening.md", kind: "modify" }],
    },
  });
  expect(fixture.host.requests).toHaveLength(2);
  expect(
    fixture.host.requests[1]?.appended.filter(({ kind }) => kind === "tool"),
  ).toHaveLength(2);
  expect(
    (await fixture.content.readCurrentTreeContentPackage(fixture.packageId))
      .files,
  ).toEqual(before.files);

  const applied = await fixture.session.apply(
    view.sessionId,
    view.draftVersion,
  );
  expect(applied.lifecycle).toBe("applied");
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toContain("night wharf");
  await expect(
    fixture.session.apply(view.sessionId, view.draftVersion),
  ).resolves.toMatchObject({ lifecycle: "applied" });
});

test("Provider 失败不会删除会话或最后完整草稿，重启后可继续发普通消息", async () => {
  const fixture = await createFixture([
    { outcome: "failure", message: "Anthropic SSE content block did not end" },
  ]);
  const failed = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-broken-stream",
    message: "继续完善",
  });
  expect(failed).toMatchObject({
    runStatus: "interrupted",
    draftVersion: 0,
    lastFailure: "Anthropic SSE content block did not end",
    messages: [{ role: "user", text: "继续完善" }],
  });

  const nextHost = new ScriptedModelHost({
    binding,
    steps: [
      {
        outcome: "response",
        text: "上次回复中断了；草稿没有丢，我们可以从这里继续。",
        toolCalls: [],
      },
    ],
  });
  const restarted = serviceFor(fixture.root, fixture.content, nextHost);
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    sessionId: failed.sessionId,
    runStatus: "interrupted",
    draftVersion: 0,
  });
  const continued = await restarted.send({
    packageId: fixture.packageId,
    requestId: "request-after-restart",
    message: "那就继续",
  });
  expect(continued).toMatchObject({
    runStatus: "ready",
    messages: [
      { role: "user" },
      { role: "user", text: "那就继续" },
      { role: "assistant" },
    ],
  });
});

test("真实共享 ModelHost 的 Anthropic 未闭合 content block 不执行草稿工具", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-setting-anthropic-sse-"));
  roots.push(root);
  const content = new ContentWorkspace(root, { locale: () => "en" });
  const created = await content.createCurrentTreeContentPackage();
  const before = await content.readCurrentTreeContentPackage(created.localId);
  const event = (name: string, value: unknown): string =>
    `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      [
        event("message_start", {
          type: "message_start",
          message: {
            id: "incomplete-setting-response",
            role: "assistant",
            model: "claude-test",
            content: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "partial-write",
            name: "setting_write_file",
            input: {},
          },
        }),
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"path":"opening.md","contents":"must not be applied"}',
          },
        }),
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 4 },
        }),
        event("message_stop", { type: "message_stop" }),
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
  const host = new FileNativeModelHost(
    {
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude-test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 4_096,
    },
    fetch_,
  );
  const session = serviceFor(root, content, host);

  await expect(
    session.send({
      packageId: created.localId,
      requestId: "request-incomplete-anthropic",
      message: "修改开场",
    }),
  ).resolves.toMatchObject({
    runStatus: "interrupted",
    draftVersion: 0,
    review: { diff: [] },
    lastFailure:
      "Anthropic Messages was dispatched but its streaming response could not be confirmed",
  });
  expect(fetch_).toHaveBeenCalledOnce();
  expect(
    (await content.readCurrentTreeContentPackage(created.localId)).files,
  ).toEqual(before.files);
});

test("内容包基线在对话外变化后，Apply fail-closed 且不覆盖新内容", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Draft opening." },
        },
      ],
    },
    { outcome: "response", text: "草稿已更新。", toolCalls: [] },
  ]);
  const view = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-stale",
    message: "修改开场",
  });
  const external = await fixture.content.readCurrentTreeContentPackage(
    fixture.packageId,
  );
  const opening = external.files.find(({ path }) => path === "opening.md")!;
  opening.contents = "A newer manual edit.";
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    external.files,
  );

  await expect(
    fixture.session.apply(view.sessionId, view.draftVersion),
  ).rejects.toThrow(/changed after this conversation started/u);
  expect(
    (
      await fixture.content.readCurrentTreeContentPackage(fixture.packageId)
    ).files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe("A newer manual edit.");
});

test("重启会结算已持久化的完整工具响应且只执行一次", async () => {
  const fixture = await createFixture([
    { outcome: "response", text: "可以，等你决定。", toolCalls: [] },
  ]);
  const initial = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-before-crash",
    message: "先讨论",
  });
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stored = await store.read(initial.sessionId);
  stored.messages.push({
    id: "message-crashed-user",
    role: "user",
    text: "现在修改开场",
    createdAt: Date.now(),
  });
  stored.modelItems.push(
    { kind: "user", text: "现在修改开场" },
    {
      kind: "assistant",
      text: "",
      providerState: {
        protocol: "chat_completions",
        assistantMessage: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "recovery-read",
              type: "function",
              function: {
                name: "setting_read",
                arguments: '{"path":"opening.md"}',
              },
            },
            {
              id: "recovery-write",
              type: "function",
              function: {
                name: "setting_write_file",
                arguments:
                  '{"path":"opening.md","contents":"Recovered draft opening."}',
              },
            },
          ],
        },
      },
      toolCalls: [
        {
          id: "recovery-read",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "recovery-write",
          name: "setting_write_file",
          arguments: {
            path: "opening.md",
            contents: "Recovered draft opening.",
          },
        },
      ],
    },
  );
  stored.runStatus = "running";
  stored.activeRequestId = "request-crashed-after-response";
  await store.save(stored);

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  const recovered = await restarted.read(fixture.packageId);
  expect(recovered).toMatchObject({
    runStatus: "interrupted",
    draftVersion: 1,
    progress: { toolCalls: 2 },
    review: {
      status: "usable",
      diff: [{ path: "opening.md", after: "Recovered draft opening." }],
    },
  });
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    draftVersion: 1,
    progress: { toolCalls: 2 },
  });
});

test("重启会把已替换当前树但未写回执的 Apply 恢复为已应用", async () => {
  const fixture = await createFixture([
    {
      outcome: "response",
      toolCalls: [
        {
          id: "read-opening",
          name: "setting_read",
          arguments: { path: "opening.md" },
        },
        {
          id: "write-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: "Applied before crash." },
        },
      ],
    },
    { outcome: "response", text: "草稿已更新。", toolCalls: [] },
  ]);
  const view = await fixture.session.send({
    packageId: fixture.packageId,
    requestId: "request-apply-recovery",
    message: "修改开场",
  });
  const store = new FileNativeSettingImprovementStore(fixture.root);
  const stored = await store.read(view.sessionId);
  stored.applyRequest = {
    expectedDraftVersion: stored.draftVersion,
    draftFingerprint: contentFingerprint(stored.draft.files),
  };
  await store.save(stored);
  await fixture.content.replaceCurrentTreeContentPackage(
    fixture.packageId,
    stored.draft.files,
  );

  const restarted = serviceFor(
    fixture.root,
    fixture.content,
    new ScriptedModelHost({ binding, steps: [] }),
  );
  await expect(restarted.read(fixture.packageId)).resolves.toMatchObject({
    lifecycle: "applied",
    baseStatus: "current",
  });
  await expect(restarted.read(fixture.packageId)).resolves.toBeNull();
});

async function createFixture(steps: ScriptedModelHostStep[]) {
  const root = await mkdtemp(join(tmpdir(), "narraeon-setting-conversation-"));
  roots.push(root);
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
    bindPlayPreset: () => Promise.resolve(structuredClone(playPreset)),
    preview: (snapshot, modelBinding, frozenPreset) => {
      if (frozenPreset === undefined)
        throw new Error(
          "New setting-improvement sessions must freeze a preset",
        );
      const openingMessage = "setting-draft.message.genesis.narrator";
      const opening = snapshot.files.find(({ path }) => path === "opening.md");
      return compiler.preview(
        {
          endpoint: { id: "setting-draft", commit: "draft" },
          hostBinding: presetHostBinding(frozenPreset),
          world: {
            controlFingerprint: "setting-draft",
            documentSnapshot: snapshot,
            history: { [openingMessage]: opening?.contents ?? "" },
            additionalMaterials: [
              { kind: "history_message", message: openingMessage },
            ],
          },
          playerInputPlacement: "append",
          playerInput: "Preview the setting draft.",
          modelBinding,
        },
        frozenPreset,
      );
    },
  });
}

function presetWithFrozenStateMarker(): PlayPresetBinding {
  const base = builtinDefaultPlayPresetBinding("en");
  const files = structuredClone(base.files);
  files["blocks/state.md"] =
    `${files["blocks/state.md"]}\n\nFROZEN-PRESET-STATE-MARKER\n`;
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "preset-frozen-test",
    name: "Frozen test preset",
    revision: revisionForPlayPresetFiles(files),
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}
