import { describe, expect, test, vi } from "vitest";

import { defaultPresetHostFiles } from "../../src/shared/default-preset-host.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { FileNativePlayDocuments } from "../../src/runtime/play/PlayDocumentTools.ts";
import type { PromptCompilationError } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  fileNativeToolsForNames,
  FileNativePromptCompiler,
  type FileNativePromptInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

test("主持块分别约束玩家代理权与默认叙事视角", () => {
  expect(defaultPresetHostFiles["blocks/adjudication.md"]).toContain(
    "What the player must decide",
  );
  expect(defaultPresetHostFiles["blocks/adjudication.md"]).toContain(
    "intention, attempt, preparation, or prediction does not mean the goal has been achieved",
  );
  expect(defaultPresetHostFiles["blocks/style.md"]).toContain(
    "Address the player character as “you”",
  );
});

function input(
  overrides: Partial<FileNativePromptInput> = {},
): FileNativePromptInput {
  const worldFiles = {
    "control/frame.yaml": `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot:
      kind: reference_targets
      from:
        document: situation.current
        locator: { yaml: [人物] }
      maxEntries: 12
      required: false
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: additional_materials }
`,
    "control/blocks/world-style.md":
      "# World Rules\n\nWrite durable outcomes back to their natural owner.\n",
    "state/current-situation.yaml": `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 宿舍里的当前局面。
  aliases: []
地点: 男生宿舍 302
人物:
  - $ref: character.alex
情况: Alex正在整理球衣。
`,
    "state/characters/alex.yaml": `$document:
  id: character.alex
  ref: alex
  title: Alex
  summary: 篮球队前锋，直率护短。
  aliases: [Al]
衣着: 白色运动背心，运动短裤，拖鞋
`,
    "state/rules/cultivation.md": `---
$document:
  id: rule.cultivation
  ref: cultivation
  title: 修炼规则
  summary: 修炼阶段的自然语言规则。
  aliases: []
---
# 修炼规则

## 金丹

金丹之后才可尝试元婴。
`,
  };
  return {
    endpoint: { id: "endpoint-internal", commit: "commit-internal" },
    hostBinding: {
      hostPresetId: "host-internal",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
        "blocks/style.md":
          "# Host style\n\nBe restrained and specific. Do not act for the player.\n",
      },
    },
    world: {
      controlFingerprint: "control-internal",
      documentSnapshot: WorldDocumentStore.open({
        layout: "world_state",
        files: Object.entries(worldFiles).map(([path, contents]) => ({
          path,
          contents,
        })),
      }),
      additionalMaterials: [
        {
          kind: "node",
          document: "rule.cultivation",
          locator: { markdown: ["金丹"] },
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "I ask Alex whether we are training tonight.",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
    ...overrides,
  };
}

function snapshotRecord(source: FileNativePromptInput): Record<string, string> {
  return Object.fromEntries(
    source.world.documentSnapshot.files.map(({ path, contents }) => [
      path,
      contents,
    ]),
  );
}

function bindSnapshot(
  source: FileNativePromptInput,
  files: Record<string, string>,
  layout: "content_package" | "world_state" = "world_state",
): void {
  source.world.documentSnapshot = WorldDocumentStore.open({
    layout,
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      contents,
    })),
  });
}

function worldWithFiles(
  change: (files: Record<string, string>) => void,
): FileNativePromptInput["world"] {
  const source = input();
  const files = snapshotRecord(source);
  change(files);
  bindSnapshot(source, files);
  return source.world;
}

describe("文件原生 PromptCompiler", () => {
  test("世界材料固定在调用方绑定的不可变文档快照中", () => {
    const source = input();
    const files = snapshotRecord(source);
    const snapshot = WorldDocumentStore.open({
      layout: "world_state",
      files: Object.entries(files).map(([path, contents]) => ({
        path,
        contents,
      })),
    });
    source.world.documentSnapshot = snapshot;
    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace("Alex正在整理球衣", "调用方稍后改成了另一局面");

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const markdown = compiled.logicalMessages
      .map((message) => message.markdown)
      .join("\n");

    expect(markdown).toContain("Alex正在整理球衣");
    expect(markdown).not.toContain("调用方稍后改成了另一局面");
  });

  test("目录、整文档与精确节点只通过 WorldDocumentStore.query 取得", () => {
    const source = input();
    const snapshot = source.world.documentSnapshot;
    const queries: string[] = [];
    const observedSnapshot = {
      id: snapshot.id,
      layout: snapshot.layout,
      logicalRoot: snapshot.logicalRoot,
      files: snapshot.files,
      status: snapshot.status,
      query(request: Parameters<WorldDocumentStore["query"]>[0]) {
        queries.push(request.kind);
        return snapshot.query(request);
      },
    } as unknown as WorldDocumentStore;
    source.world.documentSnapshot = observedSnapshot;

    new FileNativePromptCompiler().compileBootstrap(source);

    expect(queries).toContain("catalog");
    expect(queries).toContain("read_document");
    expect(queries).toContain("select_node");
    expect(queries).not.toContain("literal_search");
  });

  test("内容包与运行中世界的固定快照编译出字节稳定的等价请求", () => {
    const compiler = new FileNativePromptCompiler();
    const worldState = input();
    const expected = compiler.compileBootstrap(worldState);
    const contentPackage = input();
    const packageFiles = Object.fromEntries(
      Object.entries(snapshotRecord(contentPackage)).map(([path, contents]) => [
        path.replace(/^state\//u, "world/"),
        contents,
      ]),
    );
    bindSnapshot(contentPackage, packageFiles, "content_package");

    const actual = compiler.compileBootstrap(contentPackage);

    expect(contentPackage.world.documentSnapshot.layout).toBe(
      "content_package",
    );
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  test("catalog 上限如实投影为未完整 coverage，不把首屏冒充全部目录", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "directory: characters, maxEntries: 24",
      "directory: characters, maxEntries: 1",
    );
    files["state/characters/casey.yaml"] = `$document:
  id: character.casey
  ref: casey
  title: Casey
  summary: 篮球队的替补后卫。
  aliases: []
衣着: 蓝色训练服
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(compiled.coverage).toContainEqual({
      slot: "catalog",
      source: "characters",
      status: "paged_catalog",
      complete: false,
      continuation: "state_list",
      catalogEntries: ["alex"],
    });
    expect(worldContext).toContain("Showing 1/2.");
    expect(worldContext).toContain(
      "`incomplete` means coverage was not proven",
    );
    expect(worldContext).toContain(
      "`paged_catalog` means additional entries definitely were not listed",
    );
  });

  test("reference_targets 只展开所选节点的一层显式引用", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["state/characters/alex.yaml"] = `${files[
      "state/characters/alex.yaml"
    ]!.trim()}\n所在地点: { $ref: place.cafeteria }\n`;
    files["state/locations/cafeteria.yaml"] = `$document:
  id: place.cafeteria
  ref: cafeteria
  title: 学生食堂
  summary: 学生用餐的公共场所。
  aliases: []
状态: 只有二层展开才会看到这句
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(worldContext).toContain('所在地点:\n  $ref: "@cafeteria"');
    expect(worldContext).not.toContain("只有二层展开才会看到这句");
  });

  test("固定注入的人物恰好在场时只注入一次，离场后仍保持固定注入", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "context:\n",
      'context:\n  - slot: { kind: document, document: "@alex" }\n',
    );
    bindSnapshot(source, files);

    const presentContext = compiler
      .compileBootstrap(source)
      .logicalMessages.find(({ role }) => role === "world_context")?.markdown;
    expect(presentContext).toContain('$ref: "@alex"');
    expect(
      presentContext?.match(/白色运动背心，运动短裤，拖鞋/gu),
    ).toHaveLength(1);

    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace("人物:\n  - $ref: character.alex", "人物: []").replace(
      "情况: Alex正在整理球衣。",
      "情况: 宿舍暂时无人。",
    );
    bindSnapshot(source, files);

    const absentContext = compiler
      .compileBootstrap(source)
      .logicalMessages.find(({ role }) => role === "world_context")?.markdown;
    expect(absentContext).not.toContain('$ref: "@alex"');
    expect(absentContext?.match(/白色运动背心，运动短裤，拖鞋/gu)).toHaveLength(
      1,
    );
  });

  test("reference_targets 即使零命中也如实报告固定来源节点已经完整查询", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace("  - $ref: character.alex", "  []");
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);

    expect(compiled.coverage).toContainEqual({
      slot: "reference_targets",
      source: '@current-situation#yaml:["人物"]',
      status: "resolved",
      complete: true,
      continuation: "context_read",
    });
  });

  test("可选引用目标损坏时 coverage 只暴露目标短引用", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot:
      kind: reference_targets
      from:
        document: situation.current
        locator: { yaml: [人物] }
      maxEntries: 12
      required: false
`;
    files["state/characters/alex.yaml"] = `${files[
      "state/characters/alex.yaml"
    ]!.trim()}\n失效关联: { $ref: character.missing }\n`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(compiled.coverage).toContainEqual({
      slot: "reference_targets",
      source: "@alex",
      status: "optional_missing",
      complete: false,
      continuation: "state_list",
    });
    expect(worldContext).not.toContain("character.alex");
  });

  test("可选节点失败时从 module 结果报告短引用和精确 locator", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot:
      kind: node
      document: situation.current
      locator: { yaml: [不存在] }
      required: false
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(compiled.coverage).toContainEqual({
      slot: "node",
      source: "@current-situation · yaml:不存在",
      status: "optional_missing",
      complete: false,
      continuation: "context_read",
    });
    expect(worldContext).not.toContain("situation.current");
  });

  test("完全无法解析的可选文档范围使用闭合占位而不回显内部身份", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: document, document: secret.internal, required: false }
  - slot:
      kind: node
      document: secret.internal
      locator: { yaml: [状态] }
      required: false
  - slot:
      kind: reference_targets
      from:
        document: secret.internal
        locator: { yaml: [人物] }
      maxEntries: 12
      required: false
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const missing = compiled.coverage.filter(
      ({ status }) => status === "optional_missing",
    );
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(missing.map(({ source: coverageSource }) => coverageSource)).toEqual(
      [
        "(document unavailable)",
        "(document unavailable) · yaml:状态",
        '(document unavailable)#yaml:["人物"]',
      ],
    );
    expect(worldContext).not.toContain("secret.internal");
  });

  test("数组对象中的嵌套引用也只投影模型可见的短引用", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace(
      "  - $ref: character.alex",
      "  - 身份: 室友\n    指向: { $ref: character.alex }",
    );
    bindSnapshot(source, files);

    const worldContext = new FileNativePromptCompiler()
      .compileBootstrap(source)
      .logicalMessages.find(({ role }) => role === "world_context")?.markdown;

    expect(worldContext).toContain("身份: 室友");
    expect(worldContext).toContain('$ref: "@alex"');
    expect(worldContext).not.toContain("character.alex");
  });

  test("大于精确节点上限的有效 YAML 整文档仍可从固定快照编译", () => {
    const source = input({
      modelBinding: {
        provider: "chat_completions",
        modelId: "large-document-model",
        contextWindowTokens: 2_000_000,
        maxOutputTokens: 2_000,
      },
    });
    const files = snapshotRecord(source);
    const largeValue = "甲".repeat(400_000);
    files["state/current-situation.yaml"] = `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 大型但仍有效的当前局面。
  aliases: []
记录: ${largeValue}
`;
    files["control/frame.yaml"] = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(
      Buffer.byteLength(files["state/current-situation.yaml"], "utf8"),
    ).toBeGreaterThan(1024 * 1024);
    expect(worldContext).toContain(`记录: ${largeValue.slice(0, 32)}`);
    expect(compiled.coverage).toContainEqual(
      expect.objectContaining({
        slot: "current_situation",
        status: "resolved",
        complete: true,
      }),
    );
  });

  test("同一个真实编译结果同时驱动逻辑Preview和 system/user provider 请求", () => {
    const compiler = new FileNativePromptCompiler();
    const preview = compiler.preview(input());
    const compiled = compiler.compileBootstrap(input());

    expect(preview.compilation).toEqual(compiled);
    expect(compiled.logicalMessages.map(({ role }) => role)).toEqual([
      "runtime_system",
      "author_instruction",
      "world_context",
      "player_input",
    ]);
    expect(compiled.provider.messages.map(({ role }) => role)).toEqual([
      "system",
      "user",
    ]);
    expect(
      compiled.logicalMessages.every(
        ({ markdown }) => !markdown.trim().startsWith("{"),
      ),
    ).toBe(true);
    expect(
      compiled.logicalMessages.map(({ markdown }) => markdown).join("\n"),
    ).toContain("## Alex [ref: @alex · YAML]");
    expect(compiled.coverage.map(({ status }) => status)).toEqual([
      "resolved",
      "resolved",
      "resolved",
      "resolved",
      "resolved",
    ]);
    expect(compiled.tools.map(({ name }) => name)).toContain("context_read");
    const runtimeSystem = compiled.logicalMessages.find(
      ({ role }) => role === "runtime_system",
    )?.markdown;
    expect(runtimeSystem).toContain(
      "Only Runtime can formally write an operation into the world",
    );
    expect(runtimeSystem).toContain(
      "Editable host, world, and play prompts determine story semantics",
    );
    expect(runtimeSystem).toContain("Runtime call-chain rules");
    expect(runtimeSystem).toContain(
      "A response that calls any tool is an intermediate tool step",
    );
    expect(runtimeSystem).toContain(
      "return the story in a later response with no tool calls",
    );
    expect(compiled.budget).toMatchObject({
      estimator: "disabled",
      status: "not_checked",
      requiredTokens: 0,
    });
    expect(compiled.cache.stablePrefixFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(compiled.cache).toMatchObject({
      strategy: "provider_managed",
      breakpoints: [],
    });
    expect(compiled.cache.estimatedCacheableBytes).toBeGreaterThan(0);
    expect(preview.leakage.status).toBe("clean");
  });

  test("YAML 引用按目标文档声明的 @短引用投影，而不是猜测文档 id 后缀", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["state/current-situation.yaml"] = `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 食堂里的当前局面。
  aliases: []
地点:
  $ref: doc.opaque-location-id
人物:
  - $ref: character.alex
情况: Alex正在打饭。
`;
    files["state/locations/cafeteria.yaml"] = `$document:
  id: doc.opaque-location-id
  ref: cafeteria
  title: 学生食堂
  summary: 学生用餐的公共场所。
  aliases: []
状态: 午餐时段
`;
    bindSnapshot(source, files);

    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    const prompt = compiled.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n");
    const blockSources = compiled.logicalMessages.flatMap(({ blocks }) =>
      blocks.map(({ source: blockSource }) => blockSource),
    );

    expect(prompt).toContain('$ref: "@cafeteria"');
    expect(prompt).not.toContain("[ref: @opaque-location-id]");
    expect(blockSources).toContain("slot:current_situation:@current-situation");
    expect(blockSources).toContain("slot:reference_targets:@alex");
    expect(blockSources).toContain(
      "slot:additional_materials:@cultivation:markdown:金丹",
    );
    expect(JSON.stringify(blockSources)).not.toMatch(
      /situation\.current|doc\.opaque-location-id|rule\.cultivation/u,
    );
  });

  test("Anthropic Messages 只改变 provider role 外壳，不改变逻辑 Markdown", () => {
    const compiler = new FileNativePromptCompiler();
    const chat = compiler.compileBootstrap(input());
    const anthropic = compiler.compileBootstrap(
      input({
        modelBinding: {
          provider: "anthropic_messages",
          modelId: "claude-test",
          contextWindowTokens: 32_000,
          maxOutputTokens: 2_000,
        },
      }),
    );

    expect(anthropic.logicalMessages).toEqual(chat.logicalMessages);
    expect(anthropic.provider.system).toHaveLength(2);
    expect(anthropic.provider.messages).toEqual([
      expect.objectContaining({ role: "user" }),
    ]);
    expect(anthropic.cache).toMatchObject({
      strategy: "explicit_anthropic_blocks",
      breakpoints: ["runtime_system", "author_instruction", "world_context"],
    });
    expect(
      (
        anthropic.provider.messages[0]?.content as {
          cache_control?: unknown;
        }[]
      )[0],
    ).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  test("CLIProxyAPI 方言把稳定前缀报告为代理原生显式缓存消息", () => {
    const compiled = new FileNativePromptCompiler().compileBootstrap(
      input({
        modelBinding: {
          provider: "openai_responses",
          modelId: "claude-through-proxy",
          contextWindowTokens: 32_000,
          maxOutputTokens: 2_000,
          cacheStrategy: "explicit_cliproxyapi_message",
        },
      }),
    );

    expect(compiled.cache).toMatchObject({
      strategy: "explicit_cliproxyapi_message",
      breakpoints: ["author_instruction", "world_context"],
    });
    expect(
      (
        compiled.provider.messages[1]?.content as {
          cache_control?: unknown;
        }[]
      )[0],
    ).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  test("显式缓存策略把冻结世界正文作为同一玩法链可复用的最长 breakpoint", () => {
    const compiler = new FileNativePromptCompiler();
    const firstInput = input({
      modelBinding: {
        provider: "anthropic_messages",
        modelId: "claude-test",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    });
    const secondInput = input({
      modelBinding: {
        provider: "anthropic_messages",
        modelId: "claude-test",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      },
    });
    const files = snapshotRecord(secondInput);
    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace("Alex正在整理球衣。", "Alex已经离开宿舍。");
    bindSnapshot(secondInput, files);

    const first = compiler.compilePlayCallChain(
      firstInput,
      builtinDefaultPlayPresetBinding(),
    ).bootstrap;
    const second = compiler.compilePlayCallChain(
      secondInput,
      builtinDefaultPlayPresetBinding(),
    ).bootstrap;

    expect(JSON.stringify(second.provider)).not.toBe(
      JSON.stringify(first.provider),
    );
    expect(second.cache.stablePrefixFingerprint).not.toBe(
      first.cache.stablePrefixFingerprint,
    );
    expect(first.cache.breakpoints).toContain("world_context");
    expect(
      (
        first.provider.messages[0]?.content as {
          cache_control?: unknown;
        }[]
      )[0],
    ).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  test("append 输入不嵌入 bootstrap 且冻结完整工具全集", () => {
    const compiled = new FileNativePromptCompiler().compileBootstrap(
      input({
        playerInputPlacement: "append",
        playerInput: "Append only once",
      }),
    );

    expect(compiled.logicalMessages.map(({ role }) => role)).toEqual([
      "runtime_system",
      "author_instruction",
      "world_context",
    ]);
    expect(JSON.stringify(compiled.provider)).not.toContain("Append only once");
    // Runtime fixes the complete tool set; player-input position does not split it.
    expect(compiled.tools.map(({ name }) => name)).toEqual([
      "state_list",
      "history_list",
      "context_search",
      "context_read",
      "world_patch",
      "world_create",
      "artifact_emit",
      "artifact_clear",
    ]);
  });

  test("玩法预设按玩家输入位置复用同一份稳定 bootstrap", () => {
    const compiler = new FileNativePromptCompiler();
    const preset = builtinDefaultPlayPresetBinding();
    const embedded = compiler.compilePlayPreset(
      input({
        playerInputPlacement: "bootstrap",
        playerInput: "Embedded player text",
      }),
      preset,
    ).bootstrap;
    const appended = compiler.compilePlayPreset(
      input({
        playerInputPlacement: "append",
        playerInput: "Appended player text",
      }),
      preset,
    ).bootstrap;

    expect(appended.logicalMessages).toEqual(
      embedded.logicalMessages.filter(({ role }) => role !== "player_input"),
    );
    expect(appended.toolUniverse).toEqual(embedded.toolUniverse);
    expect(appended.cache.stablePrefixFingerprint).toBe(
      embedded.cache.stablePrefixFingerprint,
    );
    expect(JSON.stringify(appended.provider)).not.toContain(
      "Appended player text",
    );
  });

  test("state_list 与 history_list 各自暴露简单且完整的模型工具提示", () => {
    const compiled = new FileNativePromptCompiler().compileBootstrap(input());
    const stateList = compiled.tools.find(({ name }) => name === "state_list");
    const historyList = compiled.tools.find(
      ({ name }) => name === "history_list",
    );

    expect(stateList?.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["parent"],
      properties: {
        parent: { type: "string", minLength: 1 },
        cursor: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    expect(historyList?.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["order"],
      properties: {
        order: { enum: ["newest_first", "oldest_first"] },
        cursor: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    expect(JSON.stringify([stateList, historyList])).not.toMatch(
      /"(?:oneOf|allOf|anyOf)"/u,
    );

    const patch = compiled.tools.find(({ name }) => name === "world_patch");
    expect(patch?.description).toContain(
      "A Markdown locator excludes the document level-one heading",
    );
    expect(patch?.description).toContain("set_metadata");
    expect(patch?.description).toContain('{$ref:"@short-ref"}');
    expect(patch?.description).toContain("Never invent a document id");
    expect(patch?.description).toContain("ordinary text");
    expect(patch?.description).toContain("world_create");
    const create = compiled.tools.find(({ name }) => name === "world_create");
    expect(create?.description).toContain('{$ref:"@short-ref"}');
    expect(create?.description).toContain("Never invent a document id");
    expect(compiled.logicalMessages[0]?.markdown).toContain(
      "Only Runtime can formally write an operation into the world",
    );
    expect(patch?.description).toContain("replace_body");
    expect(patch?.description).toContain("use append");
    expect(patch?.description).toContain(
      "Success reports only whether the document changed",
    );
    expect(patch?.description).toContain("does not echo the body");
    expect(patch?.description).toContain("Call context_read again only when");
    expect(stateList?.description).toContain("@dir-/");
    expect(stateList?.description).toContain("state directory");
    expect(historyList?.description).toContain("newest_first");
    expect(historyList?.description).toContain("committed history");
    expect(create?.description).toContain("state_list");
    expect(create?.description).not.toContain("context_list");

    const chinese = fileNativeToolsForNames(
      ["state_list", "history_list"],
      "zh-CN",
    );
    expect(chinese[0]?.description).toContain("状态目录");
    expect(chinese[0]?.description).toContain("@dir-*");
    expect(chinese[1]?.description).toContain("已提交历史");
    expect(chinese[1]?.description).toContain("oldest_first");
  });

  test("state_list 与 history_list 在 Runtime 执行接口拒绝另一工具的参数", () => {
    const snapshot = input().world.documentSnapshot;
    const documents = new FileNativePlayDocuments(
      Object.fromEntries(
        snapshot.files.map(({ path, contents }) => [path, contents]),
      ),
    );
    const call = (name: string, arguments_: Record<string, unknown>) =>
      documents.execute({ id: name, name, arguments: arguments_ }, []);

    expect(
      call("state_list", { parent: "@dir-/", order: "newest_first" }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      call("history_list", { order: "newest_first", parent: "@dir-/" }),
    ).toMatchObject({
      ok: false,
    });
    expect(call("state_list", { parent: "@dir-/" })).toMatchObject({
      ok: true,
    });
    expect(call("history_list", { order: "newest_first" })).toMatchObject({
      ok: true,
    });
    expect(
      call("context_list", { source: "state", parent: "@dir-/" }),
    ).toMatchObject({ ok: true });
    expect(
      call("context_list", { source: "history", order: "oldest_first" }),
    ).toMatchObject({ ok: true });
  });

  test("已注入完整正文的文档可只更新 summary 并保留未展示的 aliases", () => {
    const source = input();
    const files = snapshotRecord(source);
    files["state/current-situation.yaml"] = files[
      "state/current-situation.yaml"
    ]!.replace("aliases: []", 'aliases: [宿舍, "302"]');
    const documents = new FileNativePlayDocuments(files);
    source.world.documentSnapshot = documents.snapshot;
    const compiled = new FileNativePromptCompiler().compileBootstrap(source);
    documents.bindBootstrap(compiled);

    expect(
      documents.execute(
        {
          id: "partial-summary",
          name: "world_patch",
          arguments: {
            target: "@current-situation",
            edits: [
              {
                op: "set_metadata",
                summary: "夜里的宿舍局面。",
              },
            ],
          },
        },
        [],
      ),
    ).toMatchObject({ ok: true });

    expect(
      documents.snapshot.query({
        kind: "read_document",
        document: { shortRef: "current-situation" },
        maxBytes: 8_192,
      }),
    ).toMatchObject({
      kind: "read_document",
      ok: true,
      document: {
        title: "当前情境",
        summary: "夜里的宿舍局面。",
        aliases: ["宿舍", "302"],
      },
    });
    const exactRead = documents.execute(
      {
        id: "read-after-partial-summary",
        name: "context_read",
        arguments: { ref: "@current-situation" },
      },
      [],
    );
    expect(exactRead.markdown).toContain(
      "set_metadata updates one or more fields and preserves omitted fields",
    );
    expect(exactRead.markdown).toContain(
      'summary: 夜里的宿舍局面。\naliases:\n  - 宿舍\n  - "302"',
    );
  });

  test("world_patch 公开 schema 允许 set_metadata 提交任一非空字段子集", () => {
    const patch = new FileNativePromptCompiler()
      .compileBootstrap(input())
      .tools.find(({ name }) => name === "world_patch");
    const schema = patch?.inputSchema as {
      properties?: {
        edits?: {
          items?: {
            oneOf?: {
              minProperties?: number;
              required?: string[];
              properties?: { op?: { const?: string } };
            }[];
          };
        };
      };
    };
    const metadataEdit = schema.properties?.edits?.items?.oneOf?.find(
      ({ properties }) => properties?.op?.const === "set_metadata",
    );

    expect(metadataEdit).toMatchObject({
      minProperties: 2,
      required: ["op"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        aliases: { type: "array" },
      },
    });
  });

  test("发给模型的输出上限就是 Provider 配置，Runtime 不计算预留", async () => {
    const compiler = new FileNativePromptCompiler();
    const source = input({
      modelBinding: {
        provider: "chat_completions",
        modelId: "large-output-model",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    });
    const embedded = compiler.compileBootstrap(source);
    const appended = compiler.compileBootstrap({
      ...source,
      playerInputPlacement: "append",
    });
    const sendBootstrap = vi.fn(() => Promise.resolve());

    await compiler.sendBootstrap(source, { sendBootstrap });

    expect(embedded.budget.outputReserveTokens).toBe(0);
    expect(embedded.budget.forcedTailReserveTokens).toBe(0);
    expect(appended.budget.outputReserveTokens).toBe(0);
    expect(appended.budget.forcedTailReserveTokens).toBe(0);
    expect(embedded.budget.status).toBe("not_checked");
    expect(appended.budget.status).toBe("not_checked");
    expect(sendBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 16_384 }),
    );
  });

  test("真实发送 seam 与 Preview 使用同一次 compileBootstrap 输出", async () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const preview = compiler.preview(source);
    const sendBootstrap = vi.fn(() => Promise.resolve({ ok: true as const }));

    await expect(
      compiler.sendBootstrap(source, { sendBootstrap }),
    ).resolves.toEqual({ ok: true });
    expect(sendBootstrap).toHaveBeenCalledWith({
      provider: preview.compilation.provider,
      tools: preview.compilation.tools,
      modelId: source.modelBinding.modelId,
      maxOutputTokens: source.modelBinding.maxOutputTokens,
    });
  });

  test("Preview不改写输入或权威状态", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const before = structuredClone({
      world: source.world,
      endpoint: source.endpoint,
    });

    compiler.preview(source);

    expect({ world: source.world, endpoint: source.endpoint }).toEqual(before);
  });

  test("必需 catalog 只关联 state 目录的直接子文档，可选空目录会明确报告缺失", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: catalog, directory: states, maxEntries: 24 }
  - slot: { kind: additional_materials }
`;
    files["state/state.sam.yaml"] = `$document:
  id: status.sam-root
  ref: sam-root
  title: Sam的根级状态
  summary: 文件名带点，但不在 states 目录中。
  aliases: []
体力: 80
`;
    bindSnapshot(source, files);

    expect(() => compiler.compileBootstrap(source)).toThrow(
      expect.objectContaining<Partial<PromptCompilationError>>({
        code: "required_slot_missing",
      }),
    );

    delete files["state/state.sam.yaml"];
    files["state/states/sam.yaml"] = `$document:
  id: status.sam
  ref: sam-status
  title: Sam的当前状态
  summary: Sam频繁变化的体力与法力。
  aliases: []
体力: 80
法力: 40
`;
    bindSnapshot(source, files);
    const resolved = compiler.compileBootstrap(source);
    expect(resolved.coverage).toContainEqual(
      expect.objectContaining({
        slot: "catalog",
        source: "states",
        status: "resolved",
        complete: true,
      }),
    );
    expect(
      resolved.logicalMessages.find(({ role }) => role === "world_context")
        ?.markdown,
    ).toContain("Sam的当前状态 [ref: @sam-status]");

    delete files["state/states/sam.yaml"];
    files["control/frame.yaml"] = files["control/frame.yaml"].replace(
      "maxEntries: 24 }",
      "maxEntries: 24, required: false }",
    );
    bindSnapshot(source, files);
    const optional = compiler.compileBootstrap(source);
    expect(optional.coverage).toContainEqual({
      slot: "catalog",
      source: "states",
      status: "optional_missing",
      complete: false,
      continuation: "state_list",
      catalogEntries: [],
    });
    const optionalWorldContext = optional.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(optionalWorldContext).toContain(
      "An `optional_missing` location may have injected nothing",
    );
    expect(optionalWorldContext).toContain("it may have injected only part");

    files["state/states/sam.yaml"] = `$document:
  id: status.sam
  ref: sam-status
  title: Sam的当前状态
  summary: Sam频繁变化的体力与法力。
  aliases: []
体力: 80
法力: 40
`;
    files["state/states/damaged.yaml"] = "broken: [yaml\n";
    bindSnapshot(source, files);
    const mixed = compiler.compileBootstrap(source);
    expect(mixed.coverage).toContainEqual({
      slot: "catalog",
      source: "states",
      status: "optional_missing",
      complete: false,
      continuation: "state_list",
      catalogEntries: ["sam-status"],
    });
    const mixedWorldContext = mixed.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(mixedWorldContext).toContain("Sam的当前状态 [ref: @sam-status]");
    expect(mixedWorldContext).toContain("it may have injected only part");
  });

  test.each([
    [
      "模型窗口缺失",
      {
        modelBinding: {
          provider: "chat_completions",
          modelId: "invalid-model",
          contextWindowTokens: 0,
          maxOutputTokens: 2_000,
        },
      },
      "model_context_window_invalid",
    ],
    [
      "必需 slot 缺失",
      {
        world: worldWithFiles((files) => {
          files["state/current-situation.yaml"] = "";
        }),
      },
      "required_slot_missing",
    ],
    [
      "作者 slot 之间范围重叠",
      {
        world: worldWithFiles((files) => {
          files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
            "  - slot: { kind: additional_materials }\n",
            "  - slot: { kind: additional_materials }\n  - slot:\n      kind: node\n      document: situation.current\n      locator: { yaml: [情况] }\n",
          );
        }),
      },
      "material_overlap",
    ],
  ])("%s 会在发送前明确失败", (_name, override, code) => {
    const compiler = new FileNativePromptCompiler();
    expect(() =>
      compiler.compileBootstrap(
        input(override as Partial<FileNativePromptInput>),
      ),
    ).toThrow(
      expect.objectContaining<Partial<PromptCompilationError>>({ code }),
    );
  });

  test("覆盖报告把已完整注入的条目标成可直接写入，而不是邀请重读", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "  - slot: { kind: additional_materials }\n",
      "  - slot: { kind: additional_materials }\n  - slot:\n      kind: node\n      document: rule.cultivation\n      locator: { markdown: [金丹] }\n",
    );
    bindSnapshot(source, files);
    const worldContext = compiler
      .compileBootstrap(source)
      .logicalMessages.find(({ role }) => role === "world_context")?.markdown;
    expect(worldContext).toMatch(
      /^- current_situation: @current-situation · resolved · complete · full body injected$/mu,
    );
    expect(worldContext).toMatch(
      /^- reference_targets: @alex · resolved · complete · full body injected$/mu,
    );
    expect(worldContext).toMatch(
      /^- node: @cultivation · markdown:金丹 · resolved · complete · node injected$/mu,
    );
    // Entries with write authorization no longer invite another context_read.
    expect(worldContext).not.toMatch(
      /^- (current_situation|document|node): .*continue with context_read$/mu,
    );
    expect(worldContext).toContain(
      "`context_read` returns that same body and additionally exposes the current title, summary, and aliases",
    );
    expect(worldContext).toContain(
      "`world_patch` preserves metadata fields omitted from `set_metadata`",
    );
    // Injected text is already writable; headings expose the codec needed for locators.
    expect(worldContext).toContain(
      "Each material heading identifies its codec",
    );
    expect(worldContext).toContain(
      "## 当前情境 [ref: @current-situation · YAML]",
    );
    expect(worldContext).toContain(
      "## 修炼规则 [ref: @cultivation · Markdown]",
    );
  });

  test("history slot 把最近几条已提交叙事带进全新上下文，取最新且与清单去重", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "  - slot: { kind: additional_materials }\n",
      "  - slot: { kind: history, recent: 2 }\n  - slot: { kind: additional_materials }\n",
    );
    bindSnapshot(source, files);
    // Runtime builds history records in Authority order, which the compiler preserves.
    source.world.history = {
      "history-message-00000001-01-narrator-aaa": "最早的一段，不该被带上。",
      "history-message-00000002-01-player-bbb": "我把充电线收进背包。",
      "history-message-00000003-01-narrator-ccc":
        "Alex把那根缠成麻花的充电线拎起来晃了晃。",
    };
    const compiled = compiler.compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(worldContext).toContain("我把充电线收进背包。");
    expect(worldContext).toContain("缠成麻花的充电线拎起来晃了晃");
    expect(worldContext).not.toContain("最早的一段，不该被带上。");
    expect(
      compiled.coverage.filter(({ slot }) => slot === "history"),
    ).toHaveLength(2);

    // Re-selecting an injected history entry is deduplicated from the body.
    const withDuplicate = compiler.compileBootstrap({
      ...source,
      world: {
        ...source.world,
        additionalMaterials: [
          {
            kind: "history_message",
            message: "history-message-00000003-01-narrator-ccc",
          },
        ],
      },
    });
    const duplicateContext = withDuplicate.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(
      duplicateContext?.match(/缠成麻花的充电线拎起来晃了晃/gu),
    ).toHaveLength(1);
    expect(duplicateContext).not.toContain(
      "history-message-00000003-01-narrator-ccc",
    );
  });

  test("history slot 按权威消息顺序取最近记录且不向模型暴露内部消息 ID", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "  - slot: { kind: additional_materials }\n",
      "  - slot: { kind: history, recent: 2 }\n  - slot: { kind: additional_materials }\n",
    );
    bindSnapshot(source, files);
    const worldId = "world-8db5ee1717946c32b054ab17";
    source.world.history = {
      [`${worldId}.message.genesis.narrator`]: "开场白不应被当成最近消息。",
      [`${worldId}.message.9.player`]: "第九组玩家原文，不应被选中。",
      [`${worldId}.message.9.narrator`]: "第九组主持叙事，不应被选中。",
      [`${worldId}.message.15.player`]: "第十五组玩家原文。",
      [`${worldId}.message.15.narrator`]: "第十五组主持叙事。",
    };

    const compiled = compiler.compileBootstrap(source);
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;

    expect(worldContext).toContain("第十五组玩家原文。");
    expect(worldContext).toContain("第十五组主持叙事。");
    expect(worldContext).not.toContain("开场白不应被当成最近消息。");
    expect(worldContext).not.toContain("第九组");
    expect(worldContext).not.toContain(worldId);
    expect(worldContext).not.toContain("message.15");
    expect(worldContext).toContain("## Player input");
    expect(worldContext).toContain("## Host narrative");
  });

  test("只有 genesis 开场白时 history slot 如实报告为空且不重复注入开场白", () => {
    const compiler = new FileNativePromptCompiler();
    const source = input();
    const files = snapshotRecord(source);
    files["control/frame.yaml"] = files["control/frame.yaml"]!.replace(
      "  - slot: { kind: additional_materials }\n",
      "  - slot: { kind: history }\n  - slot: { kind: additional_materials }\n",
    );
    bindSnapshot(source, files);
    source.world.history = {
      "world-one.message.genesis.narrator":
        "这段开场白不能作为 recent history 再注入。",
    };
    source.playerInputPlacement = "append";
    source.world.additionalMaterials = [
      {
        kind: "history_message",
        message: "world-one.message.genesis.narrator",
      },
    ];
    const compiled = compiler.compileBootstrap(source);
    expect(compiled.coverage).toContainEqual({
      slot: "history",
      source: "most recent 2",
      status: "resolved",
      complete: true,
      continuation: null,
    });
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(worldContext).not.toContain(
      "这段开场白不能作为 recent history 再注入。",
    );
    expect(worldContext).toContain("Recent committed conversation");
    expect(worldContext).toContain(
      "this world has no earlier player input or host narrative",
    );
    expect(worldContext).toContain(
      "Do not call history tools merely to look for a previous message",
    );
  });

  test("模型选中已被 slot 注入的材料时去重而不是让整轮失败", () => {
    const compiler = new FileNativePromptCompiler();
    const compiled = compiler.compileBootstrap(
      input({
        world: {
          ...input().world,
          additionalMaterials: [
            { kind: "document", document: "situation.current" },
            { kind: "document", document: "situation.current" },
            {
              kind: "node",
              document: "situation.current",
              locator: { yaml: ["情况"] },
            },
          ],
        },
      }),
    );
    const worldContext = compiled.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown;
    expect(worldContext).toContain("Alex正在整理球衣。");
    expect(worldContext?.match(/Alex正在整理球衣。/gu)).toHaveLength(1);
    expect(
      compiled.coverage.filter(({ slot }) => slot === "current_situation"),
    ).toHaveLength(1);
  });

  test("稳定正文和缓存键不受 operation、宿主路径、本地身份或内部版本影响", () => {
    const compiler = new FileNativePromptCompiler();
    const first = compiler.compileBootstrap(input());
    const secondInput = input();
    secondInput.endpoint = {
      id: "another-endpoint",
      commit: "another-commit",
      operationId: "op-2",
    };
    secondInput.hostBinding.hostPresetId = "another-host-id";
    secondInput.world.controlFingerprint = "another-version";
    secondInput.world.hostPath = "/private/machine/path";
    const second = compiler.compileBootstrap(secondInput);

    expect(second.logicalMessages).toEqual(first.logicalMessages);
    expect(second.cache.stablePrefixFingerprint).toBe(
      first.cache.stablePrefixFingerprint,
    );
    expect(JSON.stringify(second.provider)).not.toMatch(
      /another-endpoint|another-commit|op-2|another-host-id|another-version|private\/machine/u,
    );
  });
});
