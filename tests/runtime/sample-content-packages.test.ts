import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import { readGameplay, type Gameplay } from "../../src/protocol/gameplay.ts";
import {
  sampleContentPackageIds,
  type SampleContentPackageId,
} from "../../src/protocol/sampleContentPackages.ts";
import type { RenderedPlayerView } from "../../src/protocol/playerViews.ts";
import {
  parseV1Envelope,
  v1Protocol,
  type ContentTreeFile,
  type V1PlayCallChainEvent,
  type V1PlayCallChainView,
  type V1Request,
} from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("sample creation requires a supported locale and only allows an optional built-in story ID", () => {
  for (const locale of appLocales)
    expect(
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type: "content.create-sample", locale },
      }).request,
    ).toEqual({ type: "content.create-sample", locale });
  for (const sampleId of sampleContentPackageIds)
    expect(
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type: "content.create-sample", locale: "en", sampleId },
      }).request,
    ).toEqual({ type: "content.create-sample", locale: "en", sampleId });
  for (const fields of [
    {},
    { locale: "en", story: "missing-reel" },
    { locale: "en", sampleId: null },
    { locale: "fr" },
    { locale: null },
    { locale: "" },
    { locale: "en", sampleId: "special" },
  ])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type: "content.create-sample", ...fields },
      }),
    ).toThrow();
});

const expectedSampleGameplay: Record<SampleContentPackageId, Gameplay> = {
  "rainy-inn": { mode: "interactive-fiction" },
  "tide-vault": { mode: "interactive-fiction" },
  "missing-reel": { mode: "interactive-fiction" },
  "lost-signal": { mode: "interactive-fiction" },
  "screening-night": { mode: "interactive-fiction" },
  "last-proof": { mode: "interactive-fiction" },
  "fogbell-harbor": { mode: "tabletop", scheme: "d100" },
  "qingzhou-tales": { mode: "tabletop", scheme: "bag" },
  "treasure-island": { mode: "tabletop", scheme: "d20" },
  "baker-street-fog": { mode: "interactive-fiction" },
};

describe.each(appLocales)(
  "all built-in sample content packages (%s)",
  (locale) => {
    test("every built-in story is usable, creates a world, compiles a clean preview, and renders player views without diagnostics", async () => {
      const { runtime } = await setup();
      const network = vi.spyOn(globalThis, "fetch");
      await request(runtime, { type: "preferences.save", locale });
      const model = {
        provider: "chat_completions" as const,
        modelId: "sample-matrix-test",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
      };
      await request(runtime, {
        type: "model.save",
        connection: {
          ...model,
          name: "Sample matrix preview",
          presetId: "custom",
          baseUrl: "https://provider.invalid/v1",
          apiKey: "sample-matrix-test",
          reasoningEffort: "provider_default",
        },
      });

      for (const sampleId of sampleContentPackageIds) {
        const sample = sampleContentPackageForLocale(locale, sampleId);
        const inspection = inspectContentPackageCurrentTree(sample.files);
        expect({
          sampleId,
          status: inspection.status,
          issues: inspection.issues,
        }).toEqual({ sampleId, status: "usable", issues: [] });
        expect(readGameplay(sample.files)).toEqual(
          expectedSampleGameplay[sampleId],
        );

        const created = await request<{ localId: string }>(runtime, {
          type: "content.create-sample",
          locale,
          sampleId,
        });
        const preview = await request<PromptPreview>(runtime, {
          type: "prompt.preview",
          packageId: created.localId,
          playerInput: locale === "zh-CN" ? "先观察周围。" : "Look around.",
          model,
        });
        expect({ sampleId, leakage: preview.leakage.status }).toEqual({
          sampleId,
          leakage: "clean",
        });

        const world = await request<{
          outcome: string;
          world: { worldId: string; title: string };
        }>(runtime, {
          type: "world.create",
          operationId: `matrix-${locale}-${sampleId}`,
          packageId: created.localId,
          model,
        });
        expect(world.outcome).toBe("created");
        expect(world.world.title).toBe(sample.title);

        const view = await request<{
          playerViews: { views: RenderedPlayerView[]; diagnostics: unknown[] };
        }>(runtime, { type: "world.read", worldId: world.world.worldId });
        expect({
          sampleId,
          diagnostics: view.playerViews.diagnostics,
        }).toEqual({ sampleId, diagnostics: [] });
        expect(view.playerViews.views.length).toBeGreaterThanOrEqual(1);
      }
      expect(network).not.toHaveBeenCalled();
    });
  },
);

describe.each(appLocales)("ordinary sample content package (%s)", (locale) => {
  test("has independent identities and supports editing, copying, ZIP round-trip and deletion", async () => {
    const { runtime, root } = await setup();
    const sample = sampleContentPackageForLocale(locale);
    const first = await request<{ localId: string; title: string }>(runtime, {
      type: "content.create-sample",
      locale,
    });
    const second = await request<{ localId: string }>(runtime, {
      type: "content.create-sample",
      locale,
    });
    expect(first.localId).not.toBe(second.localId);
    expect(first.title).toBe(sample.title);
    const original = await request<EditableContentPackageDetail>(runtime, {
      type: "content.read",
      packageId: first.localId,
    });
    expect(original.status).toBe("usable");
    expect(original.issues).toEqual([]);
    expect(original.files).toHaveLength(13);
    expect(
      original.documents.filter(({ path }) =>
        path.startsWith("world/characters/"),
      ),
    ).toHaveLength(3);
    expect(
      JSON.parse(
        await readFile(
          join(root, "data/content/packages", first.localId, "local.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      schemaVersion: 2,
      localId: first.localId,
      title: sample.title,
    });

    const edited = original.files.map((file) =>
      file.path === "opening.md"
        ? { ...file, contents: "Your own opening.\n" }
        : file,
    );
    await request(runtime, {
      type: "content.replace",
      packageId: first.localId,
      baseTreeRevision: (
        await request<{ treeRevision: string }>(runtime, {
          type: "content.read",
          packageId: first.localId,
        })
      ).treeRevision,
      files: edited,
    });
    await request(runtime, {
      type: "content.rename",
      packageId: first.localId,
      name: "My inn",
    });
    const copied = await request<EditableContentPackageDetail>(runtime, {
      type: "content.copy",
      packageId: first.localId,
    });
    expect(copied.localId).not.toBe(first.localId);
    expect(copied.title).toBe("My inn · Copy");
    expect(copied.files).toEqual(edited);

    const exported = await request<{ base64: string; fileName: string }>(
      runtime,
      { type: "content.export", packageId: copied.localId },
    );
    expect(exported.fileName).toBe("My-inn-Copy.zip");
    const imported = await request<EditableContentPackageDetail>(runtime, {
      type: "content.import",
      archiveBase64: exported.base64,
      title: "Imported inn",
    });
    expect(imported.status).toBe("usable");
    expect(imported.files).toEqual(edited);
    expect(imported.localId).not.toBe(copied.localId);

    await request(runtime, {
      type: "preferences.save",
      locale: locale === "en" ? "zh-CN" : "en",
    });
    const cold = new V1Runtime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
    });
    await cold.initialize();
    const persisted = await request<EditableContentPackageDetail>(cold, {
      type: "content.read",
      packageId: first.localId,
    });
    expect(persisted.files).toEqual(edited);
    const untouched = await request<EditableContentPackageDetail>(cold, {
      type: "content.read",
      packageId: second.localId,
    });
    expect(untouched.files).toEqual(original.files);
    expect(sampleContentPackageForLocale(locale).files).toEqual(sample.files);
    await request(cold, { type: "content.delete", packageId: first.localId });
    await expect(
      request(cold, { type: "content.read", packageId: first.localId }),
    ).rejects.toThrow();
    expect(
      (
        await request<EditableContentPackageDetail>(cold, {
          type: "content.read",
          packageId: second.localId,
        })
      ).status,
    ).toBe("usable");
  });

  test("imports and opens without calling a model, then carries the unanswered invitation into the first turn", async () => {
    const { runtime } = await setup();
    const network = vi.spyOn(globalThis, "fetch");
    await request(runtime, { type: "preferences.save", locale });
    const sample = sampleContentPackageForLocale(locale);
    const inspection = inspectContentPackageCurrentTree(sample.files);
    expect(inspection.status).toBe("usable");
    expect(inspection.issues).toEqual([]);
    const created = await request<{ localId: string }>(runtime, {
      type: "content.create-sample",
      locale,
    });
    const archive = await request<{ base64: string }>(runtime, {
      type: "content.export",
      packageId: created.localId,
    });
    const imported = await request<EditableContentPackageDetail>(runtime, {
      type: "content.import",
      archiveBase64: archive.base64,
      title: sample.title,
    });
    expect(imported.status).toBe("usable");
    await request(runtime, {
      type: "model.save",
      connection: {
        name: "Preview only",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "https://provider.invalid/v1",
        apiKey: "sample-test",
        modelId: "sample-test",
        contextWindowTokens: 128000,
        maxOutputTokens: 16000,
        reasoningEffort: "provider_default",
      },
    });
    const model = {
      provider: "chat_completions" as const,
      modelId: "sample-test",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    };
    const preview = await request<PromptPreview>(runtime, {
      type: "prompt.preview",
      packageId: imported.localId,
      playerInput: "Look around.",
      model,
    });
    expect(preview.leakage.status).toBe("clean");
    expect(preview.initialAppend?.logical.text).toBe("Look around.");
    const bootstrap = preview.compilation.logicalMessages
      .map(({ markdown }) => markdown)
      .join("\n");
    const opening = sample.files.find(
      ({ path }) => path === "opening.md",
    )!.contents;
    const invitation =
      locale === "zh-CN"
        ? "先擦擦雨吧。我们正找一封信——你愿意帮忙看看吗？"
        : "Welcome in. We're having a small mystery with a letter. Would you mind lending us a fresh pair of eyes?";
    const offer =
      locale === "zh-CN" ? "她递来一条干毛巾。" : "She holds out a dry towel.";
    expect(opening).toContain(invitation);
    expect(opening.trimEnd().endsWith(offer)).toBe(true);
    expect(bootstrap.split(opening)).toHaveLength(2);
    expect(bootstrap).toContain("@current-situation");
    expect(bootstrap).toContain("@letter-entrusted");
    expect(bootstrap).toContain(
      locale === "zh-CN" ? "自己记得的动作" : "Remembered action",
    );
    expect(bootstrap).not.toContain("character.shen-he");
    expect(bootstrap).not.toContain("character.nora");

    const world = await request<{
      outcome: string;
      world: { worldId: string; title: string };
    }>(runtime, {
      type: "world.create",
      operationId: `sample-${locale}`,
      packageId: imported.localId,
      model,
    });
    expect(world.outcome).toBe("created");
    expect(world.world.title).toBe(sample.title);
    const worldId = world.world.worldId;
    const view = await request<{
      playerViews: { views: RenderedPlayerView[]; diagnostics: unknown[] };
    }>(runtime, { type: "world.read", worldId });
    expect(view.playerViews.diagnostics).toEqual([]);
    expect(view.playerViews.views[0]?.items.map(({ value }) => value)).toEqual(
      locale === "zh-CN"
        ? ["秋日，雨夜，晚上九点", "溪桥镇，雨灯旅店大厅"]
        : [
            "An autumn evening, nine o'clock, steady rain",
            "Rain Lantern Inn lobby, Brookbridge",
          ],
    );
    const history = await request<ContentTreeFile[]>(runtime, {
      type: "world.surface.read",
      worldId,
      surface: "history",
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.contents).toBe(opening);
    await request(runtime, {
      type: "content.delete",
      packageId: imported.localId,
    });
    expect(
      (
        await request<ContentTreeFile[]>(runtime, {
          type: "world.surface.read",
          worldId,
          surface: "history",
        })
      )[0]?.contents,
    ).toBe(opening);
    expect(network).not.toHaveBeenCalled();

    const firstReply =
      locale === "zh-CN"
        ? "她把浅蓝信封的样子说给你听。"
        : "She describes the pale blue envelope.";
    network
      .mockRejectedValue(new Error("Unexpected Provider request"))
      .mockResolvedValueOnce(
        toolResponse("check-invitation", "context_read", {
          ref: "@current-situation",
        }),
      )
      .mockResolvedValueOnce(narrativeResponse(firstReply));
    const first = await request<V1PlayCallChainView>(runtime, {
      type: "play.chain.start",
      worldId,
      chainId: "sample-first-turn",
      exchangeId: "first",
      playerText:
        locale === "zh-CN"
          ? "信封是什么样的？"
          : "What does the envelope look like?",
    });
    expect(first.status).toBe("ready");
    expect(first.events).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        callId: "check-invitation",
        ok: true,
      }),
    );
    expect(network).toHaveBeenCalledTimes(2);
    const requestBody = network.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string")
      throw new Error("Expected a JSON Provider request");
    const firstWire = JSON.parse(requestBody) as {
      messages: { content: string | null }[];
    };
    const dispatched = firstWire.messages
      .map(({ content }) => content)
      .join("\n");
    expect(dispatched.split(opening)).toHaveLength(2);
    expect(dispatched).toContain(invitation);
    expect(dispatched).toContain(
      locale === "zh-CN"
        ? "干毛巾尚未被接过"
        : "offered towel has not been taken",
    );
    const played = await request<ContentTreeFile[]>(runtime, {
      type: "world.surface.read",
      worldId,
      surface: "history",
    });
    expect(played.map(({ contents }) => contents)).toContain(firstReply);
  });
});

test("English background survives play, a later advancement, and a cold history read", async () => {
  const { root, runtime } = await setup();
  await request(runtime, { type: "preferences.save", locale: "en" });
  const model = {
    provider: "chat_completions" as const,
    modelId: "history-test",
    contextWindowTokens: 128_000,
    maxOutputTokens: 512,
  };
  await request(runtime, {
    type: "model.save",
    connection: {
      ...model,
      name: "History fixture",
      presetId: "custom",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "fixture-only",
    },
  });
  const { localId: packageId } = await request<{ localId: string }>(runtime, {
    type: "content.create-sample",
    locale: "en",
  });
  const {
    world: { worldId },
  } = await request<{ world: { worldId: string } }>(runtime, {
    type: "world.create",
    operationId: "english-history-world",
    packageId,
    model,
  });
  const chainId = "english-history";
  const evening = {
    Time: "An autumn evening, nine o'clock, steady rain",
    Place: "Rain Lantern Inn lobby, Brookbridge",
  };
  const morning = { Time: "The next morning", Place: "Brookbridge steps" };
  const noon = { Time: "Noon the next day", Place: "Brookbridge market" };
  const advance = (id: string, value: typeof evening) =>
    toolResponse(id, "world_patch", {
      target: "@current-situation",
      edits: [{ op: "replace", locator: { yaml: ["background"] }, value }],
    });
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected Provider request"))
    .mockResolvedValueOnce(advance("morning", morning))
    .mockResolvedValueOnce(narrativeResponse("We arrived at the steps."))
    .mockResolvedValueOnce(advance("noon", noon))
    .mockResolvedValueOnce(
      toolResponse("old-history", "history_read", { latest: 4 }),
    )
    .mockResolvedValueOnce(narrativeResponse("The market was busy."));

  const first = await request<V1PlayCallChainView>(runtime, {
    type: "play.chain.start",
    worldId,
    chainId,
    exchangeId: "first",
    playerText: "Head for the steps in the morning.",
  });
  expect(first.status).toBe("ready");
  expect(first.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "morning",
      ok: true,
    }),
  );

  const dataRoot = join(root, "data");
  const cold = new V1Runtime({ dataRoot, configRoot: join(root, "config") });
  await cold.initialize();
  const next = await request<V1PlayCallChainView>(cold, {
    type: "play.chain.append",
    worldId,
    chainId,
    exchangeId: "second",
    playerText: "Head to the market and recall how we got here.",
  });
  expect(next.status).toBe("ready");
  expect(next.events).toContainEqual(
    expect.objectContaining({ kind: "tool_result", callId: "noon", ok: true }),
  );
  expect(provider).toHaveBeenCalledTimes(5);

  const yaml = ({ Time, Place }: typeof evening) =>
    `Time: ${Time}\nPlace: ${Place}`;
  const { history } = await new FileNativeWorldStore(dataRoot).recoverEndpoint(
    worldId,
  );
  expect(history.map(({ background }) => background)).toEqual([
    { kind: "snapshot", value: yaml(evening) },
    { kind: "snapshot", value: yaml(evening) },
    { kind: "narrative", before: yaml(evening), after: yaml(morning) },
    { kind: "snapshot", value: yaml(morning) },
    { kind: "narrative", before: yaml(morning), after: yaml(noon) },
  ]);
  const readSummary = next.events.find(
    (event) => event.kind === "tool_result" && event.callId === "old-history",
  );
  if (readSummary === undefined) throw new Error("History result missing");
  const read = await request<V1PlayCallChainEvent>(cold, {
    type: "play.timeline.detail",
    worldId,
    chainId,
    eventId: readSummary.id,
  });
  expect(read).toMatchObject({ kind: "tool_result", ok: true });
  if (read.kind !== "tool_result") throw new Error("Expected a tool result");
  expect(read.markdown).toContain(yaml(evening));
  expect(read.markdown).toContain(yaml(morning));
  expect(read.markdown).toContain("Rain patters from the inn's eaves.");
  expect(read.markdown).toContain("We arrived at the steps.");
  expect(read.markdown).not.toContain(noon.Time);
  expect(read.markdown).not.toContain(noon.Place);
  const view = await request<{
    playerViews: { views: RenderedPlayerView[]; diagnostics: unknown[] };
  }>(cold, { type: "world.read", worldId });
  expect(view.playerViews.diagnostics).toEqual([]);
  expect(view.playerViews.views[0]?.items.map(({ value }) => value)).toEqual([
    noon.Time,
    noon.Place,
  ]);
});

function toolResponse(id: string, name: string, args: object): Response {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

function narrativeResponse(content: string): Response {
  return Response.json({
    choices: [
      { message: { role: "assistant", content }, finish_reason: "stop" },
    ],
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-sample-"));
  roots.push(root);
  const runtime = new V1Runtime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  return { root, runtime };
}

async function request<T = unknown>(
  runtime: V1Runtime,
  input: V1Request,
): Promise<T> {
  const envelope = parseV1Envelope({ protocol: v1Protocol, request: input });
  return (await runtime.handle(envelope.request)).result as T;
}
