import { expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { test } from "../support/isolatedRuntimeTest.ts";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import { defaultAppReadingPreferences } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";

test.use({ runtimeScope: "world-header-occlusion" });

for (const width of [1440, 375]) {
  test(`世界页顶部遮挡滚动内容并保留首段和按钮（${width}px）`, async ({
    page,
    browserName,
  }, testInfo) => {
    const tab =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    await page.setViewportSize({ width, height: 844 });
    const worldName = `Dormitory World ${width}px`;
    let responseNumber = 0;
    const provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        responseNumber++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `Dormitory scene ${responseNumber}.\n\n${Array.from({ length: 12 }, (_, index) => `Alex unfolds the jersey and talks about practice ${index + 1}.`).join("\n\n")}` } }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("The fixture Provider did not receive a port");

    try {
      await runtime(page, {
        type: "preferences.save",
        locale: "zh-CN",
        reading: defaultAppReadingPreferences,
      });
      await runtime(page, {
        type: "model.save",
        connection: {
          name: "Header occlusion fixture",
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          modelId: "header-occlusion-model",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8_192,
        },
      });
      const content = await runtime<{ localId: string }>(page, {
        type: "content.create",
      });
      await runtime(page, {
        type: "content.rename",
        packageId: content.localId,
        name: worldName,
      });
      const firstLine =
        "The dormitory door closes behind you, and Alex waits for you to speak.";
      await runtime(page, {
        type: "content.replace",
        packageId: content.localId,
        baseTreeRevision: (
          await runtime<{ treeRevision: string }>(page, {
            type: "content.read",
            packageId: content.localId,
          })
        ).treeRevision,
        files: minimalFileNativeContentScaffold().map((file) =>
          file.path === "opening.md"
            ? {
                ...file,
                contents: firstLine,
              }
            : file,
        ),
      });
      const created = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId: content.localId,
        model: {
          provider: "chat_completions",
          modelId: "header-occlusion-model",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8_192,
        },
      });
      for (let index = 0; index < 3; index++) {
        await runtime(page, {
          type: "play.chain.start",
          worldId: created.world.worldId,
          chainId: crypto.randomUUID(),
          exchangeId: crypto.randomUUID(),
          playerText: `I ask Alex about practice ${index + 1}.`,
        });
      }

      await page.goto("/");
      await page
        .getByRole("button", { name: `打开世界：${worldName}`, exact: true })
        .click();
      await expect(page.locator(".world-floating-title")).toBeVisible();
      const story = page.getByLabel("故事时间线");
      await expect(story).toContainText("Dormitory scene 3.");
      await expect(
        page.getByRole("separator", { name: "全新上下文从这里开始" }),
      ).toHaveCount(3);
      const scroller = page.getByLabel("世界游玩", { exact: true });
      const chromeBottom = await page
        .locator(".world-floating-chrome, .world-floating-title")
        .evaluateAll((elements) =>
          Math.ceil(
            Math.max(
              ...elements.map(
                (element) => element.getBoundingClientRect().bottom,
              ),
            ),
          ),
        );
      await scroller.evaluate((element) => (element.scrollTop = 0));
      const firstParagraph = story.getByText(firstLine, { exact: true });
      await expect(firstParagraph).toBeInViewport({ ratio: 1 });
      expect((await firstParagraph.boundingBox())!.y).toBeGreaterThan(
        chromeBottom,
      );
      await testInfo.attach("world-at-top", {
        body: await page.screenshot({
          path: testInfo.outputPath("world-at-top.png"),
          animations: "disabled",
        }),
        contentType: "image/png",
      });

      const clip = { x: 0, y: 0, width, height: chromeBottom };
      const endOfStory = await scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      );
      expect(endOfStory).toBeGreaterThan(600);
      for (const scrollTop of [160, 600, endOfStory]) {
        await scroller.evaluate(
          (element, top) => (element.scrollTop = top),
          scrollTop,
        );
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(
          scrollTop,
        );
        await page.mouse.move(width - 1, 843);
        const visibleStory = await page.screenshot({
          path: testInfo.outputPath(`header-scroll-${scrollTop}.png`),
          clip,
          animations: "disabled",
        });
        await story.evaluate(
          (element) => (element.style.visibility = "hidden"),
        );
        const hiddenStory = await page.screenshot({
          path: testInfo.outputPath(`header-without-story-${scrollTop}.png`),
          clip,
          animations: "disabled",
        });
        await story.evaluate((element) =>
          element.style.removeProperty("visibility"),
        );
        await testInfo.attach(`header-scroll-${scrollTop}`, {
          body: visibleStory,
          contentType: "image/png",
        });
        await testInfo.attach(`header-without-story-${scrollTop}`, {
          body: hiddenStory,
          contentType: "image/png",
        });
        // The top region must render identically regardless of the story behind it.
        expect(visibleStory.equals(hiddenStory)).toBe(true);
      }

      const buttons = page.locator(".world-floating-chrome button");
      for (const button of await buttons.all()) {
        expect(
          await button.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return hit !== null && element.contains(hit);
          }),
        ).toBe(true);
      }
      const now = page.getByRole("button", { name: "此刻", exact: true });
      const title = page.getByRole("heading", { name: worldName, exact: true });
      for (const width of [641, 672, 1440]) {
        await page.setViewportSize({ width, height: 440 });
        await expect(title).toBeInViewport();
        await expect
          .poll(async () => {
            const [heading, tool] = await Promise.all([
              title.boundingBox(),
              now.boundingBox(),
            ]);
            return Math.abs(
              heading!.y + heading!.height / 2 - tool!.y - tool!.height / 2,
            );
          })
          .toBeLessThan(1);
      }
      await page.setViewportSize({ width, height: 844 });
      await now.press("Enter");
      await expect(now).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("button", { name: "收起状态栏" }),
      ).toBeFocused();
      await expect(page.getByRole("button", { name: /^全部/u })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(now).toBeFocused();
      await page.keyboard.press(tab);
      await expect(
        page
          .getByRole("navigation", { name: "世界阅读工具" })
          .getByRole("button", { name: "世界", exact: true }),
      ).toBeFocused();

      const settings = page.getByRole("button", { name: "阅读设置" });
      const settingsPanel = page.getByRole("complementary", {
        name: "阅读设置",
      });
      await settings.press("Enter");
      await expect(
        settingsPanel.getByRole("button", { name: "关闭" }),
      ).toBeFocused();
      await page.keyboard.press(tab);
      await expect(
        settingsPanel.getByRole("slider", { name: "字号" }),
      ).toBeFocused();
      const secondParagraph = story
        .getByText("Alex unfolds the jersey and talks about practice 2.", {
          exact: true,
        })
        .last();
      const paragraphMargin = () =>
        secondParagraph.evaluate((node) =>
          parseFloat(getComputedStyle(node).marginBlockStart),
        );
      const compact = await paragraphMargin();
      await settingsPanel.getByRole("button", { name: "舒展" }).click();
      await expect.poll(paragraphMargin).toBeGreaterThan(compact);
      await page.keyboard.press("Escape");
      await expect(settings).toBeFocused();
      await expect(settingsPanel).toHaveCount(0);

      await settings.press("Enter");
      await settingsPanel
        .getByRole("checkbox", { name: "显示技术信息" })
        .check();
      const separator = story
        .getByRole("separator", { name: "全新上下文从这里开始" })
        .first();
      await expect
        .poll(() =>
          separator.evaluate((node) => {
            const line = getComputedStyle(node, "::before");
            const surface = getComputedStyle(
              node.closest("main")!,
            ).backgroundColor;
            return line.height === "1px" && line.backgroundColor !== surface;
          }),
        )
        .toBe(true);
      await page.mouse.click(4, 220);
      await expect(settings).toBeFocused();
      await expect(settingsPanel).toHaveCount(0);
      await page.getByRole("button", { name: "世界管理", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "世界管理" }),
      ).toBeVisible();
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
