import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify, parseDocument } from "yaml";
import {
  FileNativePlayPresetStore,
  defaultPlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("portable ordered play preserves identities, disabled text, and protects required entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-play-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const files = {
    ...defaultPlayPresetFiles,
    "preset.yaml": stringify({
      format: "narraeon.play-preset/v2",
      name: "Ordered",
      callChain: "call-chain.yaml",
      mounts: [],
      extensions: [],
      playPrompts: [
        {
          id: "custom",
          kind: "user",
          name: "My text",
          enabled: false,
          body: "Retain this text",
        },
        { id: "world", kind: "world" },
        {
          id: "mechanics",
          kind: "builtin",
          builtin: "play.mechanics",
          enabled: true,
        },
      ],
    }),
  };
  const imported = await store.importPortable({ name: "Ordered", files });
  expect(imported.preset.validation).toEqual({ status: "valid" });
  expect(imported.preset.structure).toMatchObject({
    playPrompts: [
      {
        id: "custom",
        name: "My text",
        enabled: false,
        body: "Retain this text",
      },
      { id: "world", kind: "world" },
      { id: "mechanics", builtin: "play.mechanics", enabled: true },
    ],
  });
  await expect(
    store.importPortable({
      name: "Tampered",
      files: {
        ...files,
        "preset.yaml": files["preset.yaml"].replace(
          "enabled: true",
          "enabled: false",
        ),
      },
    }),
  ).rejects.toThrow();
});

import { vi } from "vitest";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
test.each([
  "chat_completions",
  "anthropic_messages",
  "openai_responses",
] as const)(
  "%s encodes interleaved instructions and complete world material in author order",
  async (provider) => {
    const root = await mkdtemp(join(tmpdir(), "ordered-body-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const files = {
      ...defaultPlayPresetFiles,
      "preset.yaml": stringify({
        format: "narraeon.play-preset/v2",
        name: "Ordered",
        callChain: "call-chain.yaml",
        mounts: [],
        extensions: [],
        playPrompts: [
          {
            id: "before",
            kind: "user",
            name: "Before",
            enabled: true,
            body: "BEFORE_WORLD",
          },
          { id: "world", kind: "world" },
          {
            id: "after",
            kind: "user",
            name: "After",
            enabled: true,
            body: "AFTER_WORLD",
          },
          {
            id: "disabled",
            kind: "user",
            name: "Disabled",
            enabled: false,
            body: "DO_NOT_INJECT",
          },
          {
            id: "mechanics",
            kind: "builtin",
            builtin: "play.mechanics",
            enabled: true,
          },
        ],
      }),
    };
    const imported = await store.importPortable({ name: "Ordered", files });
    const binding = await store.bindRevision(imported.preset.id);
    const input = createMinimalFileNativePreviewInput({
      provider,
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
      playerInput: "PLAYER_LAST",
      playerInputPlacement: "append",
    });
    const compiler = new FileNativePromptCompiler();
    const compilation = compiler.compilePlayCallChain(input, binding);
    expect(compiler.preview(input, binding).compilation).toEqual(
      compilation.bootstrap,
    );
    const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify(
          provider === "chat_completions"
            ? {
                choices: [{ message: { role: "assistant", content: "Done" } }],
              }
            : provider === "anthropic_messages"
              ? { content: [{ type: "text", text: "Done" }] }
              : {
                  output: [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Done" }],
                    },
                  ],
                },
        ),
        { status: 200 },
      ),
    );
    const host = new FileNativeModelHost(
      {
        provider,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "secret",
        modelId: "test",
        contextWindowTokens: 32000,
        maxOutputTokens: 2000,
      },
      fetch_,
    );
    await host.exchange({
      bootstrap: compilation.bootstrap,
      tools: compilation.toolUniverse,
      appended: [{ kind: "player", text: "PLAYER_LAST" }],
      maxOutputTokens: 2000,
    });
    const body = fetch_.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string")
      throw new Error("Expected a serialized request body");
    const expected = [
      "BEFORE_WORLD",
      "# World-state rules",
      "Dorm room 302",
      "AFTER_WORLD",
      "# Tools and response settlement",
      "PLAYER_LAST",
    ];
    for (const token of expected) expect(body).toContain(token);
    for (let i = 1; i < expected.length; i++)
      expect(body.indexOf(expected[i]!)).toBeGreaterThan(
        body.indexOf(expected[i - 1]!),
      );
    expect(body).not.toContain("DO_NOT_INJECT");
    expect(body).not.toContain("# Runtime play boundary");
    expect(body).not.toContain("# Player-visible narrative rules");
  },
);

import {
  legacyDefaultPlayPresetFilesForLocale,
  applyPlayPresetStructuredEditor,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { builtinPlayPrompts } from "../../src/shared/ordered-play-prompts.ts";
test("legacy migration retains disabled copies and resources while frozen requests remain unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-migrate-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const files = legacyDefaultPlayPresetFilesForLocale("en");
  files["blocks/style-horror.md"] =
    "# My disabled original\n\nPreserve **every** word & punctuation.";
  const imported = await store.importPortable({ name: "Legacy", files });
  const before = await store.freeze({ presetId: imported.preset.id });
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    playerInput: "Next",
    playerInputPlacement: "append",
  });
  const compiler = new FileNativePromptCompiler();
  const frozen = compiler.compilePlayCallChain(input, before);
  const exactBefore = JSON.stringify(frozen);
  const structure = imported.preset.structure!;
  expect(structure.migrationNotice).toContain("归并");
  expect(
    structure.playPrompts?.find(
      (entry) => entry.kind === "user" && entry.name === "My disabled original",
    ),
  ).toMatchObject({
    kind: "user",
    name: "My disabled original",
    enabled: false,
    body: files["blocks/style-horror.md"],
  });
  expect(
    structure.playPrompts?.filter((entry) => entry.kind === "builtin"),
  ).toHaveLength(1);
  const saved = await store.save({
    presetId: imported.preset.id,
    name: "Legacy",
    files,
    structure,
  });
  expect(saved.preset.draft?.validation).toEqual({ status: "valid" });
  await store.select(imported.preset.id);
  expect((await store.bindCurrent()).files["blocks/style-horror.md"]).toBe(
    files["blocks/style-horror.md"],
  );
  expect(await store.readRevision(imported.preset.id, before.revision)).toEqual(
    before,
  );
  expect(JSON.stringify(frozen)).toBe(exactBefore);
});

test("current builtin resolution, fixed clones and saved request text have separate lifetimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-builtin-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const preset = (await store.list()).presets[0]!;
  const structure = preset.structure!;
  const body = builtinPlayPrompts("en").find(
    (entry) => entry.id === "play.narrative",
  )!.body;
  structure.playPrompts!.push({
    id: "fixed-copy",
    kind: "user",
    name: "Fixed copy",
    enabled: true,
    body,
  });
  await store.save({
    presetId: preset.id,
    name: preset.name,
    files: preset.files,
    structure,
  });
  await store.select(preset.id);
  const binding = await store.bindCurrent();
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    playerInput: "Next",
    playerInputPlacement: "append",
  });
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  const old = compiler.compilePlayCallChain(input, binding);
  const frozen = JSON.stringify(old);
  compiler.setLocale("zh-CN");
  const latest = compiler.compilePlayCallChain(input, binding);
  expect(
    latest.bootstrap.logicalMessages.flatMap((message) => message.blocks),
  ).toEqual(
    expect.arrayContaining([
      { source: "preset:prompt/fixed-copy", markdown: body },
      {
        source: "runtime:ordered/play.narrative",
        markdown: builtinPlayPrompts("zh-CN").find(
          (entry) => entry.id === "play.narrative",
        )!.body,
      },
    ]),
  );
  expect(JSON.stringify(old)).toBe(frozen);
  expect(applyPlayPresetStructuredEditor(binding.files, structure)).toEqual(
    binding.files,
  );
});

test("save rejects removal, source substitution, downgrade and required-disable bypasses", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-permissions-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const preset = (await store.list()).presets[0]!;
  for (const mode of ["remove", "substitute", "disable"] as const) {
    const structure = structuredClone(preset.structure!);
    if (mode === "remove")
      structure.playPrompts = structure.playPrompts!.filter(
        (entry) => entry.id !== "play.state",
      );
    if (mode === "substitute")
      structure.playPrompts = structure.playPrompts!.map((entry) =>
        entry.id === "play.state"
          ? {
              id: entry.id,
              kind: "user",
              name: "Fake",
              enabled: true,
              body: "Forged",
            }
          : entry,
      );
    if (mode === "disable")
      structure.playPrompts = structure.playPrompts!.map((entry) =>
        entry.id === "play.mechanics" ? { ...entry, enabled: false } : entry,
      );
    await expect(
      store.save({
        presetId: preset.id,
        name: preset.name,
        files: preset.files,
        structure,
      }),
    ).rejects.toThrow();
  }
  await expect(
    store.save({
      presetId: preset.id,
      name: preset.name,
      files: legacyDefaultPlayPresetFilesForLocale("en"),
    }),
  ).rejects.toThrow();
  expect((await store.bindCurrent()).revision).toBe(preset.revision);
});

test.each(["en", "zh-CN"] as const)(
  "%s author targets reference enabled play semantics with the correct tree boundary",
  async (locale) => {
    const root = await mkdtemp(join(tmpdir(), "ordered-author-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const preset = (await store.list()).presets[0]!;
    const structure = preset.structure!;
    structure.playPrompts = structure.playPrompts!.map((entry) =>
      entry.kind === "builtin" && entry.builtin !== "play.mechanics"
        ? { ...entry, enabled: false }
        : entry,
    );
    structure.playPrompts.push({
      id: "custom-author-reference",
      kind: "user",
      name: "Reference",
      body: "ONLY_ENABLED_PLAY_POLICY",
      enabled: true,
    });
    await store.save({
      presetId: preset.id,
      name: preset.name,
      files: preset.files,
      structure,
    });
    await store.select(preset.id);
    const compiler = new FileNativePromptCompiler({ locale });
    const common = {
      runtimeContract: "AUTHOR_MECHANICS",
      authorPrompt: "AUTHOR_POLICY",
      playPreset: await store.bindCurrent(),
      modelBinding: {
        provider: "chat_completions" as const,
        modelId: "test",
        contextWindowTokens: 32000,
        maxOutputTokens: 2000,
      },
      tools: [],
    };
    const results = [
      compiler.compileSettingImprovement({
        ...common,
        contentPackageTitle: "Package",
      }),
      compiler.compileWorldRevision({ ...common, worldTitle: "World" }),
    ];
    for (const result of results) {
      const encoded = JSON.stringify(result.provider);
      expect(encoded).toContain("ONLY_ENABLED_PLAY_POLICY");
      expect(encoded).not.toContain("# Player-visible narrative rules");
      expect(encoded).not.toContain("# Tools and response settlement");
      expect(encoded).toContain(
        locale === "en" ? "Authoring tools and settlement" : "创作工具与结算",
      );
    }
    const references = results.map(
      (result) =>
        result.logicalMessages
          .flatMap(({ blocks }) => blocks)
          .find(({ source }) => source === "play-preset:author-reference")!
          .markdown,
    );
    expect(references[0]).toContain("world/");
    expect(references[1]).toContain("state/");
    expect(references[1]).not.toContain("world/");
    expect(references[1]).toContain(
      locale === "en" ? "play continues after Apply" : "应用后继续游玩",
    );
    expect(references[1]).not.toContain("opening.md");
  },
);

test("one damaged legacy frame stays inspectable without breaking the preset library", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-damaged-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const current = await store.bindCurrent();
  const files = legacyDefaultPlayPresetFilesForLocale("en");
  files["frame.yaml"] = "roles: { runtime_system: 123 }";
  const imported = await store.create("Repair me", files);
  expect(imported.preset.validation.status).toBe("invalid");
  const library = await store.list();
  expect(library.presets).toHaveLength(2);
  expect(
    library.presets.find((entry) => entry.id === imported.preset.id)?.files,
  ).toEqual(files);
  expect(await store.bindCurrent()).toEqual(current);
});

test("legacy derived names are bounded without truncating long or blank-heading originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-titles-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const files = legacyDefaultPlayPresetFilesForLocale("en");
  files["blocks/style.md"] = `# ${"x".repeat(200)}\n\nExact original text.`;
  files["blocks/style-noir.md"] = "#    \n\nExact disabled original.";
  const imported = await store.importPortable({ name: "Legacy", files });
  const structure = imported.preset.structure!;
  const saved = await store.save({
    presetId: imported.preset.id,
    name: "Legacy",
    files,
    structure,
  });
  expect(saved.preset.draft?.validation.status).toBe("valid");
  for (const path of ["blocks/style.md", "blocks/style-noir.md"])
    expect(
      structure.playPrompts?.some(
        (entry) =>
          entry.kind === "user" &&
          entry.body === files[path] &&
          entry.name.length <= 160 &&
          entry.name.trim().length > 0,
      ),
    ).toBe(true);
});

test.each(["escaped-v2", "unknown"] as const)(
  "import rejects %s before creating a preset",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ordered-import-gate-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const files = structuredClone(defaultPlayPresetFiles);
    files["preset.yaml"] = files["preset.yaml"]!.replace(
      "format: narraeon.play-preset/v2",
      mode === "unknown"
        ? "format: narraeon.play-preset/v99"
        : 'format: "narraeon.play-preset/v\\x32"',
    ).replace("enabled: true", "enabled: false");
    await expect(
      store.importPortable({ name: "Invalid", files }),
    ).rejects.toThrow();
    expect((await store.list()).presets).toHaveLength(1);
  },
);

test("author arrangement is independent, portable and enforces mandatory target blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-author-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const preset = await store.importPortable({
    name: "Author",
    files: defaultPlayPresetFiles,
  });
  expect(preset.preset.structure).toHaveProperty("authorPrompts");
  const raw = parseDocument(defaultPlayPresetFiles["preset.yaml"]!);
  raw.setIn(["authorPrompts", 0, "enabled"], false);
  const files = { ...defaultPlayPresetFiles, "preset.yaml": stringify(raw) };
  await expect(
    store.importPortable({ name: "Invalid author", files }),
  ).rejects.toThrow();
});

test("disabled author recommendations do not fall back and author saves preserve other arrangements", async () => {
  const root = await mkdtemp(join(tmpdir(), "author-disabled-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const original = await store.bindCurrent();
  const library = await store.list();
  const structure = library.presets[0]!.structure!;
  const originalPlay = structuredClone(structure.playPrompts);
  structure.authorPrompts = structure.authorPrompts!.map((entry) =>
    entry.kind === "builtin" &&
    ["author.guidance", "author.play-reference"].includes(entry.builtin)
      ? { ...entry, enabled: false }
      : entry,
  );
  structure.authorPrompts.push({
    id: "fixed-copy",
    kind: "user",
    name: "Fixed copy",
    enabled: true,
    body: "MY_FIXED_AUTHOR_TEXT",
  });
  await store.save({
    presetId: original.id,
    name: original.name,
    files: original.files,
    structure,
  });
  await store.select(original.id);
  const binding = await store.bindCurrent();
  expect(binding.definition.playPrompts).toEqual(originalPlay);
  expect(binding.definition.followups).toEqual(original.definition.followups);
  expect(binding.definition.playerViewPanels).toEqual(
    original.definition.playerViewPanels,
  );
  const compilation = new FileNativePromptCompiler().compileSettingImprovement({
    contentPackageTitle: "Test",
    runtimeContract: "NOT_A_FALLBACK",
    authorPrompt: "NOT_A_FALLBACK",
    playPreset: binding,
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
    tools: [],
  });
  const encoded = JSON.stringify(compilation.provider);
  expect(encoded).toContain("MY_FIXED_AUTHOR_TEXT");
  expect(encoded).not.toContain("NOT_A_FALLBACK");
  expect(encoded).not.toContain("Recommended setting-improvement method");
  expect(encoded).not.toContain("Future play semantics");
  const removed = {
    ...structure,
    authorPrompts: structure.authorPrompts.filter(
      (item) => item.id !== "author.guidance",
    ),
  };
  await expect(
    store.save({
      presetId: original.id,
      name: original.name,
      files: binding.files,
      structure: removed,
    }),
  ).rejects.toThrow("cannot be deleted");
});
