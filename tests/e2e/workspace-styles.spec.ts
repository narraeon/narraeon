import { expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";

import { defaultAppReadingPreferences } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "workspace-styles" });

test.setTimeout(90_000);

let provider: Server;
let providerUrl: string;

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"Alex opens the window."}}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("The layout fixture Provider did not receive a port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

const widths = [
  375, 639, 640, 641, 959, 960, 961, 1050, 1172, 1173, 1200, 1201, 1440,
];
const editorWidths = [375, 640, 641, 768, 960, 1200, 1440];

for (const locale of ["zh-CN", "en"] as const) {
  test.describe(locale, () => {
    const t = (zh: string, en: string) => (locale === "en" ? en : zh);
    const moveToComposer = async (page: Page) => {
      const more = page.getByLabel(t("更多", "More"), { exact: true });
      await more.focus();
      await page.keyboard.press("Tab");
      const action = page.getByRole("textbox", {
        name: t("你的行动", "Your action"),
        exact: true,
      });
      await expect(action).toBeFocused();
      return { action, more };
    };

    test("workspace layout and pointer targets across the breakpoints", async ({
      page,
      browserName,
    }, testInfo) => {
      const tab =
        browserName === "webkit" && process.platform === "darwin"
          ? "Alt+Tab"
          : "Tab";
      const { packageId } = await openWorld(page, locale);
      const action = page.getByRole("textbox", {
        name: t("你的行动", "Your action"),
      });
      await action.fill(t("我问窗外有什么。", "I ask what is outside."));
      await page
        .getByRole("button", {
          name: t("从全新上下文发送行动", "Send action from a fresh context"),
        })
        .click();
      const story = page.getByLabel(t("故事时间线", "Story timeline"));
      await expect(story.getByText("Alex opens the window.")).toBeVisible();
      await expect(action).toBeEnabled();
      const more = page.getByLabel(t("更多", "More"), { exact: true });
      const manage = page.getByRole("button", {
        name: t("世界管理", "World management"),
        exact: true,
      });
      const openRail = page.getByRole("button", {
        name: t("世界", "Worlds"),
        exact: true,
      });
      const dismissRail = page.locator(".world-panel-scrim");
      const reader = page.getByLabel(t("世界游玩", "World play"));
      await expect(
        story.getByRole("region", {
          name: t("产物调试器", "Artifact debugger"),
          exact: true,
        }),
      ).toBeVisible();

      for (const width of widths) {
        await page.setViewportSize({ width, height: 880 });
        await reader.evaluate((element) => element.scrollTo(0, 0));
        await expect(action).toBeInViewport();
        await expect(more).toBeInViewport();
        await expect(manage).toBeInViewport();
        await expectInsideViewport(page, ".world-composer-dock");
        await expectHit(action);
        await expectHit(more);
        await expectHit(manage);
        await page.screenshot({
          path: testInfo.outputPath(`world-${width}.png`),
          animations: "disabled",
        });

        await openRail.click();
        const rail = page.locator(".world-overlay-rail-right");
        await expect(rail).toHaveClass(/is-open/u);
        const closeRail = rail.getByRole("button", {
          name: t("收起世界栏", "Close world panel"),
          exact: true,
        });
        await expectHit(closeRail);
        const send = page.locator(".world-composer-send");
        await expect(send).toHaveAccessibleName(
          t("继续故事", "Continue story"),
        );
        await expectHit(send);
        await action.fill(t("我打开窗户。", "I open the window."));
        await expect(send).toHaveAccessibleName(t("追加行动", "Append action"));
        await expectHit(send);
        await page.keyboard.press(tab);
        await expect(send).toBeFocused();
        await action.fill("");
        await page.screenshot({
          path: testInfo.outputPath(`rail-${width}.png`),
          animations: "disabled",
        });
        if (await dismissRail.isVisible()) {
          await expectHit(dismissRail, { x: 2, y: 350 });
          await dismissRail.click({ position: { x: 2, y: 350 } });
        } else {
          await closeRail.click();
        }
        await expect(rail).not.toHaveClass(/is-open/u);

        await manage.focus();
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", {
          name: t("世界管理", "World management"),
        });
        await expect(dialog).toBeInViewport();
        const close = dialog.getByRole("button", {
          name: t("关闭", "Close"),
          exact: true,
        });
        await expect(close).toBeFocused();
        await expectHit(close);
        await page.screenshot({
          path: testInfo.outputPath(`management-${width}.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
        await expect(manage).toBeFocused();
      }

      const debug = story.getByRole("region", {
        name: t("产物调试器", "Artifact debugger"),
        exact: true,
      });
      await debug.scrollIntoViewIfNeeded();
      await expect(debug).toBeInViewport();
      const debugHeading = debug.getByRole("heading", { level: 2 });
      await expectHit(debugHeading);
      await expect
        .poll(() =>
          debugHeading.evaluate((element) => {
            const dock = document.querySelector(".world-composer-dock")!;
            return (
              element.getBoundingClientRect().bottom <=
              dock.getBoundingClientRect().top
            );
          }),
        )
        .toBe(true);
      await page.screenshot({ path: testInfo.outputPath("debugger.png") });

      await page.goto("/");
      const home = page.locator(".home-library-grid");
      await expect(home).toBeVisible();
      for (const width of editorWidths) {
        await page.setViewportSize({ width, height: 880 });
        await expect(home).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath(`home-${width}.png`),
          animations: "disabled",
        });
      }

      await page.goto(`/#/content/${packageId}`);
      const files = page
        .getByRole("navigation", {
          name: t("设定完善工具", "Setting-improvement tools"),
        })
        .getByRole("button", { name: t("编辑", "Edit"), exact: true });
      const rail = page.getByRole("complementary", {
        name: t("内容包文件编辑", "Content-package file editing"),
      });
      const fileEditor = rail.getByRole("textbox", {
        name: t("编辑 opening.md", "Edit opening.md"),
        exact: true,
      });
      const save = rail.getByRole("button", {
        name: t("整批保存", "Save all changes"),
        exact: true,
      });
      const close = rail.getByRole("button", {
        name: t("收起文件面板", "Close file panel"),
        exact: true,
      });
      await files.click();
      const draft = `${await fileEditor.inputValue()}\nKeep this draft while resizing.\n`;
      const sourcePoint = { x: 24, y: 24 };
      for (const width of editorWidths) {
        await test.step(`editing opens and stays usable at ${width}px`, async () => {
          await page.setViewportSize({ width, height: 880 });
          await expect(fileEditor).toBeInViewport();
          await expectHit(fileEditor, sourcePoint);
          await close.click();
          await files.click();
          await expect(fileEditor).toBeInViewport();
          await expectHit(fileEditor, sourcePoint);
          await expect(
            width <= 640
              ? rail.getByRole("combobox", {
                  name: t("选择编辑文件", "Choose a file to edit"),
                })
              : rail.getByRole("navigation", {
                  name: t("内容包文件树", "Content-package file tree"),
                }),
          ).toBeInViewport();
          await fileEditor.click({ position: sourcePoint });
          await expect(fileEditor).toBeFocused();
          if (width === editorWidths[0]) await fileEditor.fill(draft);
          await expect(fileEditor).toHaveValue(draft);
          await expect(save).toBeInViewport();
          await expectHit(save);
          await page.screenshot({
            path: testInfo.outputPath(`editor-${width}.png`),
            animations: "disabled",
          });
        });
      }
      await save.click();
      await expect(
        rail.getByText(t("当前树已保存", "Current tree saved"), {
          exact: true,
        }),
      ).toBeVisible();
    });

    test("keyboard focus is visible on both composer fields", async ({
      page,
    }, testInfo) => {
      await openWorld(page, locale);
      for (const width of [375, 640, 960, 1200, 1440]) {
        await page.setViewportSize({ width, height: 880 });
        const { action, more } = await moveToComposer(page);
        await expectOutline(action);
        await page.screenshot({
          path: testInfo.outputPath(`action-${width}.png`),
        });

        await more.focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("Tab");
        const noteAction = page.getByRole("button", {
          name: t("本轮临时要求", "One-turn request"),
          exact: true,
        });
        await expect(noteAction).toBeFocused();
        await page.keyboard.press("Enter");
        const note = page.getByRole("textbox", {
          name: t("本轮临时要求内容", "One-turn request text"),
        });
        await expect(note).toBeFocused();
        await expectOutline(note);
        await expectHit(note);
        await page.screenshot({
          path: testInfo.outputPath(`note-${width}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(action).toBeFocused();
      }
    });

    test("#450 narrator actions fit the reader at every tested measure", async ({
      page,
      browser,
    }) => {
      await openWorld(page, locale);
      const settings = page.getByRole("button", {
        name: t("阅读设置", "Reading settings"),
      });
      await settings.click();
      const technical = page.getByRole("checkbox", {
        name: t("显示技术信息", "Show technical information"),
      });
      await technical.uncheck();
      const width = page.getByRole("slider", {
        name: t("正文宽度", "Text width"),
      });
      await width.press("End");
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      await page
        .getByRole("textbox", { name: t("你的行动", "Your action") })
        .fill("Look outside.");
      await page
        .getByRole("button", {
          name: t("从全新上下文发送行动", "Send action from a fresh context"),
        })
        .click();

      const actionName = t("主持消息操作", "Narrator message actions");
      const reply = (tab: Page) =>
        tab
          .locator(".call-chain-assistant.is-completed")
          .filter({ hasText: "Alex opens the window." });
      const actions = reply(page).getByRole("button", { name: actionName });
      await expect(actions).toBeVisible();
      for (const viewportWidth of [671, 673, 721, 961, 1180, 1440]) {
        await test.step(`${viewportWidth}px at the widest measure`, async () => {
          await page.setViewportSize({ width: viewportWidth, height: 800 });
          await page.mouse.move(4, 4);
          await expect(actions).toHaveCSS(
            "opacity",
            viewportWidth >= 721 ? "0" : "1",
          );
          await reply(page).getByText("Alex opens the window.").hover();
          await expect(actions).toHaveCSS("opacity", "1");
          await expectNarratorActionEdges(actions);
          await actions.click();
          await expect(actions).toHaveAttribute("aria-expanded", "true");
          await page.keyboard.press("Escape");
          await expect(actions).toBeFocused();
          await actions.blur();
        });
      }

      await page.setViewportSize({ width: 1180, height: 800 });
      await page
        .getByRole("button", { name: t("此刻", "Now"), exact: true })
        .click();
      const worldRail = page.locator(".world-overlay-rail-right");
      await page
        .getByRole("button", { name: t("世界", "Worlds"), exact: true })
        .click();
      await expect(worldRail).toHaveClass(/is-open/u);
      await reply(page).getByText("Alex opens the window.").hover();
      await expectNarratorActionEdges(actions);
      await worldRail
        .getByRole("button", {
          name: t("收起世界栏", "Close world panel"),
        })
        .click();
      await page
        .getByRole("button", { name: t("收起状态栏", "Close status panel") })
        .click();

      await settings.click();
      await width.press("Home");
      await page.keyboard.press("Escape");
      await reply(page).getByText("Alex opens the window.").hover();
      await expectNarratorActionEdges(actions);
      await settings.click();
      await technical.check();
      await page.keyboard.press("Escape");
      await expect(actions.locator("xpath=ancestor::header")).toHaveCount(1);
      await actions.press("Enter");
      await expect(actions).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(actions).toBeFocused();

      await settings.click();
      await technical.uncheck();
      await width.press("End");
      await page.keyboard.press("Escape");
      const touch = await browser.newContext({ hasTouch: true });
      try {
        const tab = await touch.newPage();
        for (const viewportWidth of [375, 673]) {
          await tab.setViewportSize({ width: viewportWidth, height: 800 });
          await tab.goto(page.url());
          const button = reply(tab).getByRole("button", { name: actionName });
          await expect(button).toHaveCSS("opacity", "1");
          await expect(button).toHaveAttribute("aria-expanded", "false");
          await expect
            .soft(button)
            .toHaveCSS("width", "44px", { timeout: 500 });
          await expect
            .soft(button)
            .toHaveCSS("height", "44px", { timeout: 500 });
          await expectNarratorActionEdges(button);
          await button.tap();
          await expect(button).toHaveAttribute("aria-expanded", "true");
          await button.tap();
          await expect(button).toHaveAttribute("aria-expanded", "false");
        }
      } finally {
        await touch.close();
      }
    });

    test("#451 document and reading controls stay legible and reachable in a small window", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 440 });
      await openWorld(page, locale);
      await page
        .getByRole("button", { name: t("世界", "Worlds"), exact: true })
        .click();
      const rail = page.locator(".world-overlay-rail-right");
      const documents = rail.getByRole("button", {
        name: new RegExp(t("选择文档", "Choose document"), "u"),
      });
      await expect
        .soft(documents.locator("strong"))
        .toHaveCSS("font-size", "12.6px", { timeout: 500 });
      await documents.press("Enter");
      await expect(rail.getByRole("searchbox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(documents).toBeFocused();
      const source = rail.getByText(t("原始源码", "Original source"), {
        exact: true,
      });
      await source.click();
      await expect
        .soft(source.locator("..").locator("pre"))
        .toHaveCSS("font-size", "12.6px", { timeout: 500 });
      await rail
        .getByRole("button", { name: t("收起世界栏", "Close world panel") })
        .click();

      const settings = page.getByRole("button", {
        name: t("阅读设置", "Reading settings"),
      });
      await settings.press("Enter");
      const popover = page.getByRole("complementary", {
        name: t("阅读设置", "Reading settings"),
      });
      const width = popover.getByRole("slider", {
        name: t("正文宽度", "Text width"),
      });
      await expect
        .soft(width.locator(".."))
        .toHaveCSS("font-size", "12.6px", { timeout: 500 });
      const reset = popover.getByRole("button", {
        name: t("恢复默认", "Restore defaults"),
      });
      await reset.scrollIntoViewIfNeeded();
      await expectHit(reset);
      await reset.click();
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
    });
  });
}

async function openWorld(page: Page, locale: "zh-CN" | "en") {
  await runtime(page, {
    type: "preferences.save",
    locale,
    reading: { ...defaultAppReadingPreferences, showTechnicalInfo: true },
  });
  const model = {
    provider: "chat_completions",
    modelId: "workspace-styles-fixture",
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
  } as const;
  await runtime(page, {
    type: "model.save",
    connection: {
      ...model,
      name: "Workspace styles fixture",
      baseUrl: providerUrl,
      apiKey: "workspace-styles-fixture",
      presetId: "custom",
    },
  });
  const { localId: packageId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId,
    model,
  });
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (
      request.type !== "world.play-decorations.read" &&
      request.type !== "workspace.read"
    )
      return route.continue();
    const response = await route.fetch();
    const data = (await response.json()) as {
      result: {
        worlds: { worldId: string }[];
        contentPackages: { localId: string }[];
        extensions: unknown[];
      };
    };
    if (request.type === "workspace.read") {
      data.result.worlds = data.result.worlds.filter(
        ({ worldId }) => worldId === world.worldId,
      );
      data.result.contentPackages = data.result.contentPackages.filter(
        ({ localId }) => localId === packageId,
      );
    } else {
      data.result.extensions = [
        {
          operationId: "layout-debug-fixture",
          status: "completed",
          completedRequests: ["layout-debug-fixture"],
          coreCommitted: true,
        },
      ];
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/#/world/${world.worldId}`);
  await expect(page.locator(".world-story-column")).toBeVisible();
  return { packageId };
}

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function expectOutline(target: Locator) {
  await expect(target).toHaveCSS("outline-style", "solid");
  await expect(target).toHaveCSS("outline-width", "2px");
  await expect(target).toHaveCSS("outline-offset", "2px");
}

async function expectInsideViewport(page: Page, selector: string) {
  await expect
    .poll(() =>
      page.locator(selector).evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return (
          left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight
        );
      }),
    )
    .toBe(true);
}

async function expectHit(target: Locator, point?: { x: number; y: number }) {
  await expect
    .poll(() =>
      target.evaluate((element, point) => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + (point?.x ?? rect.width / 2);
        const y = rect.top + (point?.y ?? rect.height / 2);
        return element.contains(document.elementFromPoint(x, y));
      }, point),
    )
    .toBe(true);
}

async function expectNarratorActionEdges(button: Locator) {
  const bounds = await button.evaluate((node) => {
    const { left, right, top, bottom } = node.getBoundingClientRect();
    const scroller = node.closest(".world-reader-scroll")!;
    return {
      right,
      readerRight: scroller.getBoundingClientRect().right,
      scrollLeft: scroller.scrollLeft,
      leftHit: node.contains(
        document.elementFromPoint(left + 1, (top + bottom) / 2),
      ),
      rightHit: node.contains(
        document.elementFromPoint(right - 1, (top + bottom) / 2),
      ),
    };
  });
  expect.soft(bounds.scrollLeft).toBe(0);
  expect
    .soft(bounds.right, JSON.stringify(bounds))
    .toBeLessThanOrEqual(bounds.readerRight);
  expect.soft(bounds.leftHit).toBe(true);
  expect.soft(bounds.rightHit, JSON.stringify(bounds)).toBe(true);
}
