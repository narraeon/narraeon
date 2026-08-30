import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import { parseV1Envelope } from "../../src/protocol/v1.ts";
import {
  defaultPlayPresetFiles,
  defaultPlayPresetFilesForLocale,
  FileNativePlayPresetStore,
  maxPlayPresetFollowups,
  applyPlayPresetStructuredEditor,
  parsePlayPresetFiles,
  parsePlayPresetStructuredEditor,
  settingImprovementPromptForBinding,
  toPlayPresetStructuredEditor,
  validatePlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  buildPlayPresetWorkbenchSnapshot,
  simulateArtifactProjection,
} from "../../src/runtime/play/PlayPresetWorkbench.ts";
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";
import { firstPartyGenericPanelsPresetFiles } from "../../src/shared/first-party-generic-panels.ts";
import {
  defaultSettingImprovementPrompt,
  defaultSettingImprovementPromptPath,
} from "../../src/shared/default-setting-improvement-prompt.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  renderPromptDeltaMessage,
  scanRuntimeLeakage,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("文件原生玩法预设", () => {
  test("only the Runtime-owned default preset follows the saved locale", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-locale-"));
    roots.push(root);
    let locale: AppLocale = "en";
    const store = new FileNativePlayPresetStore(root, {
      locale: () => locale,
    });
    await store.initialize();

    const original = (await store.list()).presets[0]!;
    expect(original.files).toEqual(defaultPlayPresetFilesForLocale("en"));
    const copied = await store.copy(original.id);

    locale = "zh-CN";
    await store.syncBuiltinDefaultLocale();
    let library = await store.list();
    expect(library.presets.find(({ id }) => id === original.id)?.files).toEqual(
      defaultPlayPresetFilesForLocale("zh-CN"),
    );
    expect(
      library.presets.find(({ id }) => id === copied.preset.id)?.files,
    ).toEqual(defaultPlayPresetFilesForLocale("en"));

    await store.save({
      presetId: original.id,
      name: original.name,
      files: defaultPlayPresetFilesForLocale("zh-CN"),
    });
    locale = "en";
    await store.syncBuiltinDefaultLocale();
    library = await store.list();
    expect(library.presets.find(({ id }) => id === original.id)?.files).toEqual(
      defaultPlayPresetFilesForLocale("zh-CN"),
    );
  });

  test("提示块只接受作者 role，追加消息使用稳定署名", () => {
    expect(renderPromptDeltaMessage("author_instruction", "Author text")).toBe(
      "# Author instruction\n\nAuthor text",
    );
    expect(() =>
      renderPromptDeltaMessage("world_context", "Fake material"),
    ).toThrow(/invalid appended role/u);

    const invalid = structuredClone(defaultPlayPresetFiles);
    invalid["call-chain.yaml"] = invalid["call-chain.yaml"]!.replace(
      "  - markdown: prompts/narrate.md",
      "  - { role: world_context, markdown: prompts/narrate.md }",
    );
    expect(parsePlayPresetFiles(invalid)).toMatchObject({
      kind: "invalid",
      error: {
        code: "prompt_role_invalid",
        message: "A play prompt block may use only the author_instruction role",
      },
    });
  });

  test("工作台身份管理支持同名、停用、重命名、复制、选择和删除语义", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-play-workbench-identity-"),
    );
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const original = (await store.list()).presets[0]!;
    const first = await store.create("同名玩法");
    const second = await store.copy(first.preset.id);
    expect(second.preset.name).toBe(first.preset.name);
    expect(second.preset.id).not.toBe(first.preset.id);
    await store.rename(second.preset.id, "同名玩法");
    await store.select(second.preset.id);
    expect((await store.list()).currentPresetId).toBe(second.preset.id);
    await store.setEnabled(second.preset.id, false);
    expect((await store.list()).currentPresetId).toBe(original.id);
    await expect(store.select(second.preset.id)).rejects.toMatchObject({
      code: "preset_disabled",
    });
    await store.setEnabled(second.preset.id, true);
    await store.delete(first.preset.id);
    expect((await store.list()).presets.map(({ id }) => id)).toEqual(
      expect.arrayContaining([original.id, second.preset.id]),
    );
    await store.delete(second.preset.id);
    await expect(store.setEnabled(original.id, false)).rejects.toMatchObject({
      code: "cannot_disable_current_preset",
    });
  });

  test("删空玩法预设库会重建默认预设，而不是拒绝删除最后一份", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-delete-last-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const original = (await store.list()).presets[0]!;
    const deleted = await store.delete(original.id);
    const library = await store.list();
    expect(library.presets).toHaveLength(1);
    expect(library.presets[0]!.id).not.toBe(original.id);
    expect(library.currentPresetId).toBe(library.presets[0]!.id);
    expect(deleted.currentPresetId).toBe(library.currentPresetId);
    expect(library.presets[0]!.name).toBe("default");
    await expect(store.bindCurrent()).resolves.toMatchObject({
      id: library.presets[0]!.id,
    });
  });

  test("删除当前预设后只剩停用身份时同样重建默认，不把用户卡住", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-play-delete-disabled-"),
    );
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const current = (await store.list()).presets[0]!;
    const other = await store.create("停用备用");
    await store.setEnabled(other.preset.id, false);
    await store.delete(current.id);
    const library = await store.list();
    // The only remaining preset is disabled, so the store rebuilds a usable default.
    expect(library.presets).toHaveLength(1);
    expect(library.presets[0]!.enabled).toBe(true);
    expect(library.currentPresetId).toBe(library.presets[0]!.id);
    await expect(store.bindCurrent()).resolves.toMatchObject({
      id: library.presets[0]!.id,
    });
  });

  test("结构化编辑复用公共 codec，合法草稿可应用，坏结构保留为不可选择 draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-structured-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "后置请求玩法",
      firstPartyActionChoicesPresetFiles,
    );
    await store.select(created.preset.id);
    const binding = await store.bindCurrent();
    const structure = toPlayPresetStructuredEditor(binding.definition);
    expect(structure.followups.map(({ id }) => id)).toEqual(["player_options"]);
    expect(structure.narrativePrompts.map(({ path }) => path)).toEqual([
      "prompts/narrate.md",
    ]);

    // A valid display-name edit remains valid after a round trip.
    structure.followups[0]!.displayName = "结构化修改";
    const nextFiles = applyPlayPresetStructuredEditor(
      binding.files,
      parsePlayPresetStructuredEditor(structure),
    );
    expect(validatePlayPresetFiles(nextFiles)).toEqual({ status: "valid" });
    const reparsed = parsePlayPresetFiles(nextFiles);
    expect(reparsed.kind).toBe("valid");
    if (reparsed.kind === "valid")
      expect(reparsed.definition.followups[0]?.displayName).toBe("结构化修改");

    // A missing prompt reference is retained only as an unselectable draft.
    const broken = toPlayPresetStructuredEditor(binding.definition);
    broken.followups[0]!.prompt = {
      role: "author_instruction",
      path: "prompts/missing.md",
    };
    await store.save({
      presetId: created.preset.id,
      name: created.preset.name,
      files: binding.files,
      structure: broken,
    });
    const listed = (await store.list()).presets.find(
      ({ id }) => id === created.preset.id,
    )!;
    expect(listed.validation.status).toBe("valid");
    expect(listed.draft?.validation.status).toBe("invalid");
    // The frozen binding is unaffected by the invalid draft.
    expect((await store.bindCurrent()).revision).toBe(binding.revision);
    await expect(store.select(created.preset.id)).rejects.toMatchObject({
      code: "invalid_play_preset",
    });
    expect((await store.bindCurrent()).revision).toBe(binding.revision);
  });

  test("任何 portable 导入默认停用本地代码，启用是显式可信选择", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-play-workbench-import-"),
    );
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const importing = store.importPortable({
      name: "带脚本的导入玩法",
      files: firstPartyActionChoicesPresetFiles,
    });
    const concurrentList = store.list();
    const imported = await importing;
    expect(imported.preset.scriptsEnabled).toBe(false);
    expect(
      (await concurrentList).presets.find(({ id }) => id === imported.preset.id)
        ?.scriptsEnabled,
    ).toBe(false);
    await store.setScriptsEnabled(imported.preset.id, true);
    expect(
      (await store.list()).presets.find(({ id }) => id === imported.preset.id)
        ?.scriptsEnabled,
    ).toBe(true);

    const rendererOnly = structuredClone(firstPartyActionChoicesPresetFiles);
    delete rendererOnly["scripts/player-options.js"];
    rendererOnly["preset.yaml"] = rendererOnly["preset.yaml"]!.replace(
      "  - scripts/player-options.js\n",
      "",
    );
    rendererOnly["renderers/player-options.html"] = rendererOnly[
      "renderers/player-options.html"
    ]!.replace("</body>", "<script>parent.__imported = true</script></body>");
    const inlineRenderer = await store.importPortable({
      name: "只有内联 renderer 脚本的导入玩法",
      files: rendererOnly,
    });
    expect(inlineRenderer.preset.scriptsEnabled).toBe(false);
  });

  test("工作台产物 preview 只读取冻结文件，包含 regex、renderer、投影与 clear 诊断", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-play-workbench-preview-"),
    );
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "模板Preview",
      firstPartyActionChoicesPresetFiles,
    );
    const snapshot = buildPlayPresetWorkbenchSnapshot(
      await store.bindRevision(created.preset.id, created.preset.revision),
    );
    expect(snapshot.id).toBe(created.preset.id);
    expect(snapshot.revision).toBe(created.preset.revision);
    expect(snapshot.artifactPreviews.length).toBeGreaterThan(0);
    expect(snapshot.artifactPreviews[0]).toMatchObject({
      activeProjection: { status: "active" },
      clear: { supported: true },
    });
    expect(snapshot.artifactPreviews[0]?.rawPayload).toBeDefined();
    expect(snapshot.artifactPreviews[0]?.simulation).toMatchObject({
      emitted: { status: "active" },
      explicitClear: { status: "cleared" },
    });
    expect(snapshot.trustedLocalCode).toBe(true);
    await store.setScriptsEnabled(created.preset.id, false);
    const disabledScripts = buildPlayPresetWorkbenchSnapshot(
      await store.bindRevision(created.preset.id, created.preset.revision),
    );
    expect(disabledScripts.scriptsEnabled).toBe(false);
    expect(disabledScripts.artifactPreviews[0]?.renderer?.scripts).toEqual([]);
    const declaration = disabledScripts.artifactPreviews[0]!.declaration;
    expect(
      simulateArtifactProjection({
        ...declaration,
        invalidation: "never",
      } as never).invalidation,
    ).toMatchObject({ policy: "never", status: "active" });
    expect(
      simulateArtifactProjection({
        ...declaration,
        invalidation: "explicit_clear",
      } as never).invalidation,
    ).toMatchObject({ policy: "explicit_clear", status: "cleared" });
  });
  test("通用 Markdown 与 HTML app 面板模板只使用公共产物 seam", () => {
    const parsed = parsePlayPresetFiles(firstPartyGenericPanelsPresetFiles);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind === "valid") {
      expect(parsed.definition.mounts).toEqual([
        { channel: "generic.markdown", mount: "story" },
        { channel: "generic.html", mount: "sidebar" },
        { channel: "generic.debug", mount: "debug" },
      ]);
      const panelFollowup = parsed.definition.followups.find(
        ({ id }) => id === "publish_panels",
      );
      expect(panelFollowup?.artifacts).toMatchObject([
        { name: "markdown_panel", contentType: "text/markdown" },
        {
          name: "html_panel",
          contentType: "text/html",
          rendererMode: "app",
        },
        { name: "debug_panel", contentType: "text/markdown" },
      ]);
    }
  });

  test("player-view panel group 不能引用 source.itemIds 范围外的项目", () => {
    const files = structuredClone(defaultPlayPresetFiles);
    files["preset.yaml"] = `format: narraeon.play-preset/v1
name: invalid-panel-group
callChain: call-chain.yaml
mounts: []
playerViewPanels:
  - id: panel
    source:
      kind: player_view
      view: status
      itemIds: [known]
    channel: panel
    key: current
    mount: sidebar
    renderer: renderers/panel.html
    rendererRevision: v1
    rendererMode: app
    config:
      layout: stack
      theme: default
      empty: message
      emptyMessage: 暂无
      groups:
        - id: group
          label: 分组
          itemIds: [outside]
extensions:
  - renderers/panel.html
`;
    files["renderers/panel.html"] = "<main></main>";
    expect(parsePlayPresetFiles(files)).toMatchObject({
      kind: "invalid",
      error: { code: "player_view_panel_group_outside_source" },
    });
  });

  test("默认预设同时包含主持块库与玩法叙事块", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-preset-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();

    const library = await store.list();
    expect(library.presets).toHaveLength(1);
    const preset = library.presets[0]!;
    expect(preset.validation).toEqual({ status: "valid" });
    expect(preset.revision).toMatch(/^rev-[0-9a-f]{64}$/u);
    // One preset carries host, play, and setting-improvement author prompts.
    // Style blocks ship with it, while frame.yaml decides whether they are enabled.
    expect(Object.keys(preset.files).sort()).toEqual([
      "blocks/adjudication.md",
      "blocks/state.md",
      "blocks/style-action.md",
      "blocks/style-horror.md",
      "blocks/style-intimate.md",
      "blocks/style-literary.md",
      "blocks/style-noir.md",
      "blocks/style-wuxia.md",
      "blocks/style.md",
      "call-chain.yaml",
      "frame.yaml",
      "preset.yaml",
      "prompts/narrate.md",
      "prompts/setting-improvement.md",
    ]);

    const binding = await store.bindCurrent();
    expect(binding.revision).toBe(preset.revision);
    expect(binding.definition.narrativePrompts.map(({ path }) => path)).toEqual(
      ["prompts/narrate.md"],
    );
    expect(binding.definition.settingImprovementPrompt).toEqual({
      role: "author_instruction",
      path: defaultSettingImprovementPromptPath,
    });
    expect(settingImprovementPromptForBinding(binding)).toBe(
      defaultSettingImprovementPrompt,
    );
    expect(binding.definition.followups).toEqual([]);

    const secondRoot = await mkdtemp(join(tmpdir(), "narraeon-play-preset-"));
    roots.push(secondRoot);
    const secondStore = new FileNativePlayPresetStore(secondRoot);
    await secondStore.initialize();
    expect((await secondStore.list()).presets[0]?.revision).toBe(
      preset.revision,
    );
  });

  test("旧 v1 预设不被改写并回退到系统推荐设定完善提示", () => {
    const files = structuredClone(defaultPlayPresetFiles);
    files["preset.yaml"] = files["preset.yaml"]!.replace(
      "settingImprovement:\n  markdown: prompts/setting-improvement.md\n",
      "",
    );
    delete files[defaultSettingImprovementPromptPath];

    const parsed = parsePlayPresetFiles(files);
    if (parsed.kind !== "valid") throw parsed.error;
    expect(parsed.definition.settingImprovementPrompt).toBeUndefined();
    expect(Object.keys(files)).not.toContain(
      defaultSettingImprovementPromptPath,
    );
    expect(
      settingImprovementPromptForBinding({
        id: "legacy",
        name: "旧预设",
        revision: "legacy-v1",
        definition: parsed.definition,
        files,
        scriptsEnabled: true,
      }),
    ).toBe(defaultSettingImprovementPrompt);
  });

  test("设定完善提示引用可编辑，但 Runtime 工具定义不能写进预设结构", () => {
    const custom = structuredClone(defaultPlayPresetFiles);
    custom[defaultSettingImprovementPromptPath] =
      "# 自定义创作方法\n\n只补足日常节奏。\n";
    const parsed = parsePlayPresetFiles(custom);
    if (parsed.kind !== "valid") throw parsed.error;
    expect(
      settingImprovementPromptForBinding({
        id: "custom",
        name: "自定义",
        revision: "custom-v1",
        definition: parsed.definition,
        files: custom,
        scriptsEnabled: true,
      }),
    ).toContain("只补足日常节奏");

    custom["preset.yaml"] = custom["preset.yaml"]!.replace(
      "  markdown: prompts/setting-improvement.md",
      "  markdown: prompts/setting-improvement.md\n  toolDefinitions: []",
    );
    expect(parsePlayPresetFiles(custom)).toMatchObject({
      kind: "invalid",
      error: { code: "editable_mechanics_forbidden" },
    });
  });

  test("Preview 复用真实编译器，展示 bootstrap、后置请求与 cache fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-preview-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "Preview用玩法",
      firstPartyActionChoicesPresetFiles,
    );
    await store.select(created.preset.id);
    const binding = await store.bindCurrent();
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "play-preview-model",
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      playerInput: "I try to push the door open.",
      playerInputPlacement: "append",
    });

    const preview = new FileNativePromptCompiler().previewPlayPreset(
      input,
      binding,
    );
    expect(preview.playPreset?.id).toBe(binding.id);
    expect(preview.playPreset?.revision).toBe(binding.revision);
    // The main chain receives the stable complete tool set.
    expect(preview.playPreset?.toolUniverse.map(({ name }) => name)).toEqual([
      "state_list",
      "history_list",
      "context_search",
      "context_read",
      "world_patch",
      "world_create",
      "artifact_emit",
      "artifact_clear",
    ]);
    expect(preview.playPreset?.cache.toolDefinitionBoundary).toBe("stable");
    expect(preview.playPreset?.bootstrap.cache.stablePrefixFingerprint).toBe(
      preview.compilation.cache.stablePrefixFingerprint,
    );

    const followups = preview.playPreset!.followups;
    expect(followups.map(({ id }) => id)).toEqual(["player_options"]);
    expect(followups[0]!.allowedTools).toEqual([
      "artifact_emit",
      "artifact_clear",
    ]);
    expect(followups[0]!.logicalMessages.map(({ role }) => role)).toEqual([
      "author_instruction",
    ]);
    expect(preview.leakage.status).toBe("clean");
    expect(binding.files["call-chain.yaml"]).not.toContain("inputSchema");
  });

  test("普通结构化 artifact contract 会进入真实 Preview，而不是页面专用 schema", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "narraeon-play-options-preview-"),
    );
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "可复制建议玩法",
      firstPartyActionChoicesPresetFiles,
    );
    await store.select(created.preset.id);
    const binding = await store.bindCurrent();
    const preview = new FileNativePromptCompiler().previewPlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "options-preview-model",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        playerInput: "Check the recommended play flow.",
        playerInputPlacement: "bootstrap",
      }),
      binding,
    );
    const followup = preview.playPreset?.followups.find(
      ({ id }) => id === "player_options",
    );
    expect(followup?.artifacts[0]).toMatchObject({
      name: "player_options",
      channel: "player.options",
      strategy: "replace",
      payloadContract: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        uniqueBy: "id",
      },
    });
    expect(followup?.logicalMessages.at(-1)?.markdown).toContain(
      "payloadContract=array",
    );
  });

  test("cache fingerprint 覆盖工具全集与作者正文，工具全集由 Runtime 固定", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-cache-boundary-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const binding = await store.bindCurrent();
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "cache-boundary-model",
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
      playerInput: "Body text with the same semantics.",
      playerInputPlacement: "append",
    });
    const full = new FileNativePromptCompiler().compilePlayPreset(
      input,
      binding,
    );
    // Presets no longer declare toolUniverse; Runtime fixes main-chain tools.
    expect(full.toolUniverse.map(({ name }) => name)).toEqual([
      "state_list",
      "history_list",
      "context_search",
      "context_read",
      "world_patch",
      "world_create",
      "artifact_emit",
      "artifact_clear",
    ]);

    const shorterFiles = structuredClone(defaultPlayPresetFiles);
    shorterFiles["prompts/narrate.md"] =
      "# Narrative\n\nA much shorter author instruction.\n";
    const shorter = parsePlayPresetFiles(shorterFiles);
    expect(shorter.kind).toBe("valid");
    if (shorter.kind !== "valid") return;
    // Narrative prose enters call-chain bootstrap, so editing it changes the stable prefix.
    const compiler = new FileNativePromptCompiler();
    const chainFull = compiler.compilePlayCallChain(input, binding);
    const chainShorter = compiler.compilePlayCallChain(input, {
      id: "shorter",
      name: shorter.definition.name,
      revision: "rev-shorter",
      definition: shorter.definition,
      files: shorterFiles,
      scriptsEnabled: true,
    });
    expect(chainShorter.toolUniverse.map(({ name }) => name)).toEqual(
      chainFull.toolUniverse.map(({ name }) => name),
    );
    expect(chainShorter.bootstrap.cache.stablePrefixFingerprint).not.toBe(
      chainFull.bootstrap.cache.stablePrefixFingerprint,
    );
  });

  test("任意作者正文不触发 Runtime 机械字段泄漏扫描", async () => {
    const files = structuredClone(defaultPlayPresetFiles);
    files["prompts/narrate.md"] =
      "Authors may discuss cache, operation, revision, and /tmp/author/example as semantic prose.";
    expect(validatePlayPresetFiles(files)).toEqual({ status: "valid" });
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-author-text-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create("作者文本", files);
    const preview = new FileNativePromptCompiler().preview(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "author-text-model",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        playerInput: "Check the author text.",
        playerInputPlacement: "append",
      }),
      await store.bindRevision(created.preset.id),
    );
    expect(preview.leakage.status).toBe("clean");
    expect(
      preview.playPreset?.bootstrap.logicalMessages.find(({ markdown }) =>
        markdown.includes("/tmp/author/example"),
      )?.markdown,
    ).toContain("/tmp/author/example");
    for (const source of ["play:", "host:", "world:", "player:"])
      expect(() =>
        scanRuntimeLeakage([
          {
            role: "author_instruction",
            markdown: "cache operation revision /tmp/author/example",
            blocks: [
              {
                source: `${source}author-text`,
                markdown: "cache operation revision /tmp/author/example",
              },
            ],
          },
        ]),
      ).not.toThrow();
    expect(() =>
      scanRuntimeLeakage([
        {
          role: "runtime_system",
          markdown: "Runtime operationId leaked",
          blocks: [
            {
              source: "runtime:test",
              markdown: "Runtime operationId leaked",
            },
          ],
        },
      ]),
    ).toThrow(/operationId/u);

    const invalid = structuredClone(defaultPlayPresetFiles);
    invalid["call-chain.yaml"] = invalid["call-chain.yaml"]!.replace(
      "  - markdown: prompts/narrate.md",
      "  - { role: assistant, markdown: prompts/narrate.md }",
    );
    expect(validatePlayPresetFiles(invalid).status).toBe("invalid");
  });

  test("V1 prompt.preview 绑定当前玩法 revision 并展示生产调用链 bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-runtime-"));
    roots.push(root);
    const runtime = new V1Runtime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
    });
    await runtime.initialize();
    await runtime.handle({
      type: "model.save",
      connection: {
        name: "Preview模型",
        presetId: "custom",
        provider: "openai_responses",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "preview-runtime-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_000,
      },
    });
    const created = await runtime.handle({ type: "content.create" });
    const packageId = (created.result as { localId: string }).localId;
    const workspace = await runtime.handle({ type: "workspace.read" });
    const library = workspace.result as {
      playPresets: {
        currentPresetId: string;
        presets: { id: string; revision: string }[];
      };
    };
    const current = library.playPresets.presets.find(
      ({ id }) => id === library.playPresets.currentPresetId,
    );
    expect(current).toBeDefined();
    const preview = await runtime.handle({
      type: "prompt.preview",
      packageId,
      playerInput: "Check the call-chain prompt.",
      model: {
        provider: "chat_completions",
        modelId: "browser-value-is-ignored",
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
      },
    });
    expect(preview.result).toMatchObject({
      diagnosticBinding: {
        playPresetId: library.playPresets.currentPresetId,
        playPresetRevision: current?.revision,
      },
      playPreset: {
        followups: [],
        toolUniverse: [
          { name: "state_list" },
          { name: "history_list" },
          { name: "context_search" },
          { name: "context_read" },
          { name: "world_patch" },
          { name: "world_create" },
        ],
      },
      initialAppend: {
        logical: { kind: "player", text: "Check the call-chain prompt." },
        provider: { role: "user", content: "Check the call-chain prompt." },
      },
    });
    const previewText = JSON.stringify(preview.result);
    expect(previewText).not.toContain("player_input");
    expect(previewText).not.toContain("message.genesis.narrator");
    expect(previewText).toContain(
      "Make the final sentence a specific action someone takes",
    );
    const copied = await runtime.handle({
      type: "play.copy",
      presetId: library.playPresets.currentPresetId,
    });
    const copiedPreset = copied.result as {
      preset: { id: string; name: string; files: Record<string, string> };
    };
    const draftMarker = "作者工作台 draft revision marker";
    await runtime.handle({
      type: "play.save",
      presetId: copiedPreset.preset.id,
      name: copiedPreset.preset.name,
      files: {
        ...copiedPreset.preset.files,
        "prompts/adjudicate.md": `${copiedPreset.preset.files["prompts/adjudicate.md"]}\n${draftMarker}\n`,
      },
    });
    const afterDraft = (await runtime.handle({ type: "play.read" })).result as {
      presets: { id: string; draft?: { revision: string } }[];
    };
    const copiedView = afterDraft.presets.find(
      ({ id }) => id === copiedPreset.preset.id,
    );
    const draftRevision = copiedView?.draft?.revision;
    expect(draftRevision).toBeDefined();
    if (draftRevision === undefined) throw new Error("draft revision missing");
    const draftPreview = await runtime.handle({
      type: "prompt.preview",
      packageId,
      playerInput: "Check an unapplied draft revision.",
      model: {
        provider: "chat_completions",
        modelId: "browser-value-is-ignored",
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
      },
      playPresetId: copiedPreset.preset.id,
      playPresetRevision: draftRevision,
    });
    expect(draftPreview.result).toMatchObject({
      diagnosticBinding: {
        playPresetId: copiedPreset.preset.id,
        playPresetRevision: draftRevision,
      },
    });
    expect(JSON.stringify(draftPreview.result)).not.toContain(draftMarker);
  });

  test("磁盘篡改、重复身份和无效 revision 元数据在冷启动时被隔离而不是接受", async () => {
    const cases: {
      label: string;
      prepare?: (store: FileNativePlayPresetStore) => Promise<void>;
      mutate: (document: Record<string, unknown>) => void;
    }[] = [
      {
        label: "顶层未知字段",
        mutate: (document) => {
          document.unexpectedField = true;
        },
      },
      {
        label: "preset 未知字段",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.unexpectedField = true;
        },
      },
      {
        label: "缺失 enabled",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          delete presets[0]!.enabled;
        },
      },
      {
        label: "缺失 scriptsEnabled",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          delete presets[0]!.scriptsEnabled;
        },
      },
      {
        label: "空 id",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.id = "";
        },
      },
      {
        label: "无效 name",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.name = "\n";
        },
      },
      {
        label: "空 revisions",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.revisions = {};
        },
      },
      {
        label: "无效 current revision",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.currentRevision =
            "rev-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        },
      },
      {
        label: "无效 draft revision",
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[0]!.draftRevision =
            "rev-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        },
      },
      {
        label: "重复 id",
        prepare: async (store) => {
          const current = (await store.list()).presets[0]!;
          await store.copy(current.id);
        },
        mutate: (document) => {
          const presets = document.presets as Record<string, unknown>[];
          presets[1]!.id = presets[0]!.id;
        },
      },
    ];
    for (const { label, prepare, mutate } of cases) {
      const root = await mkdtemp(
        join(tmpdir(), "narraeon-play-store-integrity-"),
      );
      roots.push(root);
      const store = new FileNativePlayPresetStore(root);
      await store.initialize();
      if (prepare !== undefined) await prepare(store);
      const path = join(root, "file-native-play-presets.json");
      const document = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(document);
      await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
      // A tampered library is rejected as data but no longer prevents startup.
      // It is quarantined and reported so the workspace remains available.
      const recovered = new FileNativePlayPresetStore(root);
      await recovered.initialize();
      expect(recovered.recovery, label).not.toBeNull();
      const rebuilt = await recovered.list();
      expect(rebuilt.presets, label).toHaveLength(1);
      expect(rebuilt.presets[0]?.validation, label).toEqual({
        status: "valid",
      });
    }

    const root = await mkdtemp(join(tmpdir(), "narraeon-play-store-hash-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const path = join(root, "file-native-play-presets.json");
    const document = JSON.parse(await readFile(path, "utf8")) as {
      presets: {
        currentRevision: string;
        revisions: Record<string, Record<string, string>>;
      }[];
    };
    const preset = document.presets[0]!;
    preset.revisions[preset.currentRevision]!["prompts/adjudicate.md"] =
      "disk tampering";
    await writeFile(path, `${JSON.stringify(document)}\n`, "utf8");
    const afterTamper = new FileNativePlayPresetStore(root);
    await afterTamper.initialize();
    expect(afterTamper.recovery?.message).toMatch(/revision|hash|invalid/u);
    // Tampered content never enters the usable library.
    const tamperedLibrary = await afterTamper.list();
    expect(
      JSON.stringify(tamperedLibrary.presets.map(({ files }) => files)),
    ).not.toContain("磁盘篡改");
  });

  test("无效草稿可检查但不会改变当前选择或冻结 revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-invalid-draft-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const before = await store.bindCurrent();
    const current = (await store.list()).presets[0]!;
    await store.save({
      presetId: current.id,
      name: current.name,
      files: {
        ...current.files,
        "call-chain.yaml": current.files["call-chain.yaml"]!.replace(
          "prompts/narrate.md",
          "prompts/missing.md",
        ),
      },
    });
    const listed = (await store.list()).presets[0]!;
    expect(listed.validation.status).toBe("valid");
    expect(listed.draft?.validation.status).toBe("invalid");
    expect((await store.bindCurrent()).revision).toBe(before.revision);
    await expect(store.select(current.id)).rejects.toMatchObject({
      code: "invalid_play_preset",
    });
    expect((await store.bindCurrent()).revision).toBe(before.revision);
  });

  test("后置请求数量在 codec 边界限制为机械上限", () => {
    const followup = (index: number): string => `
  - id: post_${String(index).padStart(2, "0")}
    displayName: 扩展 ${index}
    prompt: { markdown: prompts/narrate.md }
    artifacts:
      - name: panel_${String(index).padStart(2, "0")}
        channel: panel.${String(index).padStart(2, "0")}
        strategy: replace
        contentType: text/markdown
        save: commit
        invalidation: new_operation
        required: false
        maxEmits: 1
`;
    const withFollowups = (count: number): Record<string, string> => ({
      ...defaultPlayPresetFiles,
      "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:${Array.from({ length: count }, (_, index) => followup(index)).join("")}`,
    });
    expect(
      parsePlayPresetFiles(withFollowups(maxPlayPresetFollowups)).kind,
    ).toBe("valid");
    expect(
      validatePlayPresetFiles(withFollowups(maxPlayPresetFollowups + 1)),
    ).toMatchObject({ status: "invalid", code: "followups_invalid" });
  });

  test("导入和复制都生成新本地身份，导出只包含业务文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-portable-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const original = (await store.list()).presets[0]!;
    const copied = await store.copy(original.id);
    const imported = await store.importPortable({
      name: "导入玩法",
      files: await store.exportPortable(original.id),
    });
    expect(copied.preset.id).not.toBe(original.id);
    expect(imported.preset.id).not.toBe(original.id);
    expect(imported.preset.files).not.toHaveProperty("id");
    expect(imported.preset.files).not.toHaveProperty("revision");
    const exported = await store.exportPortable(original.id);
    expect(exported.map(({ path }) => path)).toEqual(
      [...exported.map(({ path }) => path)].sort(),
    );
    expect(JSON.stringify(exported)).toBe(
      JSON.stringify(await store.exportPortable(original.id)),
    );
  });

  test("play.import 协议在边界拒绝非 UTF-8 文本编码", () => {
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.import",
          name: "二进制玩法",
          files: [
            {
              path: "assets/icon.bin",
              contents: "AA==",
              encoding: "base64",
            },
          ],
        },
      }),
    ).toThrow(/play\.import\.files/u);
  });

  test("play.create.files 只接受 Record<string,string>", () => {
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.create",
          name: "协议玩法",
          files: { "preset.yaml": "ok", broken: 42 },
        },
      }),
    ).toThrow(/play\.create\.files/u);
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.create",
          name: "协议玩法",
          files: ["not-a-map"],
        },
      }),
    ).toThrow(/play\.create\.files/u);
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.create",
          name: "协议玩法",
          files: { "preset.yaml": "ok" },
        },
      }),
    ).not.toThrow();
  });

  test("play.save/workbench 与 artifacts.debug 在协议边界拒绝畸形可选字段", () => {
    for (const request of [
      {
        type: "play.save",
        presetId: "preset-1",
        name: "协议玩法",
        files: { "preset.yaml": "ok", broken: 42 },
      },
      { type: "play.workbench.read", presetId: 42 },
      { type: "play.workbench.read", revision: "rev-without-preset" },
      { type: "play.workbench.read", presetId: "preset-1", revision: "" },
      { type: "artifacts.debug", worldId: "world-1", operationId: 42 },
      { type: "artifacts.debug", worldId: "world-1", operationId: "" },
    ])
      expect(() =>
        parseV1Envelope({ protocol: "narraeon.runtime/v1", request }),
      ).toThrow();

    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.workbench.read",
          presetId: "preset-1",
          revision: "rev-1",
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseV1Envelope({
        protocol: "narraeon.runtime/v1",
        request: {
          type: "artifacts.debug",
          worldId: "world-1",
          operationId: "play-1",
        },
      }),
    ).not.toThrow();
  });

  test("payloadContract codec 在深度和节点数超限时稳定拒绝", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 40; index += 1)
      deep = { type: "array", items: deep };
    const withContract = (contract: unknown): Record<string, string> => ({
      ...defaultPlayPresetFiles,
      "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: deep
    displayName: 深层契约
    prompt: { markdown: prompts/narrate.md }
    artifacts:
      - name: deep
        channel: debug.deep
        strategy: append
        contentType: application/json
        save: operation
        invalidation: operation_end
        required: false
        maxEmits: 1
        payloadContract: ${JSON.stringify(contract)}
`,
    });
    const deepFiles = withContract(deep);
    expect(validatePlayPresetFiles(deepFiles)).toMatchObject({
      status: "invalid",
      code: "artifact_payload_contract_too_deep",
    });

    const wideProperties = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [
        `field${index}`,
        { type: "string" },
      ]),
    );
    const wideFiles = withContract({
      type: "object",
      properties: wideProperties,
    });
    expect(validatePlayPresetFiles(wideFiles)).toMatchObject({
      status: "invalid",
      code: "artifact_payload_contract_too_complex",
    });
  });

  test("预设不估算上下文，固定 Provider 配置仍保留在Preview绑定", async () => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-play-budget-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const created = await store.create(
      "预算玩法",
      firstPartyActionChoicesPresetFiles,
    );
    const preview = new FileNativePromptCompiler().previewPlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "budget-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_000,
        playerInput: "Check the budget.",
        playerInputPlacement: "append",
      }),
      await store.bindRevision(created.preset.id),
    );
    expect(preview.playPreset?.bootstrap.budget).toMatchObject({
      estimator: "disabled",
      status: "not_checked",
      outputReserveTokens: 0,
      forcedTailReserveTokens: 0,
      requiredTokens: 0,
    });
  });

  test("静态校验拒绝重复后置请求、缺失提示、空产物与冲突频道", () => {
    const followupBlock = (id: string, channel: string, extra = ""): string => `
  - id: ${id}
    displayName: 面板 ${id}
    prompt: { markdown: prompts/narrate.md }
${extra}    artifacts:
      - name: panel_${id}
        channel: ${channel}
        strategy: replace
        contentType: text/markdown
        save: commit
        invalidation: new_operation
        required: false
        maxEmits: 1
`;
    const withFollowups = (body: string): Record<string, string> => ({
      ...defaultPlayPresetFiles,
      "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:${body}`,
    });

    // Duplicate id.
    expect(
      validatePlayPresetFiles(
        withFollowups(
          `${followupBlock("panel", "chan.a")}${followupBlock("panel", "chan.b")}`,
        ),
      ),
    ).toMatchObject({ status: "invalid", code: "duplicate_followup_id" });

    // Missing prompt block.
    const missingPrompt = withFollowups(followupBlock("panel", "chan.a"));
    missingPrompt["call-chain.yaml"] = missingPrompt[
      "call-chain.yaml"
    ]!.replace("prompts/narrate.md", "prompts/missing.md");
    expect(validatePlayPresetFiles(missingPrompt).status).toBe("invalid");

    // A follow-up with no artifacts is meaningless.
    const noArtifacts = withFollowups(`
  - id: panel
    displayName: 空面板
    prompt: { markdown: prompts/narrate.md }
    artifacts: []
`);
    expect(validatePlayPresetFiles(noArtifacts)).toMatchObject({
      status: "invalid",
      code: "followup_artifact_missing",
    });

    // Missing narrative prompt block.
    const noNarrative = {
      ...defaultPlayPresetFiles,
      "call-chain.yaml":
        "format: narraeon.play-call-chain/v1\nnarrative: []\nfollowups: []\n",
    };
    expect(validatePlayPresetFiles(noNarrative).status).toBe("valid");

    // Conflicting projection strategies on one channel.
    const conflict = withFollowups(
      `${followupBlock("first", "panel.same")}${followupBlock("second", "panel.same").replace("strategy: replace", "strategy: append")}`,
    );
    expect(parsePlayPresetFiles(conflict).kind).toBe("invalid");

    const malformedRegex = structuredClone(defaultPlayPresetFiles);
    malformedRegex["preset.yaml"] = malformedRegex["preset.yaml"]!.replace(
      "extensions: []",
      "mounts:\n  - channel: action_choices\n    mount: sidebar\nextensions:\n  - regex/rules.yaml",
    );
    malformedRegex["regex/rules.yaml"] =
      'rules:\n  - pattern: "["\n    maxMatches: 1\n';
    expect(validatePlayPresetFiles(malformedRegex).status).toBe("invalid");

    const editableSchema = structuredClone(defaultPlayPresetFiles);
    editableSchema["call-chain.yaml"] =
      `${editableSchema["call-chain.yaml"]}\ntoolSchema: {}\n`;
    expect(validatePlayPresetFiles(editableSchema).status).toBe("invalid");
  });

  test("产物 output contract 固定字段与数量边界", () => {
    const withArtifact = (extra: string): Record<string, string> => ({
      ...defaultPlayPresetFiles,
      "call-chain.yaml": `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: outline
    displayName: 大纲
    prompt: { markdown: prompts/narrate.md }
    artifacts:
      - name: outline
        channel: debug.outline
        strategy: append
        contentType: text/markdown
        save: operation
        invalidation: operation_end
        required: false
        maxEmits: 1
${extra}`,
    });
    expect(validatePlayPresetFiles(withArtifact(""))).toEqual({
      status: "valid",
    });

    // Duplicate output names in one follow-up.
    const duplicate = withArtifact(`      - name: outline
        channel: debug.other
        strategy: append
        contentType: text/markdown
        save: operation
        invalidation: operation_end
        required: false
        maxEmits: 1
`);
    expect(validatePlayPresetFiles(duplicate).status).toBe("invalid");

    // A renderer must declare its revision.
    const rendererWithoutRevision: Record<string, string> = {
      ...withArtifact(""),
      "renderers/panel.html": "<p>panel</p>",
    };
    rendererWithoutRevision["call-chain.yaml"] = rendererWithoutRevision[
      "call-chain.yaml"
    ]!.replace(
      "        contentType: text/markdown",
      "        contentType: text/markdown\n        renderer: renderers/panel.html",
    );
    expect(validatePlayPresetFiles(rendererWithoutRevision).status).toBe(
      "invalid",
    );

    // maxEmits must be bounded.
    const unbounded: Record<string, string> = { ...withArtifact("") };
    unbounded["call-chain.yaml"] = unbounded["call-chain.yaml"]!.replace(
      "maxEmits: 1",
      "maxEmits: 9999",
    );
    expect(validatePlayPresetFiles(unbounded).status).toBe("invalid");
  });

  test("前端扩展资源要求显式 regex scope/order、稳定 mount 与冻结引用", () => {
    const files = structuredClone(defaultPlayPresetFiles);
    files["preset.yaml"] = `format: narraeon.play-preset/v1
name: extension-fixture
callChain: call-chain.yaml
mounts:
  - channel: panel
    mount: sidebar
extensions:
  - regex/panel.yaml
  - renderers/panel.html
  - scripts/panel.js
  - assets/icon.txt
`;
    files["regex/panel.yaml"] = `rules:
  - order: 1
    scope: raw_text
    pattern: secret
    flags: gi
    replace: hidden
    maxMatches: 1
    errorPolicy: fallback
`;
    files["renderers/panel.html"] = "<main></main>";
    files["scripts/panel.js"] = "document.body.dataset.ready = 'true';";
    files["assets/icon.txt"] = "icon";
    files["call-chain.yaml"] = `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
  - id: panel
    displayName: 面板
    prompt: { markdown: prompts/narrate.md }
    artifacts:
      - name: panel
        channel: panel
        strategy: replace
        contentType: text/markdown
        renderer: renderers/panel.html
        rendererRevision: panel-v1
        rendererMode: app
        regex: regex/panel.yaml
        scripts: [scripts/panel.js]
        assets: [assets/icon.txt]
        save: commit
        invalidation: head_change
        required: false
        maxEmits: 1
`;
    expect(validatePlayPresetFiles(files)).toEqual({ status: "valid" });

    const duplicateMount = structuredClone(files);
    duplicateMount["preset.yaml"] = duplicateMount["preset.yaml"]!.replace(
      "  - channel: panel\n    mount: sidebar",
      "  - channel: panel\n    mount: sidebar\n  - channel: panel\n    mount: story",
    );
    expect(validatePlayPresetFiles(duplicateMount)).toMatchObject({
      status: "invalid",
      code: "duplicate_mount_channel",
    });

    const implicitRegex = structuredClone(files);
    implicitRegex["regex/panel.yaml"] = `rules:
  - pattern: secret
    replace: hidden
    maxMatches: 1
    errorPolicy: fallback
`;
    expect(validatePlayPresetFiles(implicitRegex)).toMatchObject({
      status: "invalid",
      code: "regex_order_invalid",
    });

    const unlistedResource = structuredClone(files);
    unlistedResource["preset.yaml"] = unlistedResource["preset.yaml"]!.replace(
      "  - scripts/panel.js\n",
      "",
    );
    expect(validatePlayPresetFiles(unlistedResource)).toMatchObject({
      status: "invalid",
      code: "artifact_extension_ref_missing",
    });
  });
});

describe("无法解析的预设库不阻断启动", () => {
  test("彻底损坏的库被移到一旁并重建，原文件保留且可诊断", async () => {
    for (const [label, body] of [
      ["坏 JSON", "{ not json"],
      ["缺字段", JSON.stringify({ schemaVersion: 1 })],
      [
        "hash 不匹配",
        JSON.stringify({
          schemaVersion: 1,
          currentPresetId: "p",
          presets: [
            {
              id: "p",
              name: "手改过的",
              currentRevision: `rev-${"0".repeat(64)}`,
              revisions: { [`rev-${"0".repeat(64)}`]: { "preset.yaml": "x" } },
              enabled: true,
              scriptsEnabled: true,
            },
          ],
        }),
      ],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "narraeon-play-broken-"));
      roots.push(root);
      const path = join(root, "file-native-play-presets.json");
      await writeFile(path, body, "utf8");

      const store = new FileNativePlayPresetStore(root);
      await store.initialize();
      const library = await store.list();
      expect(library.presets, label).toHaveLength(1);
      expect(library.presets[0]?.validation, label).toEqual({
        status: "valid",
      });

      // Original bytes are quarantined rather than overwritten and remain reportable.
      expect(store.recovery, label).not.toBeNull();
      expect(await readFile(store.recovery!.quarantinedPath, "utf8")).toBe(
        body,
      );
    }
  });
});
