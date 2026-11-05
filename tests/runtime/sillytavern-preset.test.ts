import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSillyTavernPreset,
  convertSillyTavernPreset,
} from "../../src/shared/sillytavern-preset.ts";
import { validatePlayPresetFiles } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

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
    expect(result.files["preset.yaml"]).toContain("Hello {{char}}");
    expect(result.files["preset.yaml"]).not.toContain("secret");
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
  const { FileNativePlayPresetStore } =
    await import("../../src/runtime/play/FileNativePlayPresetStore.ts");
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
  expect(result.files["preset.yaml"]).toContain("deep text");
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
