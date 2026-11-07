import { expect, type Locator, type Page } from "@playwright/test";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "composer-autosize" });

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function height(input: Locator): Promise<number> {
  return input.evaluate((element) => element.getBoundingClientRect().height);
}

async function exerciseComposer(page: Page, input: Locator): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await input.fill("Short");
  const minimum = await height(input);
  await input.fill("One\nTwo\nThree\nFour\nFive");
  await expect.poll(() => height(input)).toBeGreaterThan(minimum + 20);
  await input.fill("");
  await expect.poll(() => height(input)).toBeCloseTo(minimum, 0);

  await input.fill(Array.from({ length: 40 }, () => "A long line").join("\n"));
  const capped = await height(input);
  expect(capped).toBeLessThanOrEqual(
    await input.evaluate((element) =>
      parseFloat(getComputedStyle(element).maxHeight),
    ),
  );
  expect(
    await input.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const send = input
    .locator("xpath=ancestor::footer")
    .locator(".world-composer-send, .setting-conversation-composer-row button");
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  await page.setViewportSize({ width: 420, height: 800 });
  const scroller = page.locator(".world-reader-scroll, .setting-reader-scroll");
  const story = scroller.locator(".world-story-column, .setting-story-column");
  await story.evaluate((element) => {
    const marker = document.createElement("div");
    marker.id = "composer-layout-end";
    marker.textContent = "Last visible story line";
    marker.style.marginTop = "1000px";
    element.append(marker);
  });
  const marker = page.locator("#composer-layout-end");
  await scroller.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await expect
    .poll(
      async () =>
        (await marker.boundingBox())!.y + (await marker.boundingBox())!.height,
    )
    .toBeLessThan(
      (await input.locator("xpath=ancestor::footer").boundingBox())!.y,
    );
  await marker.evaluate((element) => element.remove());

  await page.setViewportSize({ width: 1200, height: 800 });
  await input.fill("word ".repeat(42));
  const wide = await height(input);
  await page.setViewportSize({ width: 420, height: 800 });
  await expect.poll(() => height(input)).toBeGreaterThan(wide + 10);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(() => height(input)).toBeCloseTo(wide, 0);
}

test("主消息输入框按内容和宽度调整，游玩草稿在修订往返后重新测量", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Layout fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture",
      modelId: "layout-fixture",
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
    name: "Composer fixture",
  });
  const current = await runtime<{ treeRevision: string }>(page, {
    type: "content.read",
    packageId: content.localId,
  });
  await runtime(page, {
    type: "content.replace",
    packageId: content.localId,
    baseTreeRevision: current.treeRevision,
    files: minimalFileNativeContentScaffold(),
  });
  await runtime(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId: content.localId,
    model: {
      provider: "chat_completions",
      modelId: "layout-fixture",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "打开内容包：Composer fixture" })
    .click();
  await exerciseComposer(page, page.locator("#setting-conversation-input"));
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page
    .getByRole("button", { name: "打开世界：Composer fixture" })
    .click();
  const play = page.getByLabel("你的行动", { exact: true });
  await exerciseComposer(page, play);
  const draft = "One\nTwo\nThree\nFour\nFive";
  await play.fill(draft);
  const beforeRevision = await height(play);
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("button", { name: "修订当前世界" }).click();
  await exerciseComposer(page, page.locator("#setting-conversation-input"));
  await page.getByRole("button", { name: "返回游玩" }).click();
  await expect(play).toHaveValue(draft);
  await expect.poll(() => height(play)).toBeCloseTo(beforeRevision, 0);
});
