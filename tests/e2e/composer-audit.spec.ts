import { expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { minimalFileNativeContentScaffold } from "../../src/runtime/content/ContentWorkspace.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

let provider: Server;
let providerUrl: string;
const replies: ((response: ServerResponse) => void)[] = [];

test.use({ runtimeScope: "composer-audit" });

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = replies.shift();
      if (reply) reply(response);
      else response.writeHead(500).end("Unexpected model request");
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture address");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function seed(page: Page) {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Composer audit provider",
      presetId: "custom",

      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture",
      modelId: "audit-fixture",
      contextWindowTokens: 10_000,
      maxOutputTokens: 1024,
    },
  });
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { treeRevision } = await runtime<{ treeRevision: string }>(page, {
    type: "content.read",
    packageId: localId,
  });
  await runtime(page, {
    type: "content.replace",
    packageId: localId,
    baseTreeRevision: treeRevision,
    files: minimalFileNativeContentScaffold(),
  });
  const { world } = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId: localId,
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  return { worldId: world.worldId, packageId: localId };
}

function reply(response: ServerResponse, text: string, inputTokens: number) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 20 } })}\n\n` +
      "data: [DONE]\n\n",
  );
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color
      .match(/\d+/gu)
      ?.slice(0, 3)
      .map((value) => {
        const s = Number(value) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
    if (channels?.length !== 3) throw new Error(`Cannot measure ${color}`);
    return (
      channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    );
  };
  const colors = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (colors[0]! + 0.05) / (colors[1]! + 0.05);
}

function buttonColors(button: Locator) {
  return button.evaluate((element) => {
    const css = getComputedStyle(element);
    return [css.color, css.backgroundColor] as const;
  });
}

async function checkDisabledSend(send: Locator) {
  await expect(send).toBeDisabled();
  const disabledColors = await buttonColors(send);
  await send.hover();
  expect(await buttonColors(send)).toEqual(disabledColors);
  expect(contrast(...disabledColors)).toBeGreaterThanOrEqual(4.5);
  return disabledColors[1];
}

async function checkSendStyles(page: Page, input: Locator, send: Locator) {
  await expect(send).toBeEnabled();
  await send.hover();
  expect
    .soft(contrast(...(await buttonColors(send))), "hover foreground contrast")
    .toBeGreaterThanOrEqual(4.5);
  await input.hover();
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();
  const focus = await send.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      visible:
        element.matches(":focus-visible") &&
        css.outlineStyle !== "none" &&
        parseFloat(css.outlineWidth) >= 2,
      ring: css.outlineColor,
      surface: getComputedStyle(element.closest("footer")!).backgroundColor,
    };
  });
  expect.soft(focus.visible).toBe(true);
  expect
    .soft(contrast(focus.ring, focus.surface), "keyboard focus contrast")
    .toBeGreaterThanOrEqual(3);
  expect
    .soft(
      contrast(...(await buttonColors(send))),
      "keyboard focus foreground contrast",
    )
    .toBeGreaterThanOrEqual(4.5);
}

test("#429 keeps play and both authoring send buttons legible on hover and keyboard focus", async ({
  page,
}) => {
  const { worldId, packageId } = await seed(page);
  await page.goto(`/#/world/${worldId}`);
  const play = page.getByRole("textbox", { name: "你的行动" });
  const send = page.getByRole("button", { name: "从全新上下文发送行动" });
  const disabledBackground = await checkDisabledSend(send);
  const beforeInput = (await play.boundingBox())!.width;
  await play.fill("Look around.");
  expect((await play.boundingBox())!.width).toBeCloseTo(beforeInput, 0);
  await expect(send).toHaveText("↑");
  await checkSendStyles(page, play, send);
  expect((await buttonColors(send))[1]).not.toBe(disabledBackground);
  replies.push((response) => reply(response, "The room is quiet.", 300));
  await send.click();
  const continueStory = page.getByRole("button", { name: "继续故事" });
  await expect(continueStory).toHaveText("继续故事");
  await checkSendStyles(page, play, continueStory);

  const author = page.locator("#setting-conversation-input");
  const authorSend = page.getByRole("button", { name: "发送", exact: true });
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("button", { name: "修订当前世界" }).click();
  await checkDisabledSend(authorSend);
  await author.fill("Check the current state.");
  await checkSendStyles(page, author, authorSend);
  await page.goto(`/#/content/${packageId}`);
  await expect(author).toHaveValue("");
  await checkDisabledSend(authorSend);
  await author.fill("Check these files.");
  await checkSendStyles(page, author, authorSend);
});

test("#430 keeps context and extensions on one row and reserves the send slot", async ({
  page,
}) => {
  const { worldId } = await seed(page);
  await page.goto(`/#/world/${worldId}`);
  const play = page.getByRole("textbox", { name: "你的行动" });
  const usage = page.getByText("上下文 —", { exact: true });
  const status = page.getByRole("region", { name: "游玩状态" });
  const extensions = page.getByText("世界扩展", { exact: true });
  await expect(usage).toHaveAttribute(
    "title",
    "当前上下文尚无已完成的 AI 响应。",
  );
  await expect(extensions).toBeVisible();
  expect
    .soft(
      Math.abs(
        (await usage.boundingBox())!.y - (await extensions.boundingBox())!.y,
      ),
    )
    .toBeLessThan(6);
  expect.soft(await status.evaluate((element) => element.tabIndex)).toBe(-1);
  await extensions.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("更多", { exact: true })).toBeFocused();
  await usage.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("当前上下文尚无已完成的 AI 响应。", { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(usage).toBeFocused();

  await extensions.click();
  const options = page.locator(".world-extension-options");
  await expect(options).toBeVisible();
  expect
    .soft(await options.locator("fieldset:not(:has(input))").count())
    .toBe(0);
  await expect(
    options.getByRole("checkbox", { name: "内容包后置请求" }),
  ).toHaveCount(0);
  await play.click();
  await expect.soft(options).toBeHidden({ timeout: 800 });
  if (await options.isHidden()) await extensions.click();
  await options.getByRole("checkbox").first().focus();
  await page.keyboard.press("Escape");
  await expect(options).toBeHidden();
  await expect(extensions).toBeFocused();

  replies.push((response) => reply(response, "A door opens.", 8500));
  await play.fill("Look around.");
  await page.getByRole("button", { name: "从全新上下文发送行动" }).click();
  await expect(page.getByText("上下文 85%", { exact: true })).toBeVisible();
  const warning = page.getByText("上下文已用 85%，建议下一条从全新上下文开始");
  await expect(warning.locator("..")).toHaveCSS(
    "background-color",
    "rgb(250, 242, 223)",
  );
  const send = page.getByRole("button", { name: "继续故事" });
  await expect(send).toHaveText("继续故事");
  for (const width of [1200, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const empty = (await play.boundingBox())!.width;
    await play.press("a");
    await expect(page.getByRole("button", { name: "追加行动" })).toHaveText(
      "↑",
    );
    expect.soft((await play.boundingBox())!.width).toBeCloseTo(empty, 0);
    await play.fill("");
  }
  await page.setViewportSize({ width: 375, height: 465 });
  const toggle = page.getByRole("button", { name: /游玩状态/u });
  await expect(toggle).toBeVisible();
  await expect(warning).toBeHidden();
  await toggle.click();
  await expect(warning).toBeVisible();
  await expect
    .poll(() =>
      status.evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(1);
  await extensions.focus();
  await page.keyboard.press("Tab");
  await expect(status).toBeFocused();
  await page.keyboard.press("End");
  await expect
    .poll(() => status.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("#431 shows compact live progress and keeps a world error selectable and dismissible", async ({
  page,
}, testInfo) => {
  const { worldId, packageId } = await seed(page);
  await page.goto(`/#/content/${packageId}`);
  const authoringReply = Promise.withResolvers<ServerResponse>();
  replies.push((response) => authoringReply.resolve(response));
  await page.locator("#setting-conversation-input").fill("Read the setting.");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const authoringProgress = page.locator(".setting-conversation-running");
  await expect(authoringProgress).toContainText("AI 正在处理…");
  await expect(authoringProgress).toHaveCSS(
    "background-color",
    "rgb(247, 246, 241)",
  );
  reply(await authoringReply.promise, "I can read this setting.", 100);
  await expect(authoringProgress).toBeHidden();
  await expect(
    page.getByText("I can read this setting.", { exact: true }),
  ).toBeVisible();

  await page.goto(`/#/world/${worldId}`);
  const play = page.getByRole("textbox", { name: "你的行动" });
  const pending = Promise.withResolvers<ServerResponse>();
  replies.push((response) => pending.resolve(response));
  await play.fill("Wait here.");
  await page.getByRole("button", { name: "从全新上下文发送行动" }).click();
  const response = await pending.promise;
  const progress = page.getByLabel("本次模型调用进度");
  const cancel = progress.getByRole("button", { name: "取消生成" });
  await expect(progress).toContainText("正在等待模型响应");
  await expect(progress).toContainText("已运行");
  await expect(progress).toContainText(/收到新数据|没有新数据/u);
  for (const text of [
    "Provider 派发",
    "返回推理",
    "正文",
    "工具参数",
    "工具调用",
  ]) {
    await expect(progress.getByText(text, { exact: true })).toBeVisible();
  }
  const phase = progress.getByText("正在等待模型响应…", { exact: true });
  expect
    .soft(
      Math.abs(
        (await cancel.boundingBox())!.y - (await phase.boundingBox())!.y,
      ),
    )
    .toBeLessThan(18);
  await page.screenshot({
    path: testInfo.outputPath("play-progress-desktop.png"),
  });
  await page.setViewportSize({ width: 375, height: 465 });
  await expect.soft(cancel).toBeInViewport({ timeout: 800 });
  await page.screenshot({
    path: testInfo.outputPath("play-progress-short.png"),
  });
  reply(response, "The rain stops.", 100);
  await expect(progress).toBeHidden();
  await expect(page.getByText("The rain stops.")).toBeVisible();

  await page.route("**/api/runtime/v1", async (route) => {
    if (
      (route.request().postDataJSON() as { request?: V1Request } | null)
        ?.request?.type === "world.rename"
    ) {
      await route.fulfill({
        status: 400,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "invalid_request",
            message: "Rename denied by the test fixture.",
          },
        },
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "世界管理", exact: true }).click();
  await page.getByLabel("世界显示名称").fill("A new name");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  const error = page.locator(".world-feedback.error");
  await expect(error).toBeVisible();
  await page
    .getByRole("dialog", { name: "世界管理" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  const errorText = error.getByText("Rename denied by the test fixture.");
  await expect(errorText).toBeVisible();
  await expect(error).toHaveCSS("background-color", "rgb(251, 237, 235)");
  expect
    .soft(
      await errorText.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return element.contains(hit);
      }),
    )
    .toBe(true);
  await errorText.dblclick({ position: { x: 16, y: 8 } });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    "Rename",
  );
  const close = error.getByRole("button", { name: "关闭提示" });
  await close.focus({ timeout: 800 });
  await page.keyboard.press("Enter");
  await expect(error).toBeHidden();
});
