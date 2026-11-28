import { expect, type Page } from "@playwright/test";
import { stringify } from "yaml";

import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { defaultPlayPresetFiles } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { createZip } from "../support/createZip.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "document-reaudit" });

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}

async function createWorld(page: Page, packageId: string): Promise<string> {
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId,
  });
  return world.worldId;
}

async function seedFiles(page: Page): Promise<ContentTreeFile[]> {
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { files } = await runtime<{ files: ContentTreeFile[] }>(page, {
    type: "content.read",
    packageId: localId,
  });
  return files;
}

for (const locale of ["en", "zh-CN"] as const) {
  const t = (en: string, zh: string) => (locale === "en" ? en : zh);

  test(`#465 player-view diagnostic cards fit the story reader (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    await page.setViewportSize({
      width: locale === "en" ? 1280 : 320,
      height: 850,
    });
    const { localId } = await runtime<{ localId: string }>(page, {
      type: "content.create-sample",
      locale,
      sampleId: "fogbell-harbor",
    });
    const worldId = await createWorld(page, localId);
    const debug = page.getByRole("region", {
      name: t("Artifact debugger", "产物调试器"),
    });
    const reading = page.getByRole("button", {
      name: t("Reading settings", "阅读设置"),
      exact: true,
    });
    const enableDetails = async () => {
      await reading.press("Enter");
      const checkbox = page.getByRole("checkbox", {
        name: t("Show technical information", "显示技术信息"),
      });
      await expect(checkbox).toBeVisible();
      if (!(await checkbox.isChecked())) await checkbox.press("Space");
      await expect(checkbox).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(reading).toBeFocused();
    };

    const { presets } = await runtime<{ presets: { id: string }[] }>(page, {
      type: "play.read",
    });
    await runtime(page, { type: "play.select", presetId: presets[0]!.id });
    await page.goto(`/#/world/${worldId}`);
    await enableDetails();
    await expect(debug).toHaveCount(0);

    const longId = `diagnostic-${"x".repeat(100)}`;
    const panels = [longId, "diagnostic-second"].map((id, index) => ({
      id,
      source: { kind: "player_view", view: "status" },
      channel: `diagnostic-panel-${index}`,
      key: `diagnostic-key-${index}`,
      mount: "sidebar",
      config: {
        title: `Diagnostic panel ${index}`,
        layout: "stack",
        theme: "calm",
        empty: "message",
        emptyMessage: "Empty",
        groups: [],
      },
    }));
    const { preset } = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: `Diagnostic fixture ${locale}`,
      files: {
        ...defaultPlayPresetFiles,
        "orchestration.yaml": stringify({
          format: "narraeon.orchestration/v1",
          name: "diagnostic-fixture",
          playPrompts: {},
          callChain: "call-chain.yaml",
          mounts: [],
          playerViewPanels: panels,
        }),
      },
    });
    await runtime(page, { type: "play.select", presetId: preset.id });
    await page.reload();

    const diagnostics = debug.getByRole("region", {
      name: t("Player-view panel diagnostics", "玩家视图面板诊断"),
    });
    await expect(diagnostics.getByRole("article")).toHaveCount(2);
    expect
      .soft((await diagnostics.getAttribute("class"))?.split(" "))
      .not.toContain("undefined");
    await expect(diagnostics.getByText(longId, { exact: true })).toBeVisible();
    const layout = await diagnostics.evaluate((region) => {
      const [first, second] = region.querySelectorAll("article");
      const bounds = region.getBoundingClientRect();
      return {
        gap:
          second!.getBoundingClientRect().top -
          first!.getBoundingClientRect().bottom,
        border: getComputedStyle(first!).borderTopWidth,
        fits: [region, ...region.querySelectorAll("article, pre")].every(
          (node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= bounds.left &&
              rect.right <= bounds.right + 1 &&
              node.scrollWidth <= node.clientWidth + 1
            );
          },
        ),
      };
    });
    expect.soft(layout.gap, JSON.stringify(layout)).toBeGreaterThan(4);
    expect.soft(layout.border, JSON.stringify(layout)).not.toBe("0px");
    expect(layout.fits, JSON.stringify(layout)).toBe(true);
  });

  test(`#466 opening preview groups the title and gameplay (${locale})`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    const files = await seedFiles(page);
    const title = t(
      `A long preview title ${"Harbor".repeat(13)}`,
      "潮落时门外还有人在等你".repeat(8),
    );
    const story = t("A beacon wakes on the cliffs.", "峭壁上亮起一盏灯。");
    const openingFile = { path: "opening.md", contents: `**${story}**\n` };
    const rest = files.filter(({ path }) => path !== openingFile.path);
    const withOpening = await runtime<{ localId: string }>(page, {
      type: "content.import",
      title,
      archiveBase64: createZip([...rest, openingFile]).toString("base64"),
    });
    const withNoOpening = await runtime<{ localId: string }>(page, {
      type: "content.import",
      title: t("Empty opening", "空开场白"),
      archiveBase64: createZip(rest).toString("base64"),
    });

    await page.goto("/#/create");
    const picker = page.getByRole("combobox", {
      name: t("Content package for the new world", "创建世界的内容包"),
    });
    const preview = page.getByRole("article", {
      name: t("Opening preview", "开场白预览"),
    });
    const heading = preview.getByRole("heading", { level: 2 });
    const gameplay = preview.getByText(t("Interactive fiction", "互动式小说"), {
      exact: true,
    });
    await expect(gameplay).toHaveCount(0);
    const body = preview.locator(".create-world-opening");
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const { localId } of [withOpening, withNoOpening]) {
        await picker.focus();
        await picker.selectOption(localId);
        await expect(picker).toBeFocused();
        await expect(heading).toHaveText(
          localId === withOpening.localId
            ? title
            : t("Empty opening", "空开场白"),
        );
        await expect(gameplay).toBeVisible();
        await expect(body).toHaveText(
          localId === withOpening.localId
            ? story
            : t(
                "This content package has no opening yet.",
                "这份内容包还没有开场白。",
              ),
        );
        const layout = await preview.evaluate((article) => {
          const title = article.querySelector("h2")!;
          const subtitle = article.querySelector(".create-world-gameplay")!;
          const body = article.querySelector(".create-world-opening")!;
          const titleBox = title.getBoundingClientRect();
          const subtitleBox = subtitle.getBoundingClientRect();
          const bodyBox = body.getBoundingClientRect();
          return {
            titleGap: subtitleBox.top - titleBox.bottom,
            bodyGap: bodyBox.top - subtitleBox.bottom,
            titleFits: title.scrollWidth <= title.clientWidth + 1,
          };
        });
        expect
          .soft(layout.titleGap, JSON.stringify({ width, ...layout }))
          .toBeGreaterThanOrEqual(0);
        expect
          .soft(layout.bodyGap, JSON.stringify({ width, ...layout }))
          .toBeGreaterThan(layout.titleGap);
        expect
          .soft(layout.titleFits, JSON.stringify({ width, ...layout }))
          .toBe(true);
      }
    }
    await picker.selectOption(withOpening.localId);
    await page
      .getByRole("button", {
        name: t("Create from current content package", "从当前内容包创建"),
      })
      .click();
    await expect(page).toHaveURL(/#\/world\//u);
    await expect(page.getByText(story, { exact: true })).toBeVisible();
  });

  for (const newline of ["LF", "CRLF"] as const) {
    test(`#467 imported world document titles, references and drafts (${locale} / ${newline})`, async ({
      page,
    }) => {
      await runtime(page, { type: "preferences.save", locale });
      const files = await seedFiles(page);
      const title = t("Harbor YAML", "港口 YAML");
      const mdTitle = t("Lantern Markdown", "灯塔 Markdown");
      const yamlHeader = `# comment with no content below it yet\n\n$document:\n  id: location.harbor\n  ref: harbor-test\n  title: ${title}\n  summary: A harbor.\n  aliases: []\n`;
      const mkFile = (name: string, contents: string) => ({
        path: `world/${name}`,
        contents:
          newline === "LF" ? contents : contents.replaceAll("\n", "\r\n"),
      });
      const documents = [
        mkFile("locations/harbor.yml", `${yamlHeader}weather: calm\n`),
        mkFile(
          "rules/lantern.md",
          `---\n$document:\n  id: rules.lantern\n  ref: lantern-test\n  title: ${mdTitle}\n  summary: A light.\n  aliases: []\n---\n\n# ${mdTitle} ##\n\n## Hours\n\n**Body of the lantern document.**\n`,
        ),
      ];
      const importFiles = (title: string, extras: ContentTreeFile[]) =>
        runtime<{ localId: string; status: string }>(page, {
          type: "content.import",
          title,
          archiveBase64: createZip([...files, ...extras]).toString("base64"),
        });
      const importedTitle = `Documents ${locale} ${newline}`;
      const draftTitle = `Draft ${locale} ${newline}`;
      const imported = await importFiles(importedTitle, documents);
      const { files: stored } = await runtime<{ files: ContentTreeFile[] }>(
        page,
        {
          type: "content.read",
          packageId: imported.localId,
        },
      );
      for (const file of documents)
        expect(stored.find(({ path }) => path === file.path)?.contents).toBe(
          file.contents,
        );

      const broken = mkFile(
        "other/harbor-draft.yaml",
        yamlHeader + "unfinished: [\n",
      );
      const draft = await importFiles(draftTitle, [broken]);
      expect(draft.status).toBe("needs_repair");
      for (const { packageId, packageTitle, cases } of [
        {
          packageId: imported.localId,
          packageTitle: importedTitle,
          cases: [
            [documents[0]!, title, "harbor-test"],
            [documents[1]!, mdTitle, "lantern-test"],
          ] as const,
        },
        {
          packageId: draft.localId,
          packageTitle: draftTitle,
          cases: [[broken, title, "harbor-test"]] as const,
        },
      ]) {
        await page.goto(`/#/content/${packageId}`);
        await expect(
          page.getByRole("heading", {
            name: `${packageTitle} · ${t("Setting improvement", "AI 设定完善")}`,
          }),
        ).toBeVisible();
        const filesButton = page
          .getByRole("navigation", {
            name: t("Setting-improvement tools", "设定完善工具"),
          })
          .getByRole("button", { name: t("Files", "文件"), exact: true });
        await filesButton.press("Enter");
        const preview = page.locator(".setting-content-preview");
        const search = preview.getByRole("searchbox", {
          name: t("Filter files", "筛选文件"),
        });
        for (const [file, title, ref] of cases) {
          await search.fill(`@${ref}`);
          const item = preview.getByRole("button", {
            name: file.path,
            exact: true,
          });
          await expect.soft(item).toBeVisible({ timeout: 1_500 });
          await search.fill(file.path);
          await item.click();
          await expect.soft(item).toHaveAccessibleDescription(title);
          await expect
            .soft(preview.locator("article header strong"))
            .toHaveText(title, { timeout: 1_500 });
          expect(await preview.locator("article pre").textContent()).toBe(
            file.contents,
          );
        }
        expect(
          await page.evaluate(() =>
            (
              window as Window & { narraeonAndroidBack?: () => boolean }
            ).narraeonAndroidBack?.(),
          ),
        ).toBe(true);
        await expect(filesButton).toBeFocused();
      }
      // The content validator requires LF. A repair package still exposes its original file tree.
      if (newline === "CRLF") {
        expect(imported.status).toBe("needs_repair");
        return;
      }
      expect(imported.status).toBe("usable");
      const worldId = await createWorld(page, imported.localId);
      await page.goto(`/#/world/${worldId}`);
      await page
        .getByRole("button", { name: t("Worlds", "世界"), exact: true })
        .click();
      const switcher = page.locator(".world-document-switcher-trigger");
      const search = page.getByRole("searchbox", {
        name: t("Search current documents", "查找当前文档"),
      });
      const card = page.locator(".world-document-card");
      for (const [file, documentTitle, ref] of [
        [documents[0]!, title, "harbor-test"],
        [documents[1]!, mdTitle, "lantern-test"],
      ] as const) {
        await switcher.press("Enter");
        await expect(search).toBeFocused();
        await search.fill(`@${ref}`);
        await page
          .getByRole("option", {
            name: `${documentTitle} ${file.path.slice("world/".length)}`,
          })
          .click();
        await expect(switcher).toBeFocused();
        await expect(switcher).toContainText(documentTitle);
        await card
          .getByText(t("Document identity", "文档身份"), { exact: true })
          .click();
        await expect(card.getByText(`@${ref}`, { exact: true })).toBeVisible();
        await card
          .getByText(t("Original source", "原始源码"), { exact: true })
          .click();
        expect(await card.locator("details pre").textContent()).toBe(
          file.contents,
        );
      }
      await expect(
        card.getByText("Body of the lantern document.", { exact: true }),
      ).toBeVisible();
    });
  }
}
