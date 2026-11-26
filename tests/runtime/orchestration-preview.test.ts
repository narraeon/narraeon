import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  fictionGameplay,
  gameplayFile,
  type Gameplay,
} from "../../src/protocol/gameplay.ts";
import type { OrchestrationPreviewResult } from "../../src/protocol/orchestrationPreview.ts";
import { mayChangeUserState } from "../../src/protocol/requestEffect.ts";
import {
  parseV1Envelope,
  v1Protocol,
  type V1Request,
} from "../../src/protocol/v1.ts";
import {
  ContentWorkspace,
  minimalFileNativeContentScaffold,
} from "../../src/runtime/content/ContentWorkspace.ts";
import {
  applyPlayPresetStructuredEditor,
  builtinDefaultPlayPresetBinding,
  parsePlayPresetFiles,
  presetHostBinding,
  toPlayPresetStructuredEditor,
  type FileNativePlayPresetLibrary,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { compileOrchestrationPreview } from "../../src/runtime/play/OrchestrationPreview.ts";
import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import type { AppLocale } from "../../src/protocol/appPreferences.ts";
import type { OrderedPlayPrompt } from "../../src/shared/ordered-play-prompts.ts";
import { turnGuideWarnings } from "../../src/shared/turn-guide.ts";

const modelBinding = {
  provider: "chat_completions",
  modelId: "unrequested-fixture",
  contextWindowTokens: 8192,
  maxOutputTokens: 1024,
} as const;
const tabletop = { mode: "tabletop", scheme: "d100" } as const;

afterEach(() => vi.restoreAllMocks());

function fixture(
  locale: AppLocale,
  mergeConsecutiveMessages = true,
): PlayPresetBinding {
  const base = builtinDefaultPlayPresetBinding(locale);
  const structure = toPlayPresetStructuredEditor(base.definition);
  const user = (
    id: string,
    messageRole: "assistant" | "user",
    extra: Partial<OrderedPlayPrompt> = {},
  ) =>
    ({
      id,
      kind: "user",
      messageRole,
      enabled: true,
      name: id,
      body: "  Content " + id + "  ",
      ...extra,
    }) as OrderedPlayPrompt;
  // Choose one effective member, override a built-in line and place the world
  // between static messages. The portable codec resolves this as it does on save.
  const play = structure.playPrompts!.map((entry): OrderedPlayPrompt =>
    entry.kind === "builtin" && entry.builtin.startsWith("play.agency-")
      ? { ...entry, enabled: entry.builtin === "play.agency-open" }
      : entry.kind === "builtin" && entry.builtin === "play.prose"
        ? { ...entry, turnGuide: "Explicit override." }
        : entry,
  );
  const world = play.findIndex((entry) => entry.kind === "world");
  play.splice(world, 0, user("before-world", "user"));
  play.splice(
    world + 2,
    0,
    user("after-world", "user", { gameplay: "tabletop" }),
  );
  play.push(
    user("same-role", "user"),
    user("blank", "assistant", { body: " " }),
    ...Array.from({ length: 11 }, (_, index): OrderedPlayPrompt => ({
      id: `line-${index}`,
      kind: "tail",
      enabled: true,
      name: `Line ${index}`,
      body: index === 0 ? "字".repeat(121) : `Static tail ${index}`,
    })),
  );
  const author = structure.authorPrompts!.map((entry) =>
    entry.kind === "builtin" && entry.builtin === "author.play-reference"
      ? { ...entry, enabled: true }
      : entry,
  );
  const files = applyPlayPresetStructuredEditor(base.files, {
    ...structure,
    playPrompts: play,
    authorPrompts: author,
    mergeConsecutiveMessages,
  });
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return { ...base, files, definition: parsed.definition };
}

test.each([
  { locale: "en", gameplay: fictionGameplay, merge: true },
  { locale: "zh-CN", gameplay: tabletop, merge: true },
  { locale: "en", gameplay: tabletop, merge: false },
] as const)(
  "play preview agrees with independent production bootstrap ($locale $gameplay.mode merge=$merge)",
  ({ locale, gameplay, merge }) => {
    const binding = fixture(locale, merge);
    const content = minimalFileNativeContentScaffold(locale);
    const worldMarker = "Contents from an independent world fixture.";
    const materialMarker = "State exposed only to production.";
    const files = content.map((file) => ({
      path: file.path.replace(/^world\//u, "state/"),
      contents:
        file.path === "control/frame.yaml"
          ? file.contents.replace(
              /instructions:\n/u,
              "instructions:\n  - markdown: blocks/preview-fixture.md\n    turnGuide: 'World-only tail'\n",
            )
          : file.path.startsWith("world/")
            ? file.contents + "\nmarker: " + materialMarker + "\n"
            : file.contents,
    }));
    files.push(
      { path: "control/blocks/preview-fixture.md", contents: worldMarker },
      ...(gameplay.mode === "tabletop" ? [gameplayFile(gameplay)] : []),
    );
    const modelPrompt = {
      connectionName: "Fixture model",
      markdown: "   Connection text   ",
    };
    const production = new FileNativePromptCompiler({
      locale,
    }).compilePlayCallChain(
      {
        endpoint: { id: "world-fixture", commit: "genesis" },
        hostBinding: presetHostBinding(binding),
        world: {
          controlFingerprint: "fixture",
          documentSnapshot: WorldDocumentStore.open({
            layout: "world_state",
            files,
          }),
          additionalMaterials: [],
        },
        playerInputPlacement: "append",
        playerInput: "Private player input.",
        turnNote: "Private player note.",
        modelBinding,
        modelPrompt,
      },
      binding,
    ).bootstrap;
    const result = compileOrchestrationPreview({
      surface: "play",
      binding,
      locale,
      gameplay,
      connection: { provider: modelBinding.provider, modelPrompt },
    });
    expect(
      result.entries.flatMap(({ id, markdown }) =>
        markdown === undefined ? [] : [{ id, markdown }],
      ),
    ).toEqual(
      production.logicalMessages
        .filter(
          ({ promptId, role }) =>
            promptId !== undefined &&
            promptId !== "world" &&
            role !== "world_context",
        )
        .map(({ promptId, markdown }) => ({ id: promptId, markdown })),
    );
    expect(result.messages.map(({ role }) => role)).toEqual(
      production.provider.messages.map(({ role }) => role),
    );
    expect(
      result.messages.some(
        ({ conditional, entryIds }) =>
          conditional && entryIds.includes("world"),
      ),
    ).toBe(true);
    expect(
      result.turnGuide?.lines.map(({ source, text }) => ({ source, text })),
    ).toEqual(
      production.turnGuide?.lines.filter(({ source }) =>
        source.startsWith("preset:"),
      ),
    );
    const turnGuide = result.turnGuide!;
    expect(turnGuide.worldLineInsertIndex).toBe(
      production.turnGuide?.lines.findIndex(({ source }) =>
        source.startsWith("world:"),
      ),
    );
    expect(turnGuide.warnings).toEqual(turnGuideWarnings(turnGuide.lines));
    expect(turnGuide.warnings.map(({ kind }) => kind)).toEqual([
      "line_length",
      "line_count",
    ]);
    expect(turnGuide.lineCount).toBe("over-limit");
    expect(
      result.entries.find(({ id }) => id === "play.agency-open")?.enabled,
    ).toBe(true);
    expect(
      result.entries.find(({ id }) => id === "play.agency-default")?.enabled,
    ).toBe(false);
    expect(result.entries.find(({ id }) => id === "after-world")?.applies).toBe(
      gameplay.mode === "tabletop",
    );
    expect(result.placeholders.map(({ kind }) => kind)).toEqual([
      "world-instructions",
      "world-material",
      "world-turn-guide",
      "player-turn-note",
    ]);
    for (const privateText of [
      worldMarker,
      materialMarker,
      "Private player input.",
      "Private player note.",
      "World-only tail",
    ])
      expect(JSON.stringify(result)).not.toContain(privateText);
  },
);

test.each(["en", "zh-CN"] as const)(
  "both author targets match production and exclude real instance data (%s)",
  (locale) => {
    const binding = fixture(locale);
    const compiler = new FileNativePromptCompiler({ locale });
    const common = {
      gameplay: tabletop,
      playPreset: binding,
      modelBinding,
      tools: [],
    };
    for (const authorTarget of ["setting", "world-revision"] as const) {
      const production =
        authorTarget === "setting"
          ? compiler.compileSettingImprovement({
              ...common,
              contentPackageTitle: "Hidden package label",
            })
          : compiler.compileWorldRevision({
              ...common,
              worldTitle: "Hidden world label",
              epoch: { id: "Hidden epoch", baseHead: "Hidden head" },
            });
      const result = compileOrchestrationPreview({
        surface: "author",
        authorTarget,
        binding,
        locale,
        gameplay: tabletop,
        connection: { provider: modelBinding.provider },
      });
      for (const message of production.logicalMessages) {
        if (message.promptId === "author.target") continue;
        expect(
          result.entries.find(({ id }) => id === message.promptId)?.markdown,
        ).toBe(message.markdown);
      }
      expect(
        result.entries.find(({ id }) => id === "author.target")?.markdown,
      ).toBe(
        production.logicalMessages
          .find(({ promptId }) => promptId === "author.target")
          ?.blocks[1]?.markdown.trim(),
      );
      expect(result.turnGuide).toBeUndefined();
      expect(result.placeholders.map(({ kind }) => kind)).toEqual([
        "author-target",
        "author-preload",
      ]);
      expect(JSON.stringify(result)).not.toContain("Hidden");
    }
  },
);

test("protocol diagnostics distinguish missing connections, fixed Anthropic errors and conditional author preload", () => {
  const binding = fixture("en");
  const common = { binding, locale: "en", gameplay: fictionGameplay } as const;
  expect(
    compileOrchestrationPreview({ ...common, surface: "play" }).protocol,
  ).toEqual({ status: "not-checked" });
  expect(
    compileOrchestrationPreview({
      ...common,
      surface: "play",
      connection: { provider: "anthropic_messages" },
    }).protocol,
  ).toMatchObject({ status: "incompatible", conflictingIds: ["world"] });
  expect(
    compileOrchestrationPreview({
      ...common,
      surface: "play",
      connection: { provider: "google_interactions" },
    }).protocol,
  ).toMatchObject({ status: "conditional", conflictingIds: ["world"] });

  const author = binding.definition.authorPrompts!;
  author.push({
    kind: "user",
    id: "last",
    name: "Final instruction",
    enabled: true,
    messageRole: "user",
    body: "Read carefully.",
  });
  const compiler = new FileNativePromptCompiler({ locale: "en" });
  const anthropic = {
    ...modelBinding,
    provider: "anthropic_messages" as const,
  };
  const input = {
    contentPackageTitle: "A real test identity",
    gameplay: fictionGameplay,
    playPreset: binding,
    modelBinding: anthropic,
    tools: [],
  };
  expect(() => compiler.compileSettingImprovement(input)).not.toThrow();
  expect(() =>
    compiler.compileSettingImprovement({
      ...input,
      preload: [
        { source: "fixture:package", markdown: "Preloaded instruction" },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: "prompt_role_order_unsupported" }));
  expect(
    compileOrchestrationPreview({
      ...common,
      surface: "author",
      connection: { provider: anthropic.provider },
    }).protocol,
  ).toMatchObject({
    status: "conditional",
    conflictingIds: ["runtime.preload"],
  });
});

test("Runtime scope and preview do not access instances, dispatch or save revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-orchestration-preview-"));
  try {
    const runtime = await createRuntime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
      logRoot: join(root, "logs"),
    });
    const access = [
      vi.spyOn(ContentWorkspace.prototype, "listCurrentTreeContentPackages"),
      vi.spyOn(ContentWorkspace.prototype, "readCurrentTreeContentPackage"),
      vi.spyOn(FileNativeWorldStore.prototype, "listWorlds"),
      vi.spyOn(FileNativeWorldStore.prototype, "currentHead"),
      vi.spyOn(globalThis, "fetch"),
    ];
    async function request<T>(input: V1Request): Promise<T> {
      return (await runtime.handle(input)).result as T;
    }
    const library = await request<{ playPresets: FileNativePlayPresetLibrary }>(
      {
        type: "workspace.read",
        scope: "orchestration",
      },
    );
    const current = library.playPresets.presets[0]!;
    const common = {
      type: "play.orchestration.preview",
      presetId: current.id,
      revision: current.revision,
      surface: "play",
      gameplay: fictionGameplay,
    } as const;
    const currentPreview = await request<OrchestrationPreviewResult>(common);
    expect(currentPreview).toMatchObject({
      selectedKind: "current",
      comparison: { changes: [] },
    });

    const candidateFiles = fixture(
      "en",
      !currentPreview.selected.mergeConsecutiveMessages,
    ).files;
    const candidate = await request<OrchestrationPreviewResult>({
      ...common,
      candidate: { files: candidateFiles },
    });
    expect(candidate).toMatchObject({
      selectedKind: "candidate",
      candidateBaseRevision: current.revision,
      comparison: {
        baseRevision: current.revision,
        mergeConsecutiveMessagesChanged: true,
      },
    });
    const before = candidate.comparison.changes.find(
      ({ identity }) => identity === "entry:before-world",
    );
    expect(before?.after?.markdown).toBe("Content before-world");
    const after = candidate.comparison.changes.find(
      ({ identity }) => identity === "entry:after-world",
    );
    expect(after?.after?.configuredMarkdown).toBe("  Content after-world  ");
    expect(await request({ type: "play.read" })).toEqual(library.playPresets);
    const saved = await request<{
      preset: FileNativePlayPresetLibrary["presets"][number];
    }>({
      type: "play.save",
      presetId: current.id,
      name: current.name,
      files: candidateFiles,
    });
    const draft = await request<OrchestrationPreviewResult>({
      ...common,
      revision: saved.preset.draft!.revision,
    });
    expect(draft).toMatchObject({
      selectedKind: "draft",
      comparison: candidate.comparison,
    });
    expect(draft.selected).toEqual(candidate.selected);
    expect(mayChangeUserState(common.type)).toBe(false);
    for (const spy of access) expect(spy).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public preview request rejects instance fields and invalid assumptions", () => {
  const input = {
    type: "play.orchestration.preview",
    presetId: "a",
    revision: "b",
    surface: "play",
    gameplay: fictionGameplay,
  };
  expect(() =>
    parseV1Envelope({ protocol: v1Protocol, request: input }),
  ).not.toThrow();
  for (const invalid of [
    { ...input, worldId: "world" },
    { ...input, packageId: "package" },
    { ...input, gameplay: { mode: "tabletop" } as Gameplay },
    { ...input, authorTarget: "setting" },
  ])
    expect(() =>
      parseV1Envelope({ protocol: v1Protocol, request: invalid }),
    ).toThrow();
});
