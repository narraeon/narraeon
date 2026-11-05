import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { parseDocument } from "yaml";
import {
  type PlayPresetStructuredEditor,
  FileNativePlayPresetStore,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("v0.7.10 current and draft convert once without changing historical revisions or user content", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("../fixtures/play-presets-v0710.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as {
    library: string;
    presetId: string;
    currentStructure: PlayPresetStructuredEditor;
    draftStructure: PlayPresetStructuredEditor;
  };
  const root = await mkdtemp(join(tmpdir(), "prompt-v0710-"));
  roots.push(root);
  const path = join(root, "file-native-play-presets.json");
  await writeFile(path, fixture.library);
  interface Library {
    presets: {
      id: string;
      revisions: Record<string, Record<string, string>>;
    }[];
  }
  const original = JSON.parse(fixture.library) as Library;
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  expect(store.recovery).toBeNull();
  const preset = (await store.list()).presets.find(
    (p) => p.id === fixture.presetId,
  )!;
  expect(preset.structure).toEqual(fixture.currentStructure);
  expect(preset.draft?.structure).toEqual(fixture.draftStructure);
  expect(parseDocument(preset.files["preset.yaml"]!).get("format")).toBe(
    "narraeon.play-preset/v3",
  );
  const converted = JSON.parse(await readFile(path, "utf8")) as Library;
  for (const before of original.presets) {
    const after = converted.presets.find(
      (p: { id: string }) => p.id === before.id,
    );
    for (const [revision, files] of Object.entries(before.revisions))
      expect(after!.revisions[revision]).toEqual(files);
  }
  const bytes = await readFile(path, "utf8");
  await new FileNativePlayPresetStore(root).initialize();
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test.each([false, true])(
  "fresh v3 editor, portable import and production compilation resolve a future catalog without changing revisions (required: %s)",
  async (required) => {
    const { vi } = await import("vitest");
    const builtins = await import("../../src/shared/ordered-play-prompts.ts");
    const { FileNativePromptCompiler, createMinimalFileNativePreviewInput } =
      await import("../../src/runtime/prompt/FileNativePromptCompiler.ts");
    const { isPlayPresetBinding } =
      await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
    const root = await mkdtemp(join(tmpdir(), "prompt-dynamic-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const initial = (await store.list()).presets[0]!;
    const structure = initial.structure!;
    structure.playPrompts!.splice(2, 0, {
      id: "clone",
      kind: "user",
      name: "Clone",
      enabled: true,
      body: "Frozen clone",
    });
    const output = structure.playPrompts!.find(
      (e) => e.kind === "builtin" && e.builtin === "play.output",
    )!;
    if (output.kind !== "builtin") throw new Error("Missing output");
    output.enabled = false;
    output.messageRole = "assistant";
    output.turnGuide = "";
    await store.save({
      presetId: initial.id,
      name: initial.name,
      files: initial.files,
      structure,
    });
    await store.select(initial.id);
    const frozen = await store.bindCurrent();
    const bytes = await readFile(
      join(root, "file-native-play-presets.json"),
      "utf8",
    );
    const original = builtins.builtinPlayPrompts;
    const spy = vi
      .spyOn(builtins, "builtinPlayPrompts")
      .mockImplementation((locale) => {
        const catalog = original(locale);
        const at = catalog.findIndex((e) => e.id === "play.output");
        catalog.splice(at + 1, 0, {
          id: "play.future",
          name: "Future",
          body: "NEW APPLICATION BODY",
          required,
          category: required ? "mechanics" : "policy",
        });
        return catalog;
      });
    try {
      const cold = new FileNativePlayPresetStore(root);
      await cold.initialize();
      const binding = await cold.bindCurrent();
      expect(binding.revision).toBe(frozen.revision);
      expect(
        await readFile(join(root, "file-native-play-presets.json"), "utf8"),
      ).toBe(bytes);
      const effective = (await cold.list()).presets[0]!.structure!.playPrompts!;
      expect(effective.find((e) => e.id === "play.future")).toMatchObject({
        enabled: true,
      });
      expect(effective.filter((e) => e.id !== "play.future")).toEqual(
        structure.playPrompts,
      );
      const compiler = new FileNativePromptCompiler();
      const input = createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "fixture",
        contextWindowTokens: 100000,
        maxOutputTokens: 1000,
        playerInput: "Next",
        playerInputPlacement: "append",
      });
      const production = compiler.compilePlayCallChain(input, binding);
      expect(
        production.bootstrap.logicalMessages.map((m) => m.markdown).join("\n"),
      ).toContain("NEW APPLICATION BODY");
      expect(compiler.preview(input, binding).compilation).toEqual(
        production.bootstrap,
      );
      const imported = await cold.importPortable({
        name: "Imported",
        files: await cold.exportPortable(initial.id),
      });
      expect(imported.preset.structure!.playPrompts).toEqual(effective);
      expect(
        (await cold.copy(initial.id)).preset.structure!.playPrompts,
      ).toEqual(effective);
      expect(isPlayPresetBinding(frozen)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
);

test("a frozen v3 binding survives default status/order changes and retired identities", async () => {
  const { vi } = await import("vitest");
  const builtins = await import("../../src/shared/ordered-play-prompts.ts");
  const {
    builtinDefaultPlayPresetBinding,
    isPlayPresetBinding,
    revisionForPlayPresetFiles,
  } = await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
  const frozen = builtinDefaultPlayPresetBinding("en");
  frozen.id = "historical";
  const entries = frozen.definition.playPrompts!.filter(
    (e) =>
      !(
        e.kind === "builtin" && ["play.prose", "play.scene"].includes(e.builtin)
      ),
  );
  entries.splice(1, 0, {
    id: "play.style",
    kind: "builtin",
    builtin: "play.style",
    enabled: false,
    messageRole: "assistant",
    turnGuide: "",
  });
  const raw = parseDocument(frozen.files["preset.yaml"]!);
  raw.set("playPrompts", {
    overrides: [
      {
        builtin: "play.style",
        enabled: false,
        messageRole: "assistant",
        turnGuide: "",
      },
    ],
    order: entries.map((e) =>
      e.kind === "builtin" ? `builtin:${e.builtin}` : `entry:${e.id}`,
    ),
  });
  frozen.files["preset.yaml"] = raw.toString();
  frozen.definition.files = structuredClone(frozen.files);
  frozen.definition.playPrompts = entries;
  frozen.revision = revisionForPlayPresetFiles(frozen.files);
  const original = builtins.builtinPlayPrompts;
  const spy = vi
    .spyOn(builtins, "builtinPlayPrompts")
    .mockImplementation((locale) =>
      original(locale)
        .reverse()
        .map((item) =>
          item.id === "play.output" ? { ...item, defaultEnabled: false } : item,
        )
        .concat([
          {
            id: "play.new-required",
            name: "New required",
            body: "new",
            required: true,
            category: "mechanics",
          },
        ]),
    );
  try {
    expect(isPlayPresetBinding(frozen)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("setting and world-revision compile fresh author defaults through the same persistent arrangement", async () => {
  const { vi } = await import("vitest");
  const authors = await import("../../src/shared/ordered-author-prompts.ts");
  const { FileNativePromptCompiler, createMinimalFileNativePreviewInput } =
    await import("../../src/runtime/prompt/FileNativePromptCompiler.ts");
  const root = await mkdtemp(join(tmpdir(), "author-catalog-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const before = await store.bindCurrent();
  const bytes = await readFile(
    join(root, "file-native-play-presets.json"),
    "utf8",
  );
  const original = authors.builtinAuthorPrompts;
  const spy = vi
    .spyOn(authors, "builtinAuthorPrompts")
    .mockImplementation((locale, target) => {
      const catalog = original(locale, target);
      catalog.splice(2, 0, {
        id: "author.future",
        name: "New author block",
        body: `NEW AUTHOR ${target ?? "setting"}`,
        required: false,
        category: "policy",
      });
      return catalog;
    });
  try {
    const binding = await store.bindCurrent();
    expect(binding.revision).toBe(before.revision);
    const compiler = new FileNativePromptCompiler();
    const input = createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "fixture",
      contextWindowTokens: 100000,
      maxOutputTokens: 1000,
      playerInput: "Next",
      playerInputPlacement: "append",
    });
    const common = {
      playPreset: binding,
      modelBinding: input.modelBinding,
      tools: [],
      runtimeContract: "runtime",
      authorPrompt: "write",
      gameplay: { mode: "interactive-fiction" as const },
    };
    const setting = compiler.compileSettingImprovement({
      ...common,
      contentPackageTitle: "Package",
    });
    const revision = compiler.compileWorldRevision({
      ...common,
      worldTitle: "World",
      epoch: { id: "epoch", baseHead: "head" },
    });
    expect(setting.logicalMessages.map((m) => m.markdown).join("\n")).toContain(
      "NEW AUTHOR setting",
    );
    expect(
      revision.logicalMessages.map((m) => m.markdown).join("\n"),
    ).toContain("NEW AUTHOR world-revision");
    expect(
      setting.logicalMessages.map((m) => m.markdown).join("\n"),
    ).not.toContain("World-revision tools");
    expect(
      revision.logicalMessages.map((m) => m.markdown).join("\n"),
    ).toContain("World-revision tools");
    expect(
      (await store.list()).presets[0]!.structure!.authorPrompts!.some(
        (e) => e.id === "author.future",
      ),
    ).toBe(true);
    expect(
      await readFile(join(root, "file-native-play-presets.json"), "utf8"),
    ).toBe(bytes);
  } finally {
    spy.mockRestore();
  }
});

test("the historical builtin-default sentinel validates released v2 bytes independently of current seed files", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("../fixtures/play-presets-v0710.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { library: string };
  const library = JSON.parse(fixture.library) as {
    presets: {
      name: string;
      currentRevision: string;
      revisions: Record<string, Record<string, string>>;
    }[];
  };
  const seed = library.presets.find((p) => p.name === "default")!;
  const files = seed.revisions[seed.currentRevision]!;
  const { parsePlayPresetFiles, isPlayPresetBinding } =
    await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  expect(
    isPlayPresetBinding({
      id: "builtin-default",
      name: "default",
      revision: "builtin-default-v1",
      definition: parsed.definition,
      files,
      scriptsEnabled: true,
    }),
  ).toBe(true);
});

test.each(["playPrompts", "authorPrompts"] as const)(
  "structured saves preserve an omitted %s list",
  async (omitted) => {
    const root = await mkdtemp(join(tmpdir(), "partial-structure-"));
    roots.push(root);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const initial = (await store.list()).presets[0]!;
    const structure = structuredClone(initial.structure!);
    delete structure[omitted];
    const edited = omitted === "playPrompts" ? "authorPrompts" : "playPrompts";
    structure[edited]!.push({
      id: "partial-edit",
      kind: "user",
      name: "Partial edit",
      body: "Keep this edit",
      enabled: true,
    });
    await store.save({
      presetId: initial.id,
      name: initial.name,
      files: initial.files,
      structure,
    });
    await store.select(initial.id);
    const saved = (await store.list()).presets[0]!;
    expect(saved.structure![omitted]).toEqual(initial.structure![omitted]);
    expect(saved.structure![edited]).toEqual(structure[edited]);
  },
);

test("a released v2 library upgrades when the current catalogs contain additional required blocks", async () => {
  const { vi } = await import("vitest");
  const play = await import("../../src/shared/ordered-play-prompts.ts");
  const author = await import("../../src/shared/ordered-author-prompts.ts");
  const { parsePlayPresetFiles, isPlayPresetBinding } =
    await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("../fixtures/play-presets-v0710.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { library: string; presetId: string; currentRevision: string };
  const library = JSON.parse(fixture.library) as {
    presets: {
      id: string;
      revisions: Record<string, Record<string, string>>;
    }[];
  };
  const root = await mkdtemp(join(tmpdir(), "skipped-prompt-upgrade-"));
  roots.push(root);
  const path = join(root, "file-native-play-presets.json");
  await writeFile(path, fixture.library);
  const originalPlay = play.builtinPlayPrompts,
    originalAuthor = author.builtinAuthorPrompts;
  const playSpy = vi
    .spyOn(play, "builtinPlayPrompts")
    .mockImplementation((locale) => [
      ...originalPlay(locale),
      {
        id: "play.new-required",
        name: "New required",
        body: "NEW PLAY MECHANICS",
        required: true,
        category: "mechanics",
      },
    ]);
  const authorSpy = vi
    .spyOn(author, "builtinAuthorPrompts")
    .mockImplementation((locale, target) => [
      ...originalAuthor(locale, target),
      {
        id: "author.new-required",
        name: "New author required",
        body: "NEW AUTHOR MECHANICS",
        required: true,
        category: "mechanics",
      },
    ]);
  try {
    const historicalFiles = library.presets.find(
      (p) => p.id === fixture.presetId,
    )!.revisions[fixture.currentRevision]!;
    const historical = parsePlayPresetFiles(historicalFiles);
    expect(historical.kind).toBe("valid");
    if (historical.kind !== "valid") throw historical.error;
    expect(
      isPlayPresetBinding({
        id: fixture.presetId,
        name: "Historical",
        revision: fixture.currentRevision,
        definition: historical.definition,
        files: historicalFiles,
        scriptsEnabled: true,
      }),
    ).toBe(true);
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    expect(store.recovery).toBeNull();
    const binding = await store.bindCurrent();
    expect(binding.id).toBe(fixture.presetId);
    expect(
      binding.definition.playPrompts!.find((e) => e.id === "play.new-required"),
    ).toMatchObject({ enabled: true });
    expect(
      binding.definition.authorPrompts!.find(
        (e) => e.id === "author.new-required",
      ),
    ).toMatchObject({ enabled: true });
    expect(
      (await store.bindRevision(fixture.presetId, fixture.currentRevision))
        .files,
    ).toEqual(historicalFiles);
    const bytes = await readFile(path, "utf8");
    await new FileNativePlayPresetStore(root).initialize();
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    playSpy.mockRestore();
    authorSpy.mockRestore();
  }
});

test("a future catalog identity cannot quarantine a preset with an existing builtin alias", async () => {
  const { vi } = await import("vitest");
  const play = await import("../../src/shared/ordered-play-prompts.ts");
  const { defaultPlayPresetFilesForLocale } =
    await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
  const root = await mkdtemp(join(tmpdir(), "catalog-alias-"));
  roots.push(root);
  const store = new FileNativePlayPresetStore(root);
  await store.initialize();
  const files = defaultPlayPresetFilesForLocale("en");
  const document = parseDocument(files["preset.yaml"]!);
  document.set("playPrompts", {
    overrides: [{ builtin: "play.prose", id: "play.future", enabled: false }],
  });
  files["preset.yaml"] = document.toString();
  const imported = await store.importPortable({ name: "Aliased", files });
  await store.select(imported.preset.id);
  const bytes = await readFile(
    join(root, "file-native-play-presets.json"),
    "utf8",
  );
  const original = play.builtinPlayPrompts;
  const spy = vi
    .spyOn(play, "builtinPlayPrompts")
    .mockImplementation((locale) => [
      {
        id: "play.future",
        name: "Future",
        body: "New body",
        required: false,
        category: "policy",
      },
      ...original(locale),
    ]);
  try {
    const cold = new FileNativePlayPresetStore(root);
    await cold.initialize();
    expect(cold.recovery).toBeNull();
    const binding = await cold.bindCurrent();
    expect(binding.revision).toBe(imported.preset.revision);
    expect(
      binding.definition.playPrompts!.find(
        (e) => e.kind === "builtin" && e.builtin === "play.prose",
      ),
    ).toMatchObject({ id: "play.future", enabled: false });
    expect(
      binding.definition.playPrompts!.find(
        (e) => e.kind === "builtin" && e.builtin === "play.future",
      ),
    ).toMatchObject({ id: "builtin-play.future-1", enabled: true });
    expect(
      await readFile(join(root, "file-native-play-presets.json"), "utf8"),
    ).toBe(bytes);
  } finally {
    spy.mockRestore();
  }
});

test("a frozen released v2 binding normalizes retired author identities as well as play identities", async () => {
  const { vi } = await import("vitest");
  const authors = await import("../../src/shared/ordered-author-prompts.ts");
  const { retiredBuiltinReplacements } =
    await import("../../src/shared/prompt-arrangement.ts");
  const { parsePlayPresetFiles, isPlayPresetBinding } =
    await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL("../fixtures/play-presets-v0710.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { library: string; presetId: string; currentRevision: string };
  const library = JSON.parse(fixture.library) as {
    presets: {
      id: string;
      revisions: Record<string, Record<string, string>>;
    }[];
  };
  const files = library.presets.find((p) => p.id === fixture.presetId)!
    .revisions[fixture.currentRevision]!;
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  const frozen = {
    id: fixture.presetId,
    name: "Released frozen preset",
    revision: fixture.currentRevision,
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
  expect(isPlayPresetBinding(frozen)).toBe(true);
  const before = JSON.stringify(frozen);
  const original = authors.builtinAuthorPrompts;
  retiredBuiltinReplacements["author.guidance"] = [
    { builtin: "author.guidance-v2" },
  ];
  const spy = vi
    .spyOn(authors, "builtinAuthorPrompts")
    .mockImplementation((locale, target) =>
      original(locale, target).map((item) =>
        item.id === "author.guidance"
          ? { ...item, id: "author.guidance-v2" }
          : item,
      ),
    );
  try {
    expect(isPlayPresetBinding(frozen)).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
    const root = await mkdtemp(join(tmpdir(), "author-retirement-"));
    roots.push(root);
    await writeFile(
      join(root, "file-native-play-presets.json"),
      fixture.library,
    );
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    expect(store.recovery).toBeNull();
    expect(
      (await store.bindCurrent()).definition.authorPrompts!.find(
        (e) => e.kind === "builtin" && e.builtin === "author.guidance-v2",
      ),
    ).toMatchObject({ enabled: false, messageRole: "user" });
    expect(
      (await store.bindRevision(fixture.presetId, fixture.currentRevision))
        .files,
    ).toEqual(files);
  } finally {
    spy.mockRestore();
    delete retiredBuiltinReplacements["author.guidance"];
  }
});
