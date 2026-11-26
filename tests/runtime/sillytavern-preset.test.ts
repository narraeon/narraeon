import { describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSillyTavernPreset,
  convertSillyTavernPreset,
  prepareSillyTavernPresetImport,
} from "../../src/shared/sillytavern-preset.ts";
import {
  FileNativePlayPresetStore,
  validatePlayPresetFiles,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { SillyTavernSourceStore } from "../../src/runtime/play/SillyTavernSourceStore.ts";

const source = JSON.stringify({
  temperature: 1,
  proxy_password: "secret",
  prompts: [
    { identifier: "a", name: "A", role: "user", content: "first" },
    {
      identifier: "b",
      name: "B",
      role: "assistant",
      content: "Hello {{char}}",
    },
    { identifier: "chatHistory", name: "History", marker: true },
    {
      identifier: "unused",
      name: "Unused",
      role: "system",
      content: "unplaced",
    },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: "b", enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: "a", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "b", enabled: true },
      ],
    },
  ],
});

describe("SillyTavern import", () => {
  it("uses the global order and preserves unsupported and unplaced text disabled", () => {
    const preview = inspectSillyTavernPreset(source);
    expect(preview.settings).toContainEqual({
      path: "$.temperature",
      category: "sampling",
      value: 1,
    });
    expect(JSON.stringify(preview.settings)).not.toContain("secret");
    expect(preview.prompts.map((item) => item.id)).toEqual([
      "a",
      "chatHistory",
      "b",
      "unused",
    ]);
    const result = convertSillyTavernPreset(source, {
      name: "Imported",
      locale: "en",
      selected: ["a", "b", "unused"],
    });
    expect(validatePlayPresetFiles(result.files).status).toBe("valid");
    expect(result.files["orchestration.yaml"]).toContain("Hello {{char}}");
    expect(result.files["orchestration.yaml"]).not.toContain("secret");
    expect(result.files["assets/sillytavern-import-report.json"]).not.toContain(
      "secret",
    );
    expect(result.files["assets/sillytavern-import-report.json"]).not.toContain(
      "chatHistory",
    );
    expect(
      result.report.some((entry) => entry.code === "unsupported_macro"),
    ).toBe(true);
  });
});

it.each(["full", "character"])(
  "reads Prompt Manager %s and reports missing builtins",
  (type) => {
    const input = JSON.stringify({
      version: 1,
      type,
      data: {
        prompts: [
          {
            identifier: "custom",
            name: "Custom",
            role: "system",
            content: "plain",
          },
        ],
        prompt_order: [
          { identifier: "chatHistory", enabled: true },
          { identifier: "custom", enabled: false },
        ],
      },
    });
    const preview = inspectSillyTavernPreset(input);
    expect(preview.prompts[0]).toMatchObject({
      id: "chatHistory",
      missing: true,
    });
    expect(preview.prompts[1]).toMatchObject({ id: "custom", enabled: false });
    expect(
      convertSillyTavernPreset(input, {
        name: "Import",
        locale: "en",
        selected: ["custom"],
      }).target,
    ).toContainEqual({ name: "Custom", kind: "user", enabled: false });
  },
);

it("requires a group choice when no global order exists", () => {
  const input = JSON.stringify({
    prompts: [{ identifier: "a", content: "a" }],
    prompt_order: [
      { character_id: 1, order: [{ identifier: "a", enabled: true }] },
      { character_id: 2, order: [] },
    ],
  });
  expect(inspectSillyTavernPreset(input).prompts).toEqual([]);
  expect(() =>
    convertSillyTavernPreset(input, { name: "x", locale: "en", selected: [] }),
  ).toThrow("choose a character group");
  expect(inspectSillyTavernPreset(input, "1").prompts[0]?.id).toBe("a");
});

it("rejects malformed input and unknown or duplicate references without exposing JSON", () => {
  expect(() => inspectSillyTavernPreset('{"secret":"credential",')).toThrow(
    "invalid JSON",
  );
  expect(() =>
    inspectSillyTavernPreset(
      JSON.stringify({
        prompts: [],
        prompt_order: [
          {
            character_id: 100001,
            order: [{ identifier: "unknown", enabled: true }],
          },
        ],
      }),
    ),
  ).toThrow("unknown prompt reference");
  expect(() =>
    inspectSillyTavernPreset(
      JSON.stringify({
        version: 1,
        type: "full",
        data: {
          prompts: [
            { identifier: "a", content: "1" },
            { identifier: "a", content: "2" },
          ],
          prompt_order: [],
        },
      }),
    ),
  ).toThrow("duplicate identifier");
});

it("compiles selected static prompts in source order and roles, excluding disabled entries", async () => {
  const { FileNativePromptCompiler, createMinimalFileNativePreviewInput } =
    await import("../../src/runtime/prompt/FileNativePromptCompiler.ts");
  const input = JSON.stringify({
    version: 1,
    type: "full",
    data: {
      prompts: [
        {
          identifier: "one",
          name: "One",
          role: "user",
          content: "FIRST STATIC",
        },
        {
          identifier: "two",
          name: "Two",
          role: "assistant",
          content: "SECOND STATIC",
        },
        {
          identifier: "off",
          name: "Off",
          role: "system",
          content: "NOT SENT",
          injection_position: 1,
          injection_depth: 4,
          injection_order: 10,
          injection_trigger: ["continue"],
          forbid_overrides: true,
        },
      ],
      prompt_order: [
        { identifier: "one", enabled: true },
        { identifier: "off", enabled: false },
        { identifier: "two", enabled: true },
      ],
    },
  });
  const converted = convertSillyTavernPreset(input, {
    name: "Import",
    locale: "en",
    selected: ["one", "two", "off"],
  });
  const root = await mkdtemp(join(tmpdir(), "st-preset-"));
  try {
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const imported = await store.importPortable({
      name: "Import",
      files: converted.files,
    });
    const portable = await store.exportPortable(imported.preset.id);
    const again = await store.importPortable({
      name: "Again",
      files: portable,
    });
    expect(
      (await store.exportPortable(again.preset.id)).find(
        (file) => file.path === "assets/sillytavern-import-report.json",
      )?.contents,
    ).toBe(converted.files["assets/sillytavern-import-report.json"]);
    const metadata = JSON.parse(
      (await store.exportPortable(again.preset.id)).find(
        (file) => file.path === "assets/sillytavern-import-report.json",
      )!.contents,
    ) as { prompts: unknown[] };
    expect(metadata.prompts).toContainEqual(
      expect.objectContaining({
        sourceId: "off",
        injectionPosition: 1,
        injectionDepth: 4,
        injectionOrder: 10,
        triggers: ["continue"],
        forbidOverrides: true,
      }),
    );
    const binding = await store.bindRevision(imported.preset.id);
    const compiled = new FileNativePromptCompiler().compilePlayPreset(
      createMinimalFileNativePreviewInput({
        provider: "chat_completions",
        modelId: "test",
        contextWindowTokens: 64000,
        maxOutputTokens: 4096,
        playerInput: "Continue",
        playerInputPlacement: "append",
      }),
      binding,
    );
    const messages = compiled.bootstrap.logicalMessages.filter(
      (message) =>
        message.markdown.includes("STATIC") ||
        message.markdown.includes("NOT SENT"),
    );
    expect(
      messages.map((message) => [message.messageRole, message.markdown]),
    ).toEqual([
      ["user", "FIRST STATIC"],
      ["assistant", "SECOND STATIC"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps complete source order independently of the library and deduplicates cold and concurrent retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "st-source-"));
  try {
    const options = {
      name: "Imported",
      locale: "en",
      selected: ["unused", "a"],
    } as const;
    const { snapshot, conversion } = prepareSillyTavernPresetImport(source, {
      ...options,
      selected: [...options.selected],
    });
    expect(snapshot.groupId).toBe("100001");
    expect(
      snapshot.entries.map(({ id, order, enabled, selected, content }) => [
        id,
        order,
        enabled,
        selected,
        content,
      ]),
    ).toEqual([
      ["a", 0, true, true, "first"],
      ["chatHistory", 1, true, false, undefined],
      ["b", 2, true, false, undefined],
      ["unused", undefined, undefined, true, "unplaced"],
    ]);
    expect(snapshot.entries[1]).toMatchObject({ marker: true });
    expect(snapshot.entries[2]).toMatchObject({
      reasons: ["unsupported_macro"],
      macros: [],
    });
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const request = {
      name: options.name,
      files: conversion.files,
      snapshot,
      operationId: "import-request",
    };
    const [first, retry] = await Promise.all([
      store.importSillyTavern(request),
      store.importSillyTavern(request),
    ]);
    expect(first).toEqual(retry);
    expect(first.currentPresetId).not.toBe(first.preset.id);
    expect(first.preset.scriptsEnabled).toBe(false);
    const reopened = new FileNativePlayPresetStore(root);
    await reopened.initialize();
    expect(await reopened.importSillyTavern(request)).toEqual(first);
    await expect(
      reopened.importSillyTavern({ ...request, name: "Changed" }),
    ).rejects.toThrow("different selection");
    expect((await reopened.list()).presets).toHaveLength(2);
    expect(await reopened.readSillyTavernSource(first.preset.id)).toEqual({
      kind: "snapshot",
      snapshot,
    });

    const path = join(root, "orchestration-sillytavern-sources");
    const [sourceFile] = await readdir(path);
    const rawSnapshot = await readFile(join(path, sourceFile!), "utf8");
    expect(rawSnapshot).not.toMatch(/secret|Hello \{\{char\}\}/u);
    const rawLibrary = await readFile(
      join(root, "file-native-orchestrations.json"),
      "utf8",
    );
    expect(rawLibrary).not.toMatch(/chatHistory|Hello \{\{char\}\}|secret/u);
    const portable = await reopened.exportPortable(first.preset.id);
    expect(portable).toContainEqual({
      path: "assets/sillytavern-import-report.json",
      contents: conversion.files["assets/sillytavern-import-report.json"],
    });
    expect(JSON.stringify(portable)).not.toContain("chatHistory");

    const copied = await reopened.copy(first.preset.id);
    expect(await reopened.readSillyTavernSource(copied.preset.id)).toEqual({
      kind: "snapshot",
      snapshot,
    });
    expect(await readdir(path)).toHaveLength(2);
    await reopened.delete(first.preset.id);
    await expect(
      reopened.readSillyTavernSource(first.preset.id),
    ).rejects.toThrow();
    expect(await reopened.readSillyTavernSource(copied.preset.id)).toEqual({
      kind: "snapshot",
      snapshot,
    });
    expect(await readdir(path)).toHaveLength(1);
    await reopened.delete(copied.preset.id);
    expect(await readdir(path)).toEqual([]);
    const afterDeletion = new FileNativePlayPresetStore(root);
    await afterDeletion.initialize();
    await expect(afterDeletion.importSillyTavern(request)).rejects.toThrow(
      "not found",
    );
    expect((await afterDeletion.list()).presets).toHaveLength(1);
    expect(await readdir(path)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rolls back a staged source if library publication fails and sweeps interrupted source writes on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "st-source-rollback-"));
  try {
    const { snapshot, conversion } = prepareSillyTavernPresetImport(source, {
      name: "Imported",
      selected: ["a"],
      locale: "en",
    });
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const libraryPath = join(root, "file-native-orchestrations.json");
    const backupPath = join(root, "library-backup");
    const sourceDirectory = join(root, "orchestration-sillytavern-sources");
    const sidecars = new SillyTavernSourceStore(root);
    const originalSave = sidecars.save.bind(sidecars);
    const failLibrary = vi
      .spyOn(SillyTavernSourceStore.prototype, "save")
      .mockImplementationOnce(async (presetId, value) => {
        await originalSave(presetId, value);
        await rename(libraryPath, backupPath);
        await mkdir(libraryPath);
      });
    const request = {
      name: "Imported",
      files: conversion.files,
      snapshot,
      operationId: "retry-after-failure",
    };
    try {
      await expect(store.importSillyTavern(request)).rejects.toThrow();
      expect(await readdir(sourceDirectory)).toEqual([]);
    } finally {
      failLibrary.mockRestore();
      await rm(libraryPath, { recursive: true });
      await rename(backupPath, libraryPath);
    }
    expect((await store.list()).presets).toHaveLength(1);
    const imported = await store.importSillyTavern(request);
    await new SillyTavernSourceStore(root).save(
      "interrupted-before-library-publish",
      snapshot,
    );
    expect(await readdir(sourceDirectory)).toHaveLength(2);
    const reopened = new FileNativePlayPresetStore(root);
    await reopened.initialize();
    expect(await readdir(sourceDirectory)).toHaveLength(1);
    expect(
      await reopened.readSillyTavernSource(imported.preset.id),
    ).toMatchObject({ kind: "snapshot" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reconnects matching original source to an old report even after an author edits an imported block", async () => {
  const root = await mkdtemp(join(tmpdir(), "st-source-legacy-"));
  try {
    const store = new FileNativePlayPresetStore(root);
    await store.initialize();
    const { conversion, snapshot } = prepareSillyTavernPresetImport(source, {
      name: "Old import",
      selected: ["a"],
      locale: "en",
    });
    const reportPath = "assets/sillytavern-import-report.json";
    const oldTargetId = "st-1";
    const newTargetId = snapshot.entries[0]!.targetEntryId!;
    expect(oldTargetId).not.toBe(newTargetId);
    const { preset } = await store.importPortable({
      name: "Old import",
      files: {
        ...conversion.files,
        [reportPath]: conversion.files[reportPath]!.replace(
          `"targetId": "${newTargetId}"`,
          `"targetId": "${oldTargetId}"`,
        ),
        "orchestration.yaml": conversion.files[
          "orchestration.yaml"
        ]!.replaceAll(newTargetId, oldTargetId),
      },
    });
    await store.save({
      presetId: preset.id,
      name: preset.name,
      files: {
        ...preset.files,
        "orchestration.yaml": preset.files["orchestration.yaml"]!.replace(
          "body: first",
          "body: edited",
        ),
      },
    });
    await store.select(preset.id);
    expect(
      (await store.bindRevision(preset.id)).files["orchestration.yaml"],
    ).toContain("body: edited");
    expect(await store.readSillyTavernSource(preset.id)).toMatchObject({
      kind: "legacy",
      groupId: "100001",
    });
    await expect(
      store.associateSillyTavernSource(
        preset.id,
        source.replace('"first"', '"impostor"'),
      ),
    ).rejects.toThrow("does not match");
    const copy = (await store.copy(preset.id)).preset;
    expect(await store.readSillyTavernSource(copy.id)).toMatchObject({
      kind: "legacy",
    });
    const copySource = await store.associateSillyTavernSource(copy.id, source);
    const restored = await store.associateSillyTavernSource(preset.id, source);
    expect(copySource).toEqual(restored);
    expect(restored).toMatchObject({
      kind: "snapshot",
      snapshot: {
        entries: [
          { id: "a", content: "first", targetEntryId: oldTargetId },
          { id: "chatHistory" },
          { id: "b" },
        ],
      },
    });
    expect(await store.associateSillyTavernSource(preset.id, source)).toEqual(
      restored,
    );
    expect(
      (await store.bindRevision(preset.id)).files["orchestration.yaml"],
    ).toContain("body: edited");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves depth, triggers and unknown prompt semantics as disabled originals", () => {
  const input = JSON.stringify({
    version: 1,
    type: "character",
    data: {
      prompts: [
        {
          identifier: "depth",
          role: "user",
          name: "Depth",
          content: "deep text",
          injection_position: 1,
          injection_depth: 4,
          injection_order: 10,
        },
        {
          identifier: "trigger",
          role: "assistant",
          name: "Trigger",
          content: "conditional text",
          injection_trigger: ["continue"],
        },
        {
          identifier: "extra",
          role: "system",
          name: "Extra",
          content: "extra text",
          future_option: true,
        },
      ],
      prompt_order: ["depth", "trigger", "extra"].map((identifier) => ({
        identifier,
        enabled: true,
      })),
    },
  });
  const result = convertSillyTavernPreset(input, {
    name: "Import",
    locale: "en",
    selected: ["depth", "trigger", "extra"],
  });
  expect(result.target.filter((item) => item.kind === "user")).toEqual([
    { name: "Depth", kind: "user", enabled: false },
    { name: "Trigger", kind: "user", enabled: false },
    { name: "Extra", kind: "user", enabled: false },
  ]);
  expect(result.report.map((item) => item.code)).toEqual(
    expect.arrayContaining(["depth_injection", "trigger", "unsupported_field"]),
  );
  expect(result.files["orchestration.yaml"]).toContain("deep text");
  const metadata = JSON.parse(
    result.files["assets/sillytavern-import-report.json"]!,
  ) as { prompts: unknown[] };
  expect(metadata.prompts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceId: "depth",
        sourceEnabled: true,
        orderIndex: 0,
        injectionPosition: 1,
        injectionDepth: 4,
        injectionOrder: 10,
      }),
      expect.objectContaining({ sourceId: "trigger", triggers: ["continue"] }),
    ]),
  );
  expect(result.files["assets/sillytavern-import-report.json"]).toContain(
    "future_option",
  );
});

it.each(["<GROUP>", "<CHARIFNOTGROUP>"])(
  "disables legacy macro %s",
  (macro) => {
    const input = JSON.stringify({
      version: 1,
      type: "full",
      data: {
        prompts: [
          {
            identifier: "a",
            name: "A",
            content: `Hello ${macro}`,
            role: "system",
          },
        ],
        prompt_order: [{ identifier: "a", enabled: true }],
      },
    });
    const converted = convertSillyTavernPreset(input, {
      name: "Import",
      locale: "en",
      selected: ["a"],
    });
    expect(converted.target).toContainEqual({
      name: "A",
      kind: "user",
      enabled: false,
    });
    expect(converted.report.map((item) => item.code)).toContain(
      "unsupported_macro",
    );
  },
);

it("rejects unknown order fields rather than changing their semantics", () => {
  const input = JSON.stringify({
    version: 1,
    type: "full",
    data: {
      prompts: [{ identifier: "a", content: "hello" }],
      prompt_order: [
        { identifier: "a", enabled: true, injection_trigger: ["continue"] },
      ],
    },
  });
  expect(() => inspectSillyTavernPreset(input)).toThrow("unknown order field");
});
