import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { RenderedPlayerView } from "../../src/protocol/playerViews.ts";
import {
  parseV1Envelope,
  v1Protocol,
  type ContentTreeFile,
  type V1Request,
} from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { EditableContentPackageDetail } from "../../src/runtime/content/ContentWorkspace.ts";
import { inspectContentPackageCurrentTree } from "../../src/runtime/content/FileNativeContentTree.ts";
import type { PromptPreview } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { sampleContentPackageForLocale } from "../../src/shared/sample-packages/index.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("sample creation requires an explicit supported locale and no other parameters", () => {
  for (const locale of appLocales)
    expect(
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type: "content.create-sample", locale },
      }).request,
    ).toEqual({ type: "content.create-sample", locale });
  for (const fields of [
    {},
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
    expect(original.files).toHaveLength(10);
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
    expect(copied.title).toBe("My inn");
    expect(copied.files).toEqual(edited);

    const exported = await request<{ base64: string; fileName: string }>(
      runtime,
      { type: "content.export", packageId: copied.localId },
    );
    expect(exported.fileName).toBe("My-inn.zip");
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

  test("passes import inspection, real prompt compilation and world creation with live status values and no model call", async () => {
    const { runtime } = await setup();
    const network = vi.spyOn(globalThis, "fetch");
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
        baseUrl: "http://127.0.0.1:1/v1",
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
    expect(bootstrap).not.toContain(opening.trim());
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
  });
});

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
