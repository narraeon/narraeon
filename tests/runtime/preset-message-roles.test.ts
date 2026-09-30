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
) {
  const input = createMinimalFileNativePreviewInput({
    provider,
    modelId: "test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    playerInput: "ACTUAL_PLAYER",
    playerInputPlacement: "append",
  });
  return new FileNativePromptCompiler().compilePlayCallChain(input, binding)
    .bootstrap;
}
function wire(binding: PlayPresetBinding, provider: ProviderKind) {
  const bootstrap = compile(binding, provider);
  const host = new FileNativeModelHost({
    provider,
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
    if (provider !== "anthropic_messages")
      expected.unshift(role("system"), role("system"));
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
    // A world placeholder remains one physical message with separate logical responsibilities.
    expect(
      bootstrap.logicalMessages
        .filter((message) => message.promptId === "world")
        .map((message) => message.role),
    ).toEqual(["author_instruction", "world_context"]);
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
    "# Author instruction\n\nEXAMPLE_USER_ONE\n\n# Author instruction\n\nEXAMPLE_USER_TWO",
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
});

test("old v2 presets retain the combined System prefix when optional fields are absent", async () => {
  const { binding } = await fixture();
  const raw = parseDocument(binding.files["preset.yaml"]!);
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
  const files = { ...binding.files, "preset.yaml": stringify(raw) };
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
    runtimeContract: "contract",
    authorPrompt: "author",
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
      ...common,
      contentPackageTitle: "Package",
    }),
    compiler.compileWorldRevision({ ...common, worldTitle: "World" }),
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
    const raw = parseDocument(defaultPlayPresetFiles["preset.yaml"]!);
    raw.setIn(path, value);
    expect(
      parsePlayPresetFiles({
        ...defaultPlayPresetFiles,
        "preset.yaml": stringify(raw),
      }).kind,
    ).toBe("invalid");
  },
);
