import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import { runPlayFollowupRequests } from "../../src/runtime/play/PlayFollowupRequests.ts";
import { projectArtifactForFrontend } from "../../src/runtime/extension/FrontendExtensionBundle.ts";
import * as builtinCatalog from "../../src/shared/ordered-followups.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import {
  FileNativePlayPresetStore,
  applyPlayPresetStructuredEditor,
  parsePlayPresetFiles,
  toPlayPresetStructuredEditor,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

describe("后置请求编排", () => {
  test("停用保留旧定义及资源，保存后的实际编译不派发，重新启用恢复", () => {
    const parsed = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
    if (parsed.kind !== "valid") throw parsed.error;
    const structure = toPlayPresetStructuredEditor(parsed.definition);
    expect(structure.followupItems).toEqual([
      { id: "player_options", kind: "user", enabled: true },
      { id: "builtin:summary", kind: "builtin", enabled: false },
      { id: "package:followups", kind: "content-package", enabled: true },
    ]);
    structure.followupItems![0]!.enabled = false;
    const files = applyPlayPresetStructuredEditor(
      firstPartyActionChoicesPresetFiles,
      structure,
    );
    const saved = parsePlayPresetFiles(files);
    if (saved.kind !== "valid") throw saved.error;
    expect(saved.definition.followups).toEqual(parsed.definition.followups);
    expect(files["prompts/action-choices.md"]).toBe(
      firstPartyActionChoicesPresetFiles["prompts/action-choices.md"],
    );
    const preview = new FileNativePromptCompiler().previewPlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "test",
        contextWindowTokens: 128000,
        maxOutputTokens: 16000,
        playerInput: "hello",
        playerInputPlacement: "append",
      }),
      {
        id: "test",
        name: "test",
        revision: "test",
        files,
        definition: saved.definition,
        scriptsEnabled: true,
      },
    );
    expect(preview.playPreset?.followups).toEqual([]);
  });
});

test("系统引用及组不能删除或伪造正文；编排只允许引用完整用户定义", () => {
  const parsed = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  if (parsed.kind !== "valid") throw parsed.error;
  const structure = toPlayPresetStructuredEditor(parsed.definition);
  for (const kind of ["builtin", "content-package", "user"]) {
    expect(() =>
      applyPlayPresetStructuredEditor(firstPartyActionChoicesPresetFiles, {
        ...structure,
        followupItems: structure.followupItems!.filter(
          (item) => item.kind !== kind,
        ),
      }),
    ).toThrow();
  }
  const files = applyPlayPresetStructuredEditor(
    firstPartyActionChoicesPresetFiles,
    structure,
  );
  expect(
    parsePlayPresetFiles({
      ...files,
      "call-chain.yaml": files["call-chain.yaml"]!.replace(
        "kind: builtin",
        "kind: builtin\n    body: forged",
      ),
    }).kind,
  ).toBe("invalid");
  expect(
    parsePlayPresetFiles({
      ...files,
      "call-chain.yaml": files["call-chain.yaml"]!.replace(
        "enabled: false",
        "enabled: wrong",
      ),
    }).kind,
  ).toBe("invalid");
});

test("系统示例和用户请求按位置编译，空内容包不增加派发，旧绑定保持精确结构", () => {
  const parsed = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  if (parsed.kind !== "valid") throw parsed.error;
  const original = structuredClone(parsed.definition);
  const structure = toPlayPresetStructuredEditor(parsed.definition);
  structure.followupItems = [
    { id: "builtin:summary", kind: "builtin", enabled: true },
    { id: "package:followups", kind: "content-package", enabled: true },
    { id: "player_options", kind: "user", enabled: true },
  ];
  const files = applyPlayPresetStructuredEditor(
    firstPartyActionChoicesPresetFiles,
    structure,
  );
  const saved = parsePlayPresetFiles(files);
  if (saved.kind !== "valid") throw saved.error;
  const compiler = new FileNativePromptCompiler();
  const preview = compiler.previewPlayPreset(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      playerInput: "hello",
      playerInputPlacement: "append",
    }),
    {
      id: "test",
      name: "test",
      revision: "test",
      files,
      definition: saved.definition,
      scriptsEnabled: true,
    },
  );
  expect(preview.playPreset?.followups.map((item) => item.id)).toEqual([
    "builtin:summary",
    "player_options",
  ]);
  expect(
    preview.playPreset?.followups[0]?.logicalMessages[0]?.markdown,
  ).toContain("brief scene recap");
  expect(preview.playPreset?.followups[0]?.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);
  expect(parsed.definition).toEqual(original);
  const restored = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  expect(restored).toEqual({ kind: "valid", definition: original });
});

test("已迁移预设拒绝原始保存降级删除系统示例，重启和导出保留关闭定义", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-ordered-followups-"));
  try {
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "Ordered followups",
      firstPartyActionChoicesPresetFiles,
    );
    const structure = created.preset.structure!;
    structure.followupItems![0]!.enabled = false;
    const saved = await store.save({
      presetId: created.preset.id,
      name: created.preset.name,
      files: created.preset.files,
      structure,
    });
    await store.select(created.preset.id);
    await expect(
      store.save({
        presetId: created.preset.id,
        name: created.preset.name,
        files: {
          ...(saved.preset.draft?.files ?? saved.preset.files),
          "call-chain.yaml":
            firstPartyActionChoicesPresetFiles["call-chain.yaml"]!,
        },
      }),
    ).rejects.toThrow();
    const restarted = new FileNativePlayPresetStore(root);
    const binding = await restarted.bindRevision(created.preset.id);
    expect(binding.definition.followupItems?.[0]?.enabled).toBe(false);
    expect(binding.files).toEqual(
      saved.preset.draft?.files ?? saved.preset.files,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("内置更新改变新编译，用户克隆及已编译快照仍保留原文", () => {
  const example = builtinCatalog.builtinFollowupExample("en");
  const parsed = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  if (parsed.kind !== "valid") throw parsed.error;
  const structure = toPlayPresetStructuredEditor(parsed.definition);
  structure.followups.push({
    ...example.definition,
    id: "my_copy",
    prompt: { role: "author_instruction", path: "prompts/my-copy.md" },
    artifacts: example.definition.artifacts.map((artifact) => ({
      ...artifact,
      channel: "my.copy",
    })),
  });
  structure.followupItems!.push({ id: "my_copy", kind: "user", enabled: true });
  structure.followupItems!.find((item) => item.kind === "builtin")!.enabled =
    true;
  const files = applyPlayPresetStructuredEditor(
    {
      ...firstPartyActionChoicesPresetFiles,
      "prompts/my-copy.md": example.body,
    },
    structure,
  );
  const saved = parsePlayPresetFiles(files);
  if (saved.kind !== "valid") throw saved.error;
  const binding = {
    id: "test",
    name: "test",
    revision: "test",
    files,
    definition: saved.definition,
    scriptsEnabled: true,
  };
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "test",
    contextWindowTokens: 128000,
    maxOutputTokens: 16000,
    playerInput: "hello",
    playerInputPlacement: "append",
  });
  const compiler = new FileNativePromptCompiler();
  const previous = compiler.previewPlayPreset(input, binding).playPreset!;
  const spy = vi
    .spyOn(builtinCatalog, "builtinFollowupExample")
    .mockReturnValue({ ...example, body: "UPDATED APPLICATION EXAMPLE" });
  try {
    const current = compiler.previewPlayPreset(input, binding).playPreset!;
    expect(
      current.followups.find((item) => item.id === "builtin:summary")!
        .logicalMessages[0]!.markdown,
    ).toContain("UPDATED APPLICATION EXAMPLE");
    expect(
      current.followups.find((item) => item.id === "my_copy")!
        .logicalMessages[0]!.markdown,
    ).toContain(example.body);
    expect(
      previous.followups.find((item) => item.id === "builtin:summary")!
        .logicalMessages[0]!.markdown,
    ).toContain(example.body);
    expect(
      previous.followups.find((item) => item.id === "builtin:summary")!
        .logicalMessages[0]!.markdown,
    ).not.toContain("UPDATED APPLICATION EXAMPLE");
  } finally {
    spy.mockRestore();
  }
});

test("系统身份实际派发并冷恢复产物；应用修改产物声明不改变历史显示", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-builtin-followup-"));
  const parsed = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  if (parsed.kind !== "valid") throw parsed.error;
  const structure = toPlayPresetStructuredEditor(parsed.definition);
  structure.followupItems!.forEach((item) => {
    item.enabled = item.kind !== "user";
  });
  const files = applyPlayPresetStructuredEditor(
    firstPartyActionChoicesPresetFiles,
    structure,
  );
  const saved = parsePlayPresetFiles(files);
  if (saved.kind !== "valid") throw saved.error;
  const binding = {
    id: "test",
    name: "test",
    revision: "test",
    files,
    definition: saved.definition,
    scriptsEnabled: false,
  };
  const preview = new FileNativePromptCompiler().previewPlayPreset(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      playerInput: "hello",
      playerInputPlacement: "append",
    }),
    binding,
  );
  const host = new ScriptedModelHost({
    binding: {
      provider: "chat_completions",
      endpointFingerprint: "test",
      modelId: "test",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      protocolConfigFingerprint: "test",
    },
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "emit",
            name: "artifact_emit",
            arguments: { output: "recap", payload: "Frozen recap" },
          },
        ],
      },
    ],
  });
  try {
    const run = await runPlayFollowupRequests({
      artifacts: new FileNativeArtifactStore(root),
      modelHost: host,
      followups: preview.playPreset!.followups,
      bootstrap: preview.compilation,
      prefix: [],
      toolStrategy: preview.compilation.toolStrategy,
      context: {
        worldId: "world",
        parentHead: "genesis",
        operationId: "run",
        playPresetId: binding.id,
        playPresetRevision: binding.revision,
        playPresetScriptsEnabled: false,
      },
      head: "commit:1",
      maxOutputTokens: 16000,
    });
    expect(run.outcomes).toMatchObject([
      { id: "builtin:summary", toolCalls: [{ ok: true }] },
    ]);
    const example = builtinCatalog.builtinFollowupExample("en");
    const spy = vi
      .spyOn(builtinCatalog, "builtinFollowupExample")
      .mockReturnValue({
        ...example,
        definition: {
          ...example.definition,
          artifacts: [
            { ...example.definition.artifacts[0]!, name: "new_output" },
          ],
        },
      });
    try {
      const records = await new FileNativeArtifactStore(
        root,
      ).readActiveProjection("world");
      expect(records).toHaveLength(1);
      expect(records[0]?.requestId).toBe("builtin:summary");
      expect(projectArtifactForFrontend(records[0]!, binding)).toMatchObject({
        status: "ready",
        mount: "story",
        declaration: { outputName: "recap" },
      });
      expect(projectArtifactForFrontend(records[0]!, null)).toMatchObject({
        status: "ready",
        mount: "story",
        declaration: { outputName: "recap" },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
