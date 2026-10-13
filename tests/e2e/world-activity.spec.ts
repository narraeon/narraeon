import { expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { test } from "../support/isolatedRuntimeTest.ts";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";

test.use({ runtimeScope: "world-activity" });
test.setTimeout(60_000);

let provider: Server;
let providerUrl = "";
const narrative = "船长举起灯。\n码头的雾散了。";

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: narrative } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

test("游玩后返回首页按最新活动排序，显示当前正文、相对时间和回合数，中英文与手机均可读", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "活动展示验收",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: providerUrl,
      apiKey: "fixture-only",
      modelId: "activity-fixture",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  for (const title of ["雾港", "旧塔"]) {
    const content = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const detail = await runtime<{ files: ContentTreeFile[] }>(page, {
      type: "content.read",
      packageId: content.localId,
    });
    await runtime(page, {
      type: "content.rename",
      packageId: content.localId,
      name: title,
    });
    await runtime(page, {
      type: "content.replace",
      packageId: content.localId,
      files: detail.files.map((file) =>
        file.path === "opening.md"
          ? { ...file, contents: `${title}的开场。` }
          : file,
      ),
    });
    await runtime(page, {
      type: "world.create",
      operationId: `activity-world-${title === "雾港" ? "harbor" : "tower"}`,
      packageId: content.localId,
      model: {
        provider: "chat_completions",
        modelId: "activity-fixture",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
  }
  await page.goto("/");
  const worlds = page.locator(".home-world-card");
  await expect(worlds).toHaveCount(2);
  await expect(worlds.nth(0).locator("strong")).toHaveText("旧塔");
  await expect(worlds.nth(0)).toContainText("旧塔的开场。");
  await expect(worlds.nth(0)).toContainText("0 回合");
  await page
    .getByRole("button", { name: "打开世界：雾港", exact: true })
    .click();
  await page.getByLabel("你的行动").fill("我向船长招手。");
  const settlement = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runtime/v1") &&
      response.request().method() === "POST" &&
      (response.request().postDataJSON() as { request?: { type?: string } })
        .request?.type === "play.chain.start",
  );
  await page
    .getByRole("button", { name: "从全新上下文发送行动", exact: true })
    .click();
  await expect(page.getByLabel("故事时间线")).toContainText("码头的雾散了。");
  expect(await (await settlement).finished()).toBeNull();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await expect(worlds.nth(0).locator("strong")).toHaveText("雾港");
  await expect(worlds.nth(0)).toContainText("1 回合");
  await expect(worlds.nth(0).locator("time")).toHaveText("刚刚");
  await expect(worlds.nth(0).locator(".home-world-card-excerpt")).toHaveText(
    "船长举起灯。 码头的雾散了。",
  );
  await expect(worlds.nth(0).locator(".home-world-card-excerpt")).toHaveCSS(
    "text-overflow",
    "ellipsis",
  );
  await expect(worlds.nth(0).locator(".home-world-card-excerpt")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(worlds.nth(0)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await expect(worlds.nth(0).locator("time")).toHaveText("Just now");
  await expect(worlds.nth(0)).toContainText("1 turn");
  await page.reload();
  await expect(worlds.nth(0).locator("strong")).toHaveText("雾港");
  await expect(worlds.nth(0).locator(".home-world-card-excerpt")).toHaveText(
    "船长举起灯。 码头的雾散了。",
  );
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
