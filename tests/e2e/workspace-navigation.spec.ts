import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: T };
  return body.result;
}

async function expectStableBackdrop(
  scrim: Locator,
  panel: Locator,
  panelSide: "left" | "right",
): Promise<void> {
  await panel.hover();
  const background = await scrim.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const alpha = Number(/^rgba\(.+,\s*([\d.]+)\)$/u.exec(background)?.[1] ?? 1);
  expect(alpha).toBeGreaterThan(0);
  expect(alpha).toBeLessThan(1);
  const box = await scrim.boundingBox();
  expect(box).not.toBeNull();
  const position = {
    x: panelSide === "left" ? box!.width - 2 : 2,
    y: box!.height / 2,
  };
  await scrim.hover({ position });
  await expect(scrim).toHaveCSS("background-color", background);
  await expect(panel).toBeVisible();
  await scrim.click({ position });
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(panel).toHaveCSS("opacity", "0");
}

test("手机工作区从明确的内容包快捷创建世界，并保护编辑草稿", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "导航验收模型",
      presetId: "custom",
      provider: "chat_completions",
      dialect: "standard",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "navigation-fixture",
      modelId: "navigation-fixture",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "provider_default",
      thinkingBudgetTokens: null,
    },
  });
  const packages: string[] = [];
  const names = ["来源一", "来源二"].map(
    (name) => `${name}-${crypto.randomUUID().slice(0, 8)}`,
  );
  for (const name of names) {
    const created = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const detail = await runtime<{ files: ContentTreeFile[] }>(page, {
      type: "content.read",
      packageId: created.localId,
    });
    await runtime(page, {
      type: "content.rename",
      packageId: created.localId,
      name,
    });
    await runtime(page, {
      type: "content.replace",
      packageId: created.localId,
      files: detail.files.map((file) =>
        file.path === "opening.md"
          ? { ...file, contents: `${name}的已保存开场。` }
          : file,
      ),
    });
    packages.push(created.localId);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "切换页面" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "游玩", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "切换页面" }).click();
  await page
    .getByRole("button", { name: `打开内容包：${names[1]}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `${names[1]} · AI 设定完善` }),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "历史", exact: true }).click();
    await expectStableBackdrop(
      page.locator(".setting-panel-scrim"),
      page.getByLabel("设定完善对话历史", { exact: true }),
      "left",
    );
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await expectStableBackdrop(
      page.locator(".setting-panel-scrim"),
      page.locator(".setting-overlay-rail-right"),
      "right",
    );
  }
  const tools = page.getByRole("navigation", { name: "设定完善工具" });
  await expect(
    tools.getByRole("button", { name: "创建世界", exact: true }),
  ).toBeEnabled();
  await tools.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("选择编辑文件").selectOption("opening.md");
  await page.getByLabel("编辑 opening.md").fill("尚未保存的开场");
  await expect(
    tools.getByRole("button", { name: "创建世界", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "放弃未保存修改", exact: true })
    .click();
  await page.getByRole("button", { name: "收起文件面板" }).click();
  const creation = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request: V1Request }).request.type ===
        "world.create",
  );
  await tools.getByRole("button", { name: "创建世界", exact: true }).click();
  expect(
    ((await creation).postDataJSON() as { request: V1Request }).request,
  ).toMatchObject({ type: "world.create", packageId: packages[1] });
  await expect(page.locator(".world-floating-title")).toHaveText(names[1]!);
  await expect(page.locator(".world-floating-title")).toBeVisible();
  await expect(page.getByLabel("故事时间线")).toContainText(
    `${names[1]}的已保存开场。`,
  );
  await expect(page.getByLabel("故事时间线")).not.toContainText(
    "尚未保存的开场",
  );
  await page.getByRole("button", { name: "此刻", exact: true }).click();
  await expectStableBackdrop(
    page.locator(".world-panel-scrim"),
    page.locator(".world-overlay-rail-left"),
    "left",
  );
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await expectStableBackdrop(
    page.locator(".world-panel-scrim"),
    page.locator(".world-overlay-rail-right"),
    "right",
  );
  await page.getByRole("button", { name: "世界管理", exact: true }).click();
  await page.getByText("世界控制 · 高级编辑", { exact: true }).click();
  await page.getByLabel("世界控制文件（JSON）").fill("invalid draft");
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "放弃控制修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog", { name: "世界管理" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page.getByRole("button", { name: "切换页面" }).click();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "新建世界", exact: true })
    .click();
  await page.getByLabel("创建世界的内容包").selectOption(packages[0]!);
  await expect(page.getByLabel("开场白预览")).toContainText(
    `${names[0]}的已保存开场。`,
  );
  await expect(page.getByLabel("开场白预览")).not.toContainText(
    `${names[1]}的已保存开场。`,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});
