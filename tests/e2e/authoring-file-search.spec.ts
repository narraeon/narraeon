import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";

test("a long file list leaves the selected document available in both authoring previews", async ({
  page,
}) => {
  async function request<T>(request: V1Request): Promise<T> {
    const response = await page.request.post("/api/runtime/v1", {
      data: { protocol: "narraeon.runtime/v1", request },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { result: T }).result;
  }

  await request({ type: "preferences.save", locale: "en" });
  const { localId: packageId } = await request<{ localId: string }>({
    type: "content.create-sample",
    locale: "en",
    sampleId: "fogbell-harbor",
  });
  const {
    world: { worldId },
  } = await request<{ world: { worldId: string } }>({
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId,
  });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const target of ["content", "world"]) {
      await page.goto(
        target === "content"
          ? `/#/content/${packageId}`
          : `/#/world/${worldId}`,
      );
      if (target === "world") {
        await page.getByRole("button", { name: "Worlds", exact: true }).click();
        await page
          .getByRole("button", { name: "Revise current world", exact: true })
          .click();
      }
      const filesOpener = page.getByRole("button", {
        name: "Files",
        exact: true,
      });
      await filesOpener.click();
      const preview = page.locator(".setting-content-preview");
      const files = preview.getByRole("navigation").getByRole("button");
      await expect(files.nth(22)).toBeAttached();
      const title = preview.locator("article header code");
      for (const file of [files.nth(1), files.last(), files.nth(1)]) {
        const path = await file.innerText();
        await file.click();
        await expect(file).toHaveAttribute("aria-pressed", "true");
        await expect(title).toHaveText(path);
        await expect(title).toBeInViewport();
        await expect(
          preview.getByRole("button", { name: "Edit this file", exact: true }),
        ).toBeInViewport();
      }
      await preview
        .getByRole("button", { name: "Edit this file" })
        .press("Enter");
      const editor = page.locator(".setting-overlay-rail-right");
      await expect(
        page.locator(".setting-overlay-rail-right.is-editing"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toHaveAttribute("aria-hidden", "true");
      await expect(filesOpener).toBeFocused();
    }
  }
});

for (const locale of appLocales) {
  test(`authoring preview and editor share file search and order (${locale})`, async ({
    page,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-authoring-search-"));
    const servers = new RuntimeServerPool();
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    const name = t("林岚", "Evelyn");
    const ref = t("lin-lan", "evelyn");
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });

    try {
      const port = await availableRuntimePort();
      await servers.start(root, port);
      await page.goto(`http://127.0.0.1:${port}`);
      const response = await page.request.post(
        new URL("/api/runtime/v1", page.url()).toString(),
        {
          data: {
            protocol: "narraeon.runtime/v1",
            request: { type: "preferences.save", locale },
          },
        },
      );
      expect(response.ok()).toBe(true);
      await page.reload();
      await button(t("挑一个故事开玩", "Choose a story to play")).click();
      await button(
        t("雨灯旅店的一封信", "A Letter at the Rain Lantern Inn"),
      ).click();
      await button(t("编辑这份内容包", "Refine this content package")).click();

      async function checkFiles(scope: "content" | "revision"): Promise<void> {
        const revision = scope === "revision";
        const nav = page.getByRole("navigation", {
          name: revision
            ? t("世界修订工具", "World-revision tools")
            : t("设定完善工具", "Setting-improvement tools"),
        });
        const tabs = page.getByRole("navigation", {
          name: revision
            ? t("世界修订文件视图", "World-revision file view")
            : t("内容包文件视图", "Content-package file view"),
        });
        const tree = page.getByRole("navigation", {
          name: revision
            ? t("世界修订文件树", "World-revision file tree")
            : t("内容包文件树", "Content-package file tree"),
        });
        const path = `${revision ? "state" : "world"}/characters/${ref}.yaml`;
        const search = page.getByRole("searchbox", {
          name: t("筛选文件", "Filter files"),
        });
        const editTab = tabs.getByRole("button", {
          name: t("编辑", "Edit"),
          exact: true,
        });
        const previewTab = tabs.getByRole("button", {
          name: t("预览", "Preview"),
          exact: true,
        });
        const fileEditor = tree.getByRole("button", {
          name: t(`打开 ${path}`, `Open ${path}`),
          exact: true,
        });
        const filePreview = tree.getByRole("button", {
          name: path,
          exact: true,
        });
        const getPaths = () =>
          tree.getByRole("button").locator("code").allTextContents();

        await nav
          .getByRole("button", { name: t("文件", "Files"), exact: true })
          .click();
        await expect(filePreview).toBeVisible();
        const previewOrder = await getPaths();
        await search.fill(`  ${name.toUpperCase()}  `);
        await expect(filePreview).toBeVisible();
        await filePreview.click();
        await editTab.click();
        await expect(fileEditor).toHaveAttribute("aria-pressed", "true");
        await expect(search).toHaveValue(`  ${name.toUpperCase()}  `);
        await search.fill("");
        expect(await getPaths()).toEqual(previewOrder);
        expect(previewOrder[0]).toBe(
          revision ? "state/current-situation.yaml" : "opening.md",
        );
        await search.fill(`@${ref.toUpperCase()}`);
        await expect(fileEditor).toBeVisible();
        await search.fill("characters/");
        await expect(fileEditor).toBeVisible();
        await search.fill("");
        await previewTab.click();
        await expect(filePreview).toHaveAttribute("aria-pressed", "true");

        await page.setViewportSize({ width: 390, height: 844 });
        await editTab.click();
        const picker = page.getByRole("combobox", {
          name: t("选择编辑文件", "Choose a file to edit"),
        });
        await expect(picker).toHaveValue(path);
        await expect(picker.locator("option")).toHaveText(previewOrder);
        const otherRef = t("shen-he", "nora");
        const otherPath = `${revision ? "state" : "world"}/characters/${otherRef}.yaml`;
        await search.fill(`@${otherRef}`);
        await expect(picker).toHaveValue(path);
        await expect(picker.locator("option")).toHaveText(
          previewOrder.filter((entry) => entry === path || entry === otherPath),
        );
        await picker.selectOption(otherPath);
        await previewTab.click();
        await expect(
          tree.getByRole("button", { name: otherPath, exact: true }),
        ).toHaveAttribute("aria-pressed", "true");

        await page.setViewportSize({ width: 1280, height: 720 });
        await editTab.click();
        await search.fill("");
        const editor = page.getByRole("complementary", {
          name: revision
            ? t("世界修订文件编辑", "Edit world-revision files")
            : t("内容包文件编辑", "Content-package file editing"),
        });
        const createFile = editor.getByText(t("新建文件", "Create file"), {
          exact: true,
        });
        const newPath = editor.getByLabel(t("新文件路径", "New file path"));
        await createFile.click();
        await expect(newPath).toBeVisible();
        await createFile.press("Enter");
        await expect(newPath).toBeHidden();
        await createFile.press("Enter");
        await expect(newPath).toBeVisible();
        const draftPath = `${revision ? "state" : "world"}/draft.md`;
        await newPath.fill(draftPath);
        await editor
          .getByRole("button", { name: t("加入草稿", "Add to draft") })
          .click();
        const source = editor.getByLabel(
          t(`编辑 ${draftPath}`, `Edit ${draftPath}`),
        );
        const title = t("码头笔记", "Harbor notes");
        const markdown = `---\n$document:\n  id: doc.search-test\n  ref: harbor-notes\n  title: ${title}\n  summary: Draft notes\n  aliases: []\n---\n\n# ${title}\n`;
        await source.fill(markdown);
        const draftPreview = tree.getByRole("button", {
          name: draftPath,
          exact: true,
        });
        await search.fill("@harbor-notes");
        await expect(
          tree.getByRole("button", {
            name: t(`打开 ${draftPath}`, `Open ${draftPath}`),
            exact: true,
          }),
        ).toHaveAttribute("aria-pressed", "true");
        await previewTab.click();
        await search.fill(title);
        await expect(draftPreview).toHaveAttribute("aria-pressed", "true");

        await editTab.click();
        const broken = "---\n$document: [\n---\n\n# Broken\n";
        await source.fill(broken);
        await expect(tree.getByRole("button")).toHaveCount(0);
        await search.fill("draft.md");
        await previewTab.click();
        await expect(draftPreview).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".setting-content-preview pre")).toHaveText(
          broken.trim(),
        );

        await editTab.click();
        await expect(source).toHaveValue(broken);
        await editor
          .getByRole("button", {
            name: t("放弃未保存修改", "Discard unsaved changes"),
            exact: true,
          })
          .click();
        await expect(source).toHaveCount(0);
        await button(t("收起文件面板", "Close file panel")).click();
      }

      await checkFiles("content");
      await page
        .getByRole("navigation", {
          name: t("设定完善工具", "Setting-improvement tools"),
        })
        .getByRole("button", {
          name: t("创建世界", "Create world"),
          exact: true,
        })
        .click();
      await button(t("世界", "Worlds")).click();
      await button(t("修订当前世界", "Revise current world")).click();
      await checkFiles("revision");
    } finally {
      await servers.stopAll();
      await rm(root, { force: true, recursive: true });
    }
  });
}
