import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { openFrameSource } from "../support/worldControlEditor.ts";

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

async function expectEscapeClosesRail(
  page: Page,
  opener: Locator,
  panel: Locator,
  closeLabel: string,
): Promise<void> {
  await opener.press("Enter");
  await expect(panel).toHaveAttribute("aria-hidden", "false");
  await expect(panel.getByRole("button", { name: closeLabel })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("aria-hidden", "true");
  await expect(opener).toBeFocused();
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
      baseTreeRevision: (
        await runtime<{ treeRevision: string }>(page, {
          type: "content.read",
          packageId: created.localId,
        })
      ).treeRevision,
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
    await expectEscapeClosesRail(
      page,
      page.getByRole("button", { name: "历史", exact: true }),
      page.locator(".setting-overlay-rail-left"),
      "收起对话历史",
    );
    await expectEscapeClosesRail(
      page,
      page.getByRole("button", { name: "文件", exact: true }),
      page.locator(".setting-overlay-rail-right"),
      "收起文件面板",
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
  ).toBeEnabled();
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
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("button", { name: "修订当前世界", exact: true }).click();
  await expectEscapeClosesRail(
    page,
    page.getByRole("button", { name: "历史", exact: true }),
    page.locator(".setting-overlay-rail-left"),
    "收起对话历史",
  );
  await expectEscapeClosesRail(
    page,
    page
      .getByRole("navigation", { name: "世界修订工具" })
      .getByRole("button", { name: "编辑", exact: true }),
    page.locator(".setting-overlay-rail-right"),
    "收起文件面板",
  );
  await page.getByRole("button", { name: "返回游玩", exact: true }).click();
  await page.getByRole("button", { name: "世界管理", exact: true }).click();
  const management = page.getByRole("dialog", { name: "世界管理" });
  await management.getByText("世界控制 · 高级编辑", { exact: true }).click();
  const frame = await openFrameSource(management);
  await frame.fill("invalid: [draft");
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "放弃控制修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  await management.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page
    .locator(".home-world-library")
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

test("手机地址栏展开和收起时，长页面只在标题栏下方滚动", async ({ page }) => {
  // Headless browsers have no address bar. Give large viewport units their
  // toolbar-hidden value while the actual viewport changes below.
  const largeHeight = 754;
  await page.route("**/*.css", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /(\d+(?:\.\d+)?)l?vh\b/gu,
      (_, amount: string) => `${(Number(amount) * largeHeight) / 100}px`,
    );
    await route.fulfill({ response, body });
  });
  await page.setViewportSize({ width: 390, height: largeHeight });
  await page.goto("/#/models");
  await expect(page.locator(".model-connection-screen")).toBeVisible();

  const content = page.locator(".workspace-body");
  const menu = page.locator(".workspace-menu-toggle");
  for (const height of [714, largeHeight]) {
    await page.setViewportSize({ width: 390, height });
    const atBottom = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return (
        element.scrollTop > 0 &&
        element.scrollTop + element.clientHeight === element.scrollHeight
      );
    });
    expect(atBottom).toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const headerBox = await page.locator(".workspace-header").boundingBox();
    expect(headerBox?.y).toBe(0);
    expect(
      await content.evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBe(height);
    await menu.click();
    await expect(page.locator(".workspace-navigation")).toBeVisible();
    await menu.click();
  }
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`primary navigation and creation tools work on desktop and mobile (${locale})`, async ({
    page,
  }) => {
    const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
    await runtime(page, { type: "preferences.save", locale });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Navigation menu fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture",
        modelId: "fixture",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const pack = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.rename",
      packageId: pack.localId,
      name: `Nav ${locale}`,
    });
    const nav = page.getByRole("navigation", {
      name: t("工作区导航", "Workspace navigation"),
    });
    const button = (zh: string, en: string) =>
      nav.getByRole("button", { name: t(zh, en), exact: true });
    const worlds = button("我的世界", "My worlds");
    const library = button("内容库", "Content library");
    const settings = button("模型设置", "Model settings");
    const tools = button("创作工具", "Creation tools");
    const plans = button("编排方案", "Orchestrations");
    const preview = button("提示词预览", "Prompt Preview");
    const menu = button("切换页面", "Switch page");
    const androidBack = () =>
      page.evaluate(() =>
        (
          window as Window & { narraeonAndroidBack?: () => boolean }
        ).narraeonAndroidBack?.(),
      );

    await page.setViewportSize({ width: 1280, height: 850 });
    await page.goto("/");
    await expect(worlds).toHaveAttribute("aria-current", "page");
    await expect(library).toBeVisible();
    await expect(settings).toBeVisible();
    await expect(plans).toBeHidden();
    await expect(preview).toBeHidden();
    await expect(button("新建世界", "Create world")).toHaveCount(0);
    await expect(
      page.locator(".home-world-library").getByRole("button", {
        name: t("新建世界", "Create world"),
        exact: true,
      }),
    ).toBeVisible();
    await tools.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(plans).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tools).toBeFocused();
    await expect(plans).toBeHidden();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/orchestrations(?:\/[^/]+)?$/u);
    await expect(tools).toHaveAttribute("aria-current", "location");
    await page.reload();
    await tools.click();
    await expect(plans).toHaveAttribute("aria-current", "page");
    await preview.click();
    await expect(page).toHaveURL(/#\/preview$/u);
    await page.goBack();
    await expect(page).toHaveURL(/#\/orchestrations(?:\/[^/]+)?$/u);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settings).toBeVisible();
    await expect(worlds).toBeHidden();
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(worlds).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(library).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/library$/u);
    await expect(
      page.getByRole("heading", {
        name: t("内容库", "Content library"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: t(
          `打开内容包：Nav ${locale}`,
          `Open content package: Nav ${locale}`,
        ),
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await menu.click();
    await expect(library).toHaveAttribute("aria-current", "page");
    await tools.click();
    await expect(plans).toBeVisible();
    expect(await androidBack()).toBe(true);
    await expect(tools).toBeFocused();
    await expect(plans).toBeHidden();
    expect(await androidBack()).toBe(true);
    await expect(menu).toBeFocused();
    await expect(worlds).toBeHidden();
    expect(await androidBack()).toBe(false);
    await page.goBack();
    await expect(page).toHaveURL(/#\/orchestrations(?:\/[^/]+)?$/u);
    await page.goForward();
    await expect(page).toHaveURL(/#\/library$/u);
    await settings.click();
    await expect(settings).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL(/#\/models$/u);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  });
}
