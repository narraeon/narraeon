import { expect, test, type Page } from "@playwright/test";

import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";

for (const locale of ["en", "zh-CN"] as const) {
  test.describe(locale, () => {
    const touch = locale === "zh-CN";
    const label = (en: string, zh: string) => (touch ? zh : en);
    test.use({
      actionTimeout: 5_000,
      hasTouch: touch,
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
    });
    test.beforeEach(async ({ page }) => {
      await openWorld(page, locale);
    });

    test("outside reading-settings dismissal preserves the intended control (#446)", async ({
      page,
      browserName,
    }) => {
      const settingsName = label("Reading settings", "阅读设置");
      const settings = page.getByRole("button", { name: settingsName });
      const panel = page.getByRole("complementary", { name: settingsName });
      const close = panel.getByRole("button", {
        name: label("Close", "关闭"),
        exact: true,
      });
      const action = page.getByRole("textbox", {
        name: label("Your action", "你的行动"),
      });
      await settings.press("Enter");
      await expect(close).toBeFocused();
      await (touch ? action.tap() : action.click());
      await expect(panel).toHaveCount(0);
      await expect(action).toBeFocused();
      await page.keyboard.insertText("Focus stays here");
      await expect(action).toHaveValue("Focus stays here");

      const more = page.getByLabel(label("More", "更多"), {
        exact: true,
      });
      await settings.press("Enter");
      await (touch ? more.tap() : more.click());
      await expect(panel).toHaveCount(0);
      await expect(more.locator("..")).toHaveJSProperty("open", true);
      await expect(settings).not.toBeFocused();
      if (browserName !== "webkit") await expect(more).toBeFocused();
      await page.keyboard.press("Escape");

      for (const dismiss of [
        () => page.keyboard.press("Escape"),
        () => (touch ? close.tap() : close.click()),
        async () => expect(await androidBack(page)).toBe(true),
      ]) {
        await settings.press("Enter");
        await expect(close).toBeFocused();
        await dismiss();
        await expect(panel).toHaveCount(0);
        await expect(settings).toBeFocused();
      }
    });

    test("right rail closes and restores the active toolbar control (#447)", async ({
      page,
    }) => {
      const toolbar = page.getByRole("navigation", {
        name: label("World reading tools", "世界阅读工具"),
      });
      const worlds = toolbar.getByRole("button", {
        name: label("Worlds", "世界"),
        exact: true,
      });
      const modelReads = toolbar.getByRole("button", {
        name: label("Model reads", "AI 读取"),
        exact: true,
      });
      const rail = page.locator(".world-overlay-rail-right");
      const close = rail.getByRole("button", {
        name: label("Close world panel", "收起世界栏"),
      });
      await worlds.press("Enter");
      await expect(rail).toHaveAttribute("aria-hidden", "false");
      await close.focus();
      await page.keyboard.press("Escape");
      await expect(rail).toHaveAttribute("aria-hidden", "true");
      await expect(worlds).toBeFocused();

      await worlds.press("Enter");
      await expect(close).toBeFocused();
      await expect(worlds).toHaveAttribute("aria-expanded", "true");
      await expect(modelReads).toHaveAttribute("aria-expanded", "false");
      await expect(worlds).toHaveAttribute(
        "aria-controls",
        (await rail.getAttribute("id")) ?? "missing",
      );
      await (touch ? modelReads.tap() : modelReads.click());
      await expect(worlds).toHaveAttribute("aria-expanded", "false");
      await expect(modelReads).toHaveAttribute("aria-expanded", "true");
      await expect(close).toBeFocused();
      await (touch ? close.tap() : close.click());
      await expect(rail).toHaveAttribute("aria-hidden", "true");
      await expect(modelReads).toBeFocused();

      await modelReads.press("Enter");
      if (!touch) {
        const action = page.getByRole("textbox", { name: "Your action" });
        await expect(rail).toHaveCSS("opacity", "1");
        const actionBox = await action.boundingBox();
        const railBox = await rail.boundingBox();
        expect(actionBox).not.toBeNull();
        expect(railBox).not.toBeNull();
        expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(railBox!.x);
        await action.click();
        await page.keyboard.insertText("Read and write side by side");
        await expect(action).toHaveValue("Read and write side by side");
        await expect(modelReads).toHaveAttribute("aria-expanded", "true");
      }
      await (touch ? modelReads.tap() : modelReads.click());
      await expect(rail).toHaveAttribute("aria-hidden", "true");
      await expect(modelReads).toBeFocused();
      await expect(modelReads).toHaveAttribute("aria-expanded", "false");

      const now = page.getByRole("button", {
        name: label("Now", "此刻"),
        exact: true,
      });
      await now.press("Enter");
      await modelReads.press("Enter");
      const openReadingDialog = rail.getByRole("button", {
        name: label("Open the complete read record", "展开完整读取记录"),
      });
      await openReadingDialog.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: label("How the model reads", "AI 如何读取"),
      });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(openReadingDialog).toBeFocused();
      await expect(modelReads).toHaveAttribute("aria-expanded", "true");
      expect(await androidBack(page)).toBe(true);
      await expect(modelReads).toHaveAttribute("aria-expanded", "false");
      await expect(modelReads).toBeFocused();
      await expect(now).toHaveAttribute("aria-pressed", "true");
      expect(await androidBack(page)).toBe(true);
      await expect(now).toHaveAttribute("aria-pressed", "false");
      await expect(now).toBeFocused();

      await modelReads.press("Enter");
      const railWorlds = rail.getByRole("button", {
        name: label("Worlds", "世界"),
        exact: true,
      });
      await railWorlds.press("Enter");
      await expect(railWorlds).toHaveAttribute("aria-pressed", "true");
      await expect(worlds).toHaveAttribute("aria-expanded", "true");
      await expect(modelReads).toHaveAttribute("aria-expanded", "false");
      await page.keyboard.press("Escape");
      await expect(worlds).toBeFocused();
    });

    test("the document chooser dismisses on outside activation and before its rail (#448)", async ({
      page,
    }) => {
      const toolbar = page.getByRole("navigation", {
        name: label("World reading tools", "世界阅读工具"),
      });
      const worlds = toolbar.getByRole("button", {
        name: label("Worlds", "世界"),
        exact: true,
      });
      await worlds.press("Enter");
      const rail = page.getByRole("complementary", {
        name: label("Current world", "当前世界"),
      });
      const chooser = rail.getByRole("button", {
        name: new RegExp(`^${label("Choose document", "选择文档")}`, "u"),
      });
      const search = rail.getByRole("searchbox");
      const body = rail.getByText("The doors close at dusk.", { exact: true });
      await expect(chooser).toBeVisible();
      await chooser.press("Enter");
      await expect(search).toBeFocused();
      await rail.getByRole("option", { name: /Guild Gates/u }).click();
      await expect(chooser).toBeFocused();
      await expect(body).toBeVisible();

      await chooser.press("Enter");
      await expect(search).toBeFocused();
      await (touch ? body.tap() : body.click());
      await expect(chooser).toHaveAttribute("aria-expanded", "false");
      await expect(rail).toBeVisible();

      if (!touch) {
        const action = page.getByRole("textbox", { name: "Your action" });
        await chooser.press("Enter");
        await action.click();
        await expect(search).toHaveCount(0);
        await expect(action).toBeFocused();
        await page.keyboard.insertText("Keep typing after choosing a document");
        await expect(action).toHaveValue(
          "Keep typing after choosing a document",
        );
      }

      await chooser.press("Enter");
      await expect(search).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(chooser).toBeFocused();
      await expect(rail).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(worlds).toBeFocused();
      await expect(rail).toBeHidden();

      await worlds.press("Enter");
      await chooser.press("Enter");
      expect(await androidBack(page)).toBe(true);
      await expect(chooser).toBeFocused();
      await expect(chooser).toHaveAttribute("aria-expanded", "false");
      expect(await androidBack(page)).toBe(true);
      await expect(rail).toBeHidden();
      await expect(worlds).toBeFocused();
      await worlds.press("Enter");
      await expect(chooser).toHaveAttribute("aria-expanded", "false");
      const revise = rail.getByRole("button", {
        name: label("Revise current world", "修订当前世界"),
        exact: true,
      });
      const revisionTools = page.getByRole("navigation", {
        name: label("World-revision tools", "世界修订工具"),
      });
      await chooser.press("Enter");
      await (touch ? revise.tap() : revise.click());
      await expect(revisionTools).toBeVisible();

      await page
        .getByRole("button", { name: label("Return to play", "返回游玩") })
        .click();
      await worlds.press("Enter");
      await expect(chooser).toHaveAttribute("aria-expanded", "false");
      await rail
        .getByRole("button", { name: label("Revise", "修订"), exact: true })
        .click();
      await revisionTools
        .getByRole("button", { name: label("Edit", "编辑"), exact: true })
        .click();
      await expect(
        page.getByRole("textbox", {
          name: label("Edit", "编辑") + " state/rules/gates.md",
        }),
      ).toHaveValue(/The doors close at dusk\./u);
    });
  });
}

async function openWorld(page: Page, locale: "en" | "zh-CN"): Promise<void> {
  await runtime(page, { type: "preferences.save", locale });
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { files, treeRevision } = await runtime<{
    files: ContentTreeFile[];
    treeRevision: string;
  }>(page, { type: "content.read", packageId: localId });
  const { status } = await runtime<{ status: string }>(page, {
    type: "content.replace",
    packageId: localId,
    baseTreeRevision: treeRevision,
    files: [
      ...files,
      {
        path: "world/rules/gates.md",
        contents: [
          "---",
          "$document: {id: rules.gates, ref: gates, title: Guild Gates, summary: The guild entrance, aliases: []}",
          "---",
          "# Guild Gates",
          "",
          ...Array.from(
            { length: 8 },
            (_, index) => `Gate rule ${index + 1}.\n`,
          ),
          "The doors close at dusk.",
        ].join("\n"),
      },
    ],
  });
  expect(status).toBe("usable");
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId: localId,
  });
  await page.goto(`/#/world/${world.worldId}`);
}

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

function androidBack(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() =>
    (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack?.(),
  );
}
