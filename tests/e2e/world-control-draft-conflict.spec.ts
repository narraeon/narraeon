import { expect, type Page } from "@playwright/test";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "world-control-draft-conflict" });

for (const locale of appLocales) {
  test(`advanced control binds a tab to the saved and previewed files (${locale})`, async ({
    page: tabA,
  }) => {
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    await runtime(tabA, { type: "preferences.save", locale });
    await runtime(tabA, {
      type: "model.save",
      connection: {
        name: "Control preview fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "control-preview-fixture",
        modelId: "control-preview-fixture",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const { localId } = await runtime<{ localId: string }>(tabA, {
      type: "content.create",
    });
    const {
      world: { worldId },
    } = await runtime<{ world: { worldId: string } }>(tabA, {
      type: "world.create",
      operationId: crypto.randomUUID(),
      packageId: localId,
    });
    const address = `/#/world/${worldId}`;
    const tabB = await tabA.context().newPage();
    const base = await runtime<ContentTreeFile[]>(tabA, {
      type: "world.surface.read",
      worldId,
      surface: "control",
    });

    const open = async (page: Page) => {
      await page.goto(address);
      const manage = t("世界管理", "World management");
      const dialog = page.getByRole("dialog", { name: manage });
      await page.getByRole("button", { name: manage, exact: true }).click();
      await dialog
        .getByText(
          t("世界控制 · 高级编辑", "World control · Advanced editor"),
          { exact: true },
        )
        .click();
      const editor = dialog.getByRole("textbox", {
        name: t("世界控制文件（JSON）", "World-control files (JSON)"),
      });
      await expect(editor).toHaveValue(/frame\.yaml/u);
      return {
        editor,
        preview: dialog.getByRole("button", {
          name: t("预览世界控制", "Preview world control"),
          exact: true,
        }),
        apply: dialog.getByRole("button", {
          name: t("整批应用世界控制", "Apply all world-control changes"),
          exact: true,
        }),
        conflict: dialog.getByText(
          t(
            "这份控制草稿已被其他操作替换或移除。你的修改仍在，请重新预览。",
            "The control draft was replaced or removed. Your edits are still here. Preview them again.",
          ),
          { exact: true },
        ),
      };
    };
    const a = await open(tabA);
    const b = await open(tabB);
    const sourceA = JSON.stringify(changedFiles(base, "TAB_A"), null, 2);
    const sourceB = JSON.stringify(changedFiles(base, "TAB_B"), null, 2);
    await a.editor.fill(sourceA);
    await b.editor.fill(sourceB);

    const releasePreview = Promise.withResolvers<void>();
    const previewSent = Promise.withResolvers<void>();
    await tabA.route("**/api/runtime/v1", async (route) => {
      const { request } = route.request().postDataJSON() as {
        request: V1Request;
      };
      if (request.type === "world.control-draft.preview") {
        previewSent.resolve();
        await releasePreview.promise;
      }
      await route.continue();
    });
    try {
      await a.preview.click();
      await previewSent.promise;
      await b.preview.click();
      await expect(b.apply).toBeEnabled();
    } finally {
      releasePreview.resolve();
    }
    await expect(a.conflict).toBeVisible({ timeout: 3000 });
    await expect(a.apply).toBeDisabled();
    await expect(a.editor).toHaveValue(sourceA);

    await a.preview.click();
    await expect(a.apply).toBeEnabled();

    // Replace the draft with unpreviewed bytes after both tabs have a preview.
    await runtime(tabB, {
      type: "world.control-draft.save",
      worldId,
      files: changedFiles(base, "TAB_UNPREVIEWED"),
    });
    await b.apply.click();
    await expect(b.conflict).toBeVisible();
    await expect(b.apply).toBeDisabled();
    await expect(b.editor).toHaveValue(sourceB);
    await a.apply.click();
    await expect(a.conflict).toBeVisible();
    await expect(a.apply).toBeDisabled();
    await expect(a.editor).toHaveValue(sourceA);

    const readHead = async () =>
      (await runtime<{ head: string }>(tabA, { type: "world.read", worldId }))
        .head;
    const readControl = () =>
      runtime<ContentTreeFile[]>(tabA, {
        type: "world.surface.read",
        worldId,
        surface: "control",
      });
    expect(await readHead()).toBe("genesis");
    expect(await readControl()).toEqual(base);

    // Both tabs may confirm the exact same contents. The first apply removes the draft.
    await a.preview.click();
    await expect(a.apply).toBeEnabled();
    await b.editor.fill(sourceA);
    await b.preview.click();
    await expect(b.apply).toBeEnabled();
    await a.apply.click();
    await expect.poll(readHead).toBe("commit:1");
    expect(await readControl()).toEqual(changedFiles(base, "TAB_A"));
    await b.apply.click();
    await expect(b.conflict).toBeVisible();
    await expect(b.apply).toBeDisabled();
    await expect(b.editor).toHaveValue(sourceA);
    expect(await readHead()).toBe("commit:1");
    expect(await readControl()).toEqual(changedFiles(base, "TAB_A"));

    const legacySave = await runtime<{ fingerprint: string }>(tabB, {
      type: "world.control-draft.save",
      worldId,
      files: base,
    });
    const legacyPreview = await runtime<{
      diagnosticBinding: { controlFingerprint: string };
    }>(tabB, { type: "world.control-draft.preview", worldId });
    expect(legacyPreview.diagnosticBinding.controlFingerprint).toBe(
      legacySave.fingerprint,
    );
    await runtime(tabB, { type: "world.control-draft.apply", worldId });
    expect(await readHead()).toBe("commit:2");
    expect(await readControl()).toEqual(base);
  });
}

function changedFiles(base: ContentTreeFile[], tag: string): ContentTreeFile[] {
  return base.map((file) =>
    file.path === "blocks/world.md"
      ? { ...file, contents: `${file.contents}\n${tag}\n` }
      : file,
  );
}

async function runtime<Result = unknown>(
  page: Page,
  request: V1Request,
): Promise<Result> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: Result; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
