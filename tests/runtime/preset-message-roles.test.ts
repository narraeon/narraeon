import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseDocument, stringify } from "yaml";
import {
  FileNativePlayPresetStore,
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
  retargetFrozenCompilation,
  type ProviderKind,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { validPromptCompilation } from "../../src/runtime/prompt/PromptCompilationCodec.ts";
import type {
  OrderedPlayPrompt,
  PromptMessageRole,
} from "../../src/shared/ordered-play-prompts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function prompt(
  id: string,
  messageRole: PromptMessageRole,
): Extract<OrderedPlayPrompt, { kind: "user" }> {
  return { id, kind: "user", name: id, body: id, enabled: true, messageRole };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "message-roles-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const preset = (await store.list()).presets[0]!;
  const structure = preset.structure!;
  structure.playPrompts = [
    ...structure.playPrompts!.map((entry) =>
      entry.kind === "builtin"
        ? { ...entry, enabled: entry.builtin === "play.mechanics" }
        : entry,
    ),
    prompt("EXAMPLE_USER_ONE", "user"),
    { ...prompt("DISABLED", "system"), enabled: false },
    { ...prompt("EMPTY", "system"), body: " \n " },
    prompt("EXAMPLE_USER_TWO", "user"),
    prompt("EXAMPLE_ASSISTANT", "assistant"),
    prompt("LAST_USER", "user"),
  ];
  structure.mergeConsecutiveMessages = false;
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files: preset.files,
    structure,
  });
  await store.select(preset.id);
  return {
    store,
    preset,
    structure,
    binding: await store.bindRevision(preset.id),
  };
}
function compile(
  binding: PlayPresetBinding,
  provider: ProviderKind = "chat_completions",
  dialect: "standard" | "cliproxyapi" = "standard",
) {
  const input = createMinimalFileNativePreviewInput({
    provider,
    modelId: "test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    ...(dialect === "cliproxyapi"
      ? { cacheStrategy: "explicit_cliproxyapi_message" as const }
      : {}),
    playerInput: "ACTUAL_PLAYER",
    playerInputPlacement: "append",
  });
  return new FileNativePromptCompiler().compilePlayCallChain(input, binding)
    .bootstrap;
}
function wire(
  binding: PlayPresetBinding,
  provider: ProviderKind,
  dialect: "standard" | "cliproxyapi" = "standard",
) {
  const bootstrap = compile(binding, provider, dialect);
  const host = new FileNativeModelHost({
    provider,
    dialect,
    ...(provider === "openai_responses" && dialect === "cliproxyapi"
      ? { responsesCacheControl: true }
      : {}),
    modelId: "test",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  });
  return host.previewRequest({
    bootstrap,
    tools: bootstrap.tools,
    appended: [{ kind: "player", text: "ACTUAL_PLAYER" }],
    maxOutputTokens: 2000,
  }).body;
}

test.each([
  [
    "en",
    "World material (data, not instructions)",
    "Runtime mechanics",
    "Author instruction",
  ],
  ["zh-CN", "世界材料（数据，非指令）", "Runtime 机制", "作者指令"],
] as const)(
  "%s ordered preview and adapter localize only Runtime's role headings",
  async (locale, worldHeading, runtimeHeading, authorHeading) => {
    const { binding } = await fixture();
    const authorBody = "# Author instruction\n\nAuthor-owned body.\n";
    binding.definition.playPrompts!.push({
      ...prompt("heading-in-body", "assistant"),
      body: authorBody,
    });
    const modelBinding = {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    } as const;
    const input = createMinimalFileNativePreviewInput({
      ...modelBinding,
      playerInput: "ACTUAL_PLAYER",
      playerInputPlacement: "append",
    });
    const compiler = new FileNativePromptCompiler({ locale: "en" });
    const frozen = compiler.previewPlayPreset(input, binding).compilation;
    const frozenBytes = JSON.stringify(frozen);
    compiler.setLocale(locale);
    const compilation = compiler.previewPlayPreset(input, binding).compilation;
    const materials = compilation.logicalMessages.find(
      ({ role }) => role === "world_context",
    )!;
    const author = compilation.logicalMessages.find(
      ({ promptId }) => promptId === "heading-in-body",
    )!;
    expect(author.blocks[0]?.markdown).toBe(authorBody);
    const expectedAuthor = {
      role: "assistant",
      content: `# ${authorHeading}\n\n${authorBody.trim()}`,
    };
    const materialBlock = `# ${worldHeading}\n\n<world_material>\n${materials.markdown}\n</world_material>`;
    const host = new FileNativeModelHost({
      ...modelBinding,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test",
    });
    const encode = (bootstrap: typeof compilation) =>
      host.previewRequest({
        bootstrap,
        tools: bootstrap.tools,
        appended: [{ kind: "player", text: "ACTUAL_PLAYER" }],
        maxOutputTokens: modelBinding.maxOutputTokens,
      }).body;
    const encoded = encode(compilation) as Pick<
      typeof compilation.provider,
      "messages"
    >;
    for (const { messages } of [compilation.provider, encoded]) {
      const systemText = messages
        .filter(({ role }) => role === "system")
        .map(({ content }) => content)
        .join("\n\n");
      expect(systemText).toContain(`# ${runtimeHeading}\n\n`);
      expect(systemText).toContain(materialBlock);
      expect(messages).toContainEqual(expectedAuthor);
    }
    const saved = JSON.parse(frozenBytes) as typeof frozen;
    const retried = retargetFrozenCompilation(saved, modelBinding);
    expect(encode(retried)).toEqual(encode(frozen));
    expect(JSON.stringify(saved)).toBe(frozenBytes);
  },
);

test.each([false, true])(
  "Google 合并前导 System 来源并定位后续 System（merge=%s）",
  async (merge) => {
    const { binding } = await fixture();
    binding.definition.mergeConsecutiveMessages = merge;
    const bootstrap = compile(binding, "google_interactions");
    const host = new FileNativeModelHost({
      provider: "google_interactions",
      modelId: "test",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    });
    const request = {
      bootstrap,
      tools: bootstrap.tools,
      appended: [{ kind: "player" as const, text: "ACTUAL_PLAYER" }],
      maxOutputTokens: 2000,
    };
    const preview = host.previewRequest(request);
    expect(
      preview.systemInstructionSources?.map(({ promptId }) => promptId),
    ).toEqual(
      bootstrap.logicalMessages
        .filter(
          (item) =>
            item.messageRole === "system" && item.role !== "world_context",
        )
        .map(({ promptId }) => promptId),
    );
    expect(JSON.stringify(preview.body)).toContain("EXAMPLE_ASSISTANT");
    binding.definition.playPrompts!.push(
      prompt("LATE_SYSTEM_SOURCE", "system"),
    );
    request.bootstrap = compile(binding, "google_interactions");
    expect(() => host.previewRequest(request)).toThrow(/LATE_SYSTEM_SOURCE/);
  },
);

test.each([
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
] as const)(
  "%s sends configured roles and preserves the separate player append",
  async (provider) => {
    const { binding } = await fixture();
    const bootstrap = compile(binding, provider);
    expect(validPromptCompilation(JSON.parse(JSON.stringify(bootstrap)))).toBe(
      true,
    );
    const role = (role: string): unknown => expect.objectContaining({ role });
    const expected = [
      role("user"),
      role("user"),
      role("assistant"),
      role("user"),
      role("user"),
    ];
    if (provider !== "anthropic_messages") {
      const rules = role(
        provider === "openai_responses" ? "developer" : "system",
      );
      expected.unshift(rules, rules);
    }
    const preload: unknown[] =
      provider === "openai_responses"
        ? [
            role("user"),
            expect.objectContaining({ type: "function_call" }),
            expect.objectContaining({ type: "function_call_output" }),
          ]
        : [
            role("user"),
            role("assistant"),
            role(provider === "anthropic_messages" ? "user" : "tool"),
          ];
    expected.splice(expected.length - 1, 0, ...preload);
    expect(wire(binding, provider)).toMatchObject({
      [provider === "openai_responses" ? "input" : "messages"]: expected,
    });
    const serialized = JSON.stringify(wire(binding, provider));
    expect(serialized).not.toContain("DISABLED");
    expect(serialized).not.toContain("EMPTY");
    expect(serialized).toContain("EXAMPLE_ASSISTANT");
    expect(serialized.indexOf("ACTUAL_PLAYER")).toBeGreaterThan(
      serialized.indexOf("LAST_USER"),
    );
    // World instructions retain their configured role; material keeps its separate responsibility.
    expect(
      bootstrap.logicalMessages
        .filter((message) => message.promptId === "world")
        .map((message) => message.role),
    ).toEqual(["author_instruction", "world_context"]);
  },
);

test.each(["user", "assistant"] as const)(
  "CLIProxyAPI Responses caches through a trailing %s preset message",
  async (messageRole) => {
    const { binding } = await fixture();
    binding.definition.playPrompts!.at(-1)!.messageRole = messageRole;
    const body = wire(binding, "openai_responses", "cliproxyapi");
    const { input } = body as { input: Record<string, unknown>[] };
    const marked = input.filter(
      (message) => message.cache_control !== undefined,
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      role: messageRole,
      content: "# Author instruction\n\nLAST_USER",
      cache_control: { type: "ephemeral" },
    });
    expect(input.indexOf(marked[0]!)).toBeLessThan(
      input.findIndex((message) => message.type === "function_call"),
    );
  },
);

test("merges only adjacent prefix messages, persists on save/import, and changes the encoded cache identity", async () => {
  const { store, preset, structure, binding } = await fixture();
  const before = compile(binding);
  structure.mergeConsecutiveMessages = true;
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files: binding.files,
    structure,
  });
  await store.select(preset.id);
  const afterBinding = await store.bindRevision(preset.id);
  const after = compile(afterBinding);
  expect(after.provider.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
  ]);
  expect(after.provider.messages[1]!.content).toBe(
    "# Author instruction\n\nEXAMPLE_USER_ONE\n\nEXAMPLE_USER_TWO",
  );
  expect(after.cache.stablePrefixFingerprint).not.toBe(
    before.cache.stablePrefixFingerprint,
  );
  const body = wire(afterBinding, "chat_completions");
  expect(body).toMatchObject({
    messages: [
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { role: "user", content: "# Author instruction\n\nLAST_USER" },
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant" }),
      expect.objectContaining({ role: "tool" }),
      { role: "user", content: "ACTUAL_PLAYER" },
    ],
  });
  const imported = await store.importPortable({
    name: "Round trip",
    files: afterBinding.files,
  });
  const reopened = new FileNativePlayPresetStore(roots.at(-1)!);
  expect(
    compile(await reopened.bindRevision(imported.preset.id)).provider,
  ).toEqual(after.provider);
  expect(compile(binding).provider).toEqual(before.provider);

  // When merging is off, consecutive system author blocks share one heading,
  // while separate user/assistant preset messages each keep their own marker.
  const beforeSystemText = before.provider.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => String(content))
    .join("\n\n");
  expect(beforeSystemText.match(/^# Author instruction$/gmu)).toHaveLength(1);
  const beforeNonSystem = before.provider.messages.filter(
    ({ role }) => role !== "system",
  );
  expect(beforeNonSystem).toEqual([
    { role: "user", content: "# Author instruction\n\nEXAMPLE_USER_ONE" },
    { role: "user", content: "# Author instruction\n\nEXAMPLE_USER_TWO" },
    {
      role: "assistant",
      content: "# Author instruction\n\nEXAMPLE_ASSISTANT",
    },
    { role: "user", content: "# Author instruction\n\nLAST_USER" },
  ]);

  const anthropicBefore = compile(binding, "anthropic_messages");
  const anthropicSystemText = (anthropicBefore.provider.system ?? [])
    .map(({ text }) => text)
    .join("\n\n");
  expect(anthropicSystemText.match(/^# Author instruction$/gmu)).toHaveLength(
    1,
  );
  expect(anthropicBefore.provider.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "# Author instruction\n\nEXAMPLE_USER_ONE" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "# Author instruction\n\nEXAMPLE_USER_TWO" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "# Author instruction\n\nEXAMPLE_ASSISTANT" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "# Author instruction\n\nLAST_USER",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
});

test("deduplicates repeated # Author instruction headings across consecutive system author instructions with merge off, merge on, and Anthropic (#245)", async () => {
  const { store, preset, structure, binding } = await fixture();
  const baseSystemPrompts = structure.playPrompts!.filter(
    (entry) => entry.kind !== "user",
  );
  const worldIndex = baseSystemPrompts.findIndex(
    (entry) => entry.kind === "world",
  );
  structure.playPrompts = [
    ...baseSystemPrompts.slice(0, worldIndex),
    prompt("SYSTEM_AUTHOR_ONE", "system"),
    prompt("SYSTEM_AUTHOR_TWO", "system"),
    ...baseSystemPrompts.slice(worldIndex),
    prompt("EXAMPLE_USER_ONE", "user"),
    prompt("EXAMPLE_USER_TWO", "user"),
  ];
  structure.mergeConsecutiveMessages = false;
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files: binding.files,
    structure,
  });
  await store.select(preset.id);
  const unmergedBinding = await store.bindRevision(preset.id);

  // Merge OFF (chat_completions): two distinct consecutive system author bodies
  // keep their order while emitting # Author instruction only once; separate
  // user preset messages each keep their own heading.
  const unmerged = compile(unmergedBinding, "chat_completions");
  const unmergedSystem = unmerged.provider.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => String(content));
  const unmergedSystemJoined = unmergedSystem.join("\n\n");
  expect(unmergedSystemJoined).toContain("SYSTEM_AUTHOR_ONE");
  expect(unmergedSystemJoined).toContain("SYSTEM_AUTHOR_TWO");
  expect(unmergedSystemJoined.indexOf("SYSTEM_AUTHOR_ONE")).toBeLessThan(
    unmergedSystemJoined.indexOf("SYSTEM_AUTHOR_TWO"),
  );
  expect(unmergedSystemJoined.match(/^# Author instruction$/gmu)).toHaveLength(
    1,
  );
  expect(
    unmergedSystem.find((text) => text.includes("SYSTEM_AUTHOR_ONE")),
  ).toContain("# Author instruction");
  expect(
    unmergedSystem.find((text) => text.includes("SYSTEM_AUTHOR_TWO")),
  ).not.toContain("# Author instruction");
  expect(
    unmerged.provider.messages.filter(
      ({ role, content }) =>
        role === "user" && String(content).includes("EXAMPLE_USER_"),
    ),
  ).toEqual([
    { role: "user", content: "# Author instruction\n\nEXAMPLE_USER_ONE" },
    { role: "user", content: "# Author instruction\n\nEXAMPLE_USER_TWO" },
  ]);

  // Anthropic (merge OFF): system blocks preserve both bodies in order with one heading.
  const anthropicUnmerged = compile(unmergedBinding, "anthropic_messages");
  const anthropicUnmergedSystem = (anthropicUnmerged.provider.system ?? [])
    .map(({ text }) => text)
    .join("\n\n");
  expect(anthropicUnmergedSystem).toContain("SYSTEM_AUTHOR_ONE");
  expect(anthropicUnmergedSystem).toContain("SYSTEM_AUTHOR_TWO");
  expect(anthropicUnmergedSystem.indexOf("SYSTEM_AUTHOR_ONE")).toBeLessThan(
    anthropicUnmergedSystem.indexOf("SYSTEM_AUTHOR_TWO"),
  );
  expect(
    anthropicUnmergedSystem.match(/^# Author instruction$/gmu),
  ).toHaveLength(1);

  // Merge ON (chat_completions + Anthropic): both system bodies stay in order
  // with one heading, and adjacent user preset messages merge under one heading.
  structure.mergeConsecutiveMessages = true;
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files: unmergedBinding.files,
    structure,
  });
  await store.select(preset.id);
  const mergedBinding = await store.bindRevision(preset.id);
  const merged = compile(mergedBinding, "chat_completions");
  const mergedSystemJoined = merged.provider.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => String(content))
    .join("\n\n");
  expect(mergedSystemJoined).toContain("SYSTEM_AUTHOR_ONE");
  expect(mergedSystemJoined).toContain("SYSTEM_AUTHOR_TWO");
  expect(mergedSystemJoined.indexOf("SYSTEM_AUTHOR_ONE")).toBeLessThan(
    mergedSystemJoined.indexOf("SYSTEM_AUTHOR_TWO"),
  );
  expect(mergedSystemJoined.match(/^# Author instruction$/gmu)).toHaveLength(1);
  expect(
    merged.provider.messages.find(
      ({ role, content }) =>
        role === "user" && String(content).includes("EXAMPLE_USER_ONE"),
    ),
  ).toEqual({
    role: "user",
    content: "# Author instruction\n\nEXAMPLE_USER_ONE\n\nEXAMPLE_USER_TWO",
  });

  const anthropicMerged = compile(mergedBinding, "anthropic_messages");
  const anthropicMergedSystem = (anthropicMerged.provider.system ?? [])
    .map(({ text }) => text)
    .join("\n\n");
  expect(anthropicMergedSystem).toContain("SYSTEM_AUTHOR_ONE");
  expect(anthropicMergedSystem).toContain("SYSTEM_AUTHOR_TWO");
  expect(anthropicMergedSystem.indexOf("SYSTEM_AUTHOR_ONE")).toBeLessThan(
    anthropicMergedSystem.indexOf("SYSTEM_AUTHOR_TWO"),
  );
  expect(anthropicMergedSystem.match(/^# Author instruction$/gmu)).toHaveLength(
    1,
  );
});

test("old v2 presets retain the combined System prefix when optional fields are absent", async () => {
  const { binding } = await fixture();
  const { "orchestration.yaml": manifest, ...resources } = binding.files;
  const raw = parseDocument(manifest!);
  raw.set("format", "narraeon.play-preset/v2");
  raw.set("authorPrompts", binding.definition.authorPrompts);
  raw.delete("mergeConsecutiveMessages");
  raw.set(
    "playPrompts",
    binding.definition
      .playPrompts!.filter((entry) => entry.id !== "EMPTY")
      .map((entry) => {
        const legacy = { ...entry };
        delete legacy.messageRole;
        return legacy;
      }),
  );
  const files = { ...resources, "preset.yaml": stringify(raw) };
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  const old = { ...binding, definition: parsed.definition, files };
  const combined = compile(old).provider;
  expect(combined.messages).toHaveLength(1);
  expect(combined.messages[0]!.role).toBe("system");
  old.definition.mergeConsecutiveMessages = false;
  const separate = compile(old).provider;
  expect(separate.messages).toHaveLength(6);
  expect(
    separate.messages.map((message) => message.content).join("\n\n"),
  ).toEqual(combined.messages[0]!.content);
});

test("authoring and world revision use the same configured message roles", async () => {
  const { binding } = await fixture();
  binding.definition.authorPrompts!.push(
    prompt("AUTHOR_USER", "user"),
    prompt("AUTHOR_ASSISTANT", "assistant"),
  );
  const compiler = new FileNativePromptCompiler();
  const common = {
    playPreset: binding,
    modelBinding: {
      provider: "chat_completions" as const,
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
    tools: [],
  };
  for (const result of [
    compiler.compileSettingImprovement({
      gameplay: { mode: "interactive-fiction" },
      ...common,
      contentPackageTitle: "Package",
    }),
    compiler.compileWorldRevision({
      gameplay: { mode: "interactive-fiction" },
      ...common,
      worldTitle: "World",
    }),
  ]) {
    expect(
      result.provider.messages.slice(-2).map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(validPromptCompilation(result)).toBe(true);
  }
});

test("Anthropic reports unsupported interleaved System prompts without silently moving them", async () => {
  const { binding } = await fixture();
  binding.definition.playPrompts!.push(prompt("LATE_SYSTEM", "system"));
  expect(() => compile(binding, "anthropic_messages")).toThrow(
    "place all System prompts before",
  );
  expect(compile(binding).provider.messages.at(-1)).toMatchObject({
    role: "system",
  });
});

test.each([
  { path: ["mergeConsecutiveMessages"], value: "yes" },
  { path: ["playPrompts", 0, "messageRole"], value: "user" },
  { path: ["playPrompts", 1, "messageRole"], value: "tool" },
  { path: ["authorPrompts", 0, "messageRole"], value: "assistant" },
])(
  "portable validation rejects invalid role/merge settings: $path",
  ({ path, value }) => {
    const raw = parseDocument(defaultPlayPresetFiles["orchestration.yaml"]!);
    raw.setIn(path, value);
    expect(
      parsePlayPresetFiles({
        ...defaultPlayPresetFiles,
        "orchestration.yaml": stringify(raw),
      }).kind,
    ).toBe("invalid");
  },
);
