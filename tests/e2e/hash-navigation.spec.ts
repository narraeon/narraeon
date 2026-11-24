import { openWorkspaceCreationTool } from "../support/workspaceNavigation.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  V1Request,
  V1WorldRevisionOverview,
} from "../../src/protocol/v1.ts";

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

async function setup(page: Page) {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "地址导航测试",
      presetId: "custom",
      provider: "chat_completions",
      dialect: "standard",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "hash-navigation-fixture",
      modelId: "hash-navigation-fixture",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "provider_default",
      thinkingBudgetTokens: null,
    },
  });
  const name = `地址-${crypto.randomUUID().slice(0, 8)}`;
  const content = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: content.localId,
    name,
  });
  const world = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: `hash-${crypto.randomUUID()}`,
    packageId: content.localId,
    model: {
      provider: "chat_completions",
      modelId: "hash-navigation-fixture",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
  const presets: string[] = [];
  for (const suffix of ["一", "二"]) {
    const result = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: `${name}-编排方案${suffix}`,
    });
    presets.push(result.preset.id);
  }
  return {
    name,
    packageId: content.localId,
    worldId: world.world.worldId,
    presets,
  };
}

test("世界、内容包、编排方案刷新恢复，书签直接打开世界沿用轻量加载", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await expect(page).toHaveURL(/#\/$/u);
  const requests: V1Request[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/runtime/v1")
    )
      requests.push((request.postDataJSON() as { request: V1Request }).request);
  });
  await page
    .getByRole("button", { name: `打开世界：${data.name}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/world/${data.worldId}$`, "u"));
  await expect(page.getByLabel("故事时间线")).toBeVisible();
  const firstRead = requests.filter((r) => r.type === "world.read");
  expect(firstRead).toEqual([{ type: "world.read", worldId: data.worldId }]);
  expect(
    requests.some(
      (r) =>
        r.type === "world.surface.read" || r.type === "world.play-context.read",
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.locator(".world-floating-title")).toHaveText(data.name);
  await page.goto(`/#/world/${data.worldId}`);
  await expect(page.getByLabel("故事时间线")).toBeVisible();
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/world/${data.worldId}$`, "u"));
  await page.goto(`/#/content/${data.packageId}`);
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  await openWorkspaceCreationTool(page);
  const length = await page.evaluate(() => history.length);
  await page.getByLabel("切换编排方案").selectOption(data.presets[1]!);
  await expect(page).toHaveURL(
    new RegExp(`#/orchestrations/${data.presets[1]}$`, "u"),
  );
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.reload();
  await expect(page.getByLabel("切换编排方案")).toHaveValue(data.presets[1]!);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#/content/${data.packageId}$`, "u"));
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建世界", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  await page.goForward();
  await expect(page.getByLabel("切换编排方案")).toHaveValue(data.presets[1]!);
  await page.evaluate((id) => {
    window.location.hash = `#/presets/${id}`;
  }, data.presets[0]!);
  await expect(page.getByLabel("切换编排方案")).toHaveValue(data.presets[0]!);
  await expect(page).toHaveURL(
    new RegExp(`#/orchestrations/${data.presets[0]}$`, "u"),
  );
});

test("旧列表书签替换为新地址，并按界面语言显示编排方案", async ({ page }) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await page.goto("/#/presets");
  await expect(page).toHaveURL(/#\/orchestrations$/u);
  const tools = page.getByRole("button", {
    name: "Creation tools",
    exact: true,
  });
  await expect(tools).toHaveAttribute("aria-current", "location");
  await tools.click();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("button", { name: "Orchestrations", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Orchestrations", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Switch orchestration")).toBeVisible();
});

for (const removed of [false, true])
  test(`编排方案刷新后浏览器后退恢复内容包页面与地址（${removed ? "原编排方案已删除" : "原编排方案仍存在"}）`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale: "zh-CN" });
    const package_ = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.rename",
      packageId: package_.localId,
      name: "返回的内容包",
    });
    const preset = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: "返回前的编排方案",
    });
    await page.goto(`/#/content/${package_.localId}`);
    await expect(
      page.getByRole("heading", {
        name: "返回的内容包 · AI 设定完善",
        exact: true,
      }),
    ).toBeVisible();
    await openWorkspaceCreationTool(page);
    await page.getByLabel("切换编排方案").selectOption(preset.preset.id);
    await page.reload();
    await expect(page.getByLabel("切换编排方案")).toHaveValue(preset.preset.id);
    if (removed)
      await runtime(page, { type: "play.delete", presetId: preset.preset.id });
    await page.goBack();
    await expect(page).toHaveURL(
      new RegExp(`#/content/${package_.localId}$`, "u"),
    );
    await expect(
      page.getByRole("heading", {
        name: "返回的内容包 · AI 设定完善",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "返回工作区", exact: true }),
    ).toBeEnabled();
    await page.goForward();
    if (removed) {
      await expect(page).toHaveURL(/#\/$/u);
      await expect(
        page.getByText("找不到该编排方案。", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(page.getByLabel("切换编排方案")).toHaveValue(
        preset.preset.id,
      );
      await expect(page).toHaveURL(
        new RegExp(`#/orchestrations/${preset.preset.id}$`, "u"),
      );
    }
  });

test("后退、前进按页面历史切换，新建、预览、模型页支持书签", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: `打开世界：${data.name}`, exact: true })
    .click();
  await expect(page.getByLabel("故事时间线")).toBeVisible();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await page
    .getByRole("button", { name: `打开内容包：${data.name}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/content/${data.packageId}$`, "u"));
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建世界", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "世界工作区" })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".world-floating-title")).toHaveText(data.name);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "世界工作区" })).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回工作区", exact: true }),
  ).toBeEnabled();
  for (const [hash, screen] of [
    ["#/create", "create"],
    ["#/preview", "preview"],
    ["#/models", "model"],
  ]) {
    await page.goto(`/${hash}`);
    await expect(page.locator(".workspace-shell")).toHaveAttribute(
      "data-screen",
      screen!,
    );
    await page.reload();
    await expect(page.locator(".workspace-shell")).toHaveAttribute(
      "data-screen",
      screen!,
    );
  }
});

for (const draft of [
  "content",
  "preset",
  "model",
  "world",
  "revision",
] as const) {
  test(`${draft} 未保存修改阻止后退，恢复地址并保留草稿`, async ({ page }) => {
    const data = await setup(page);
    await page.goto("/");
    if (draft === "content") {
      await page
        .getByRole("button", { name: `打开内容包：${data.name}`, exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "设定完善工具" })
        .getByRole("button", { name: "编辑", exact: true })
        .click();
      await page
        .getByRole("button", { name: "打开 opening.md", exact: true })
        .click();
      await fillWithUnloadProtection(
        page.getByLabel("编辑 opening.md"),
        "地址测试未保存开场",
      );
    } else if (draft === "preset") {
      await openWorkspaceCreationTool(page);
      await page.getByText("编排方案操作", { exact: true }).click();
      await fillWithUnloadProtection(
        page.getByLabel("编排方案名称", { exact: true }),
        "地址测试未保存编排方案",
      );
    } else if (draft === "model") {
      await page.getByRole("button", { name: "模型设置", exact: true }).click();
      await fillWithUnloadProtection(
        page.getByLabel("配置名称"),
        "地址测试未保存模型",
      );
    } else {
      await page
        .getByRole("button", { name: `打开世界：${data.name}`, exact: true })
        .click();
      if (draft === "world") {
        await page
          .getByRole("button", { name: "世界管理", exact: true })
          .click();
        await page.getByText("世界控制 · 高级编辑", { exact: true }).click();
        await fillWithUnloadProtection(
          page.getByLabel("世界控制文件（JSON）"),
          "地址测试未保存控制",
        );
      } else {
        await page.getByRole("button", { name: "世界", exact: true }).click();
        await page
          .getByRole("button", { name: "修订当前世界", exact: true })
          .click();
        await page
          .getByRole("navigation", { name: "世界修订工具" })
          .getByRole("button", { name: "编辑", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "打开 state/current-situation.yaml",
            exact: true,
          })
          .click();
        const opened = page.waitForResponse((response) => {
          const request = response.request();
          return (
            request.url().endsWith("/api/runtime/v1") &&
            request.method() === "POST" &&
            (request.postDataJSON() as { request: V1Request }).request.type ===
              "world.revision.open"
          );
        });
        await fillWithUnloadProtection(
          page.getByLabel("编辑 state/current-situation.yaml"),
          "地址测试未保存修订",
        );
        expect((await opened).ok()).toBe(true);
      }
    }
    // The Runtime receipt and enabled header distinguish an open revision
    // draft from the pending write that first creates its worktree.
    await expect(
      page.getByRole("button", { name: "模型设置", exact: true }),
    ).toBeEnabled();
    const address = page.url();
    const historyLength = await page.evaluate(() => history.length);
    await page.goBack();
    const dialog = discardNavigationDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page).toHaveURL(address);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    const labels = {
      content: "编辑 opening.md",
      preset: "编排方案名称",
      model: "配置名称",
      world: "世界控制文件（JSON）",
      revision: "编辑 state/current-situation.yaml",
    };
    const values = {
      content: "地址测试未保存开场",
      preset: "地址测试未保存编排方案",
      model: "地址测试未保存模型",
      world: "地址测试未保存控制",
      revision: "地址测试未保存修订",
    };
    await expect(
      page.getByLabel(labels[draft], { exact: draft === "preset" }),
    ).toHaveValue(values[draft]);
    await page.goBack();
    await dialog.getByRole("button", { name: "放弃并离开" }).click();
    await expect(
      page.getByRole("heading", { name: "世界工作区" }),
    ).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    if (draft === "revision") {
      const revision = await runtime<V1WorldRevisionOverview>(page, {
        type: "world.revision.overview",
        worldId: data.worldId,
      });
      expect(revision.epoch?.locked).toBe(true);
      expect(revision.epoch?.diff).toEqual([]);
    }
  });
}

test("无效、缺少身份或已删除的地址回首页且不会新建内容包", async ({ page }) => {
  const data = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: `打开世界：${data.name}`, exact: true })
    .click();
  await expect(page.getByLabel("故事时间线")).toBeVisible();
  await page.getByRole("button", { name: "返回工作区", exact: true }).click();
  await runtime(page, { type: "world.delete", worldId: data.worldId });
  await page.goBack();
  await expect(page).toHaveURL(/#\/$/u);
  await expect(page.getByText("找不到该世界。", { exact: true })).toBeVisible();
  await runtime(page, { type: "content.delete", packageId: data.packageId });
  const before = await runtime<{ contentPackages: { localId: string }[] }>(
    page,
    { type: "workspace.read" },
  );
  const addresses = [
    ["#/content", "找不到该内容包。"],
    ["#/content/%E0%A4%A", "找不到该内容包。"],
    [`#/content/${data.packageId}`, "找不到该内容包。"],
    [`#/world/${data.worldId}`, "找不到该世界。"],
    ["#/world/not-a-world", "找不到该世界。"],
    ["#/orchestrations/missing", "找不到该编排方案。"],
    ["#/unknown", "找不到该页面。"],
  ];
  for (const [hash, message] of addresses) {
    await page.goto(`/${hash}`);
    await expect(page).toHaveURL(/#\/$/u);
    await expect(
      page.getByRole("heading", { name: "世界工作区" }),
    ).toBeVisible();
    await expect(page.getByText(message!, { exact: true })).toBeVisible();
  }
  const after = await runtime<{ contentPackages: { localId: string }[] }>(
    page,
    { type: "workspace.read" },
  );
  expect(after.contentPackages.map((p) => p.localId)).toEqual(
    before.contentPackages.map((p) => p.localId),
  );
  await runtime(page, { type: "preferences.save", locale: "en" });
  await page.goto("/#/world/not-a-world");
  await expect(
    page.getByText("World not found.", { exact: true }),
  ).toBeVisible();
});

function discardNavigationDialog(page: Page) {
  return page.getByRole("dialog", {
    name: "此页有未保存的修改。要放弃修改并离开吗？",
  });
}

function browserHistory(page: Page) {
  return page.evaluate(() => ({
    length: history.length,
    entries: window.navigation?.entries().map(({ url, key }) => ({ url, key })),
  }));
}

for (const supportsNavigationApi of [true, false]) {
  test(`repeated Back and Forward preserve the exact history and the draft until confirmed (Navigation API: ${supportsNavigationApi})`, async ({
    page,
  }) => {
    if (!supportsNavigationApi)
      await page.addInitScript(() =>
        Object.defineProperty(window, "navigation", { value: undefined }),
      );
    await setup(page);
    await page.goto("/");
    await openWorkspaceCreationTool(page);
    const orchestration = page.url();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "内容库", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "内容库", exact: true }),
    ).toBeVisible();
    await page.goBack();
    const name = page.getByLabel("配置名称");
    const unchanged = await name.inputValue();
    await name.fill("仍在编辑的模型名称");
    const original = await browserHistory(page);
    const dialog = discardNavigationDialog(page);

    await page.goBack();
    await expect(page).toHaveURL(orchestration);
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/$/u);
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page).toHaveURL(/#\/models$/u);
    await expect(name).toHaveValue("仍在编辑的模型名称");
    expect(await browserHistory(page)).toEqual(original);

    await page.goForward();
    await expect(page).toHaveURL(/#\/library$/u);
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(name).toHaveValue("仍在编辑的模型名称");

    await page.goForward();
    await dialog.getByRole("button", { name: "放弃并离开" }).click();
    await expect(
      page.getByRole("heading", { name: "内容库", exact: true }),
    ).toBeVisible();
    expect(await browserHistory(page)).toEqual(original);
    await page.goBack();
    await expect(name).toHaveValue(unchanged);
    await page.goBack();
    await expect(page).toHaveURL(orchestration);
    await page.goForward();
    await expect(name).toHaveValue(unchanged);
    expect(await browserHistory(page)).toEqual(original);
  });
}

test("hash deep links and program navigation share draft confirmation and Android Back", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const name = page.getByLabel("配置名称");
  await name.fill("Android 返回需要先保留的草稿");
  const dialog = discardNavigationDialog(page);
  const androidBack = () =>
    page.evaluate(() =>
      (
        window as Window & { narraeonAndroidBack?: () => boolean }
      ).narraeonAndroidBack?.(),
    );
  const original = await browserHistory(page);
  expect(await androidBack()).toBe(false);
  // When no overlay handles Back, the Android host calls WebView.goBack().
  await page.goBack();
  await expect(dialog).toBeVisible();
  expect(await androidBack()).toBe(true);
  await expect(page).toHaveURL(/#\/models$/u);
  await expect(name).toHaveValue("Android 返回需要先保留的草稿");
  expect(await browserHistory(page)).toEqual(original);

  await page.getByRole("button", { name: "内容库", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await browserHistory(page)).toEqual(original);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(name).toHaveValue("Android 返回需要先保留的草稿");

  await page.evaluate((id) => {
    window.location.hash = `#/content/${id}`;
  }, data.packageId);
  await expect(dialog).toBeVisible();
  const withHash = await browserHistory(page);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page).toHaveURL(/#\/models$/u);
  expect(await browserHistory(page)).toEqual(withHash);
  await page.goForward();
  await dialog.getByRole("button", { name: "放弃并离开" }).click();
  await expect(
    page.getByRole("heading", { name: `${data.name} · AI 设定完善` }),
  ).toBeVisible();
  expect(await browserHistory(page)).toEqual(withHash);

  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(name).not.toHaveValue("Android 返回需要先保留的草稿");
  await name.fill("程序导航后应丢弃的草稿");
  const beforeProgram = await browserHistory(page);
  await page.getByRole("button", { name: "内容库", exact: true }).click();
  await dialog.getByRole("button", { name: "放弃并离开" }).click();
  await expect(
    page.getByRole("heading", { name: "内容库", exact: true }),
  ).toBeVisible();
  expect((await browserHistory(page)).length).toBe(beforeProgram.length + 1);
  await page.goBack();
  await expect(name).not.toHaveValue("程序导航后应丢弃的草稿");
});

test("only a dirty draft asks for native confirmation on refresh and close", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/#/models");
  const name = page.getByLabel("配置名称");
  const savedName = await name.inputValue();
  const beforeUnloadWasPrevented = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await beforeUnloadWasPrevented()).toBe(false);
  await name.fill("刷新仍需保留的草稿");
  expect(await beforeUnloadWasPrevented()).toBe(true);

  const discard = page.getByRole("button", { name: "放弃修改", exact: true });
  await discard.click();
  expect(await beforeUnloadWasPrevented()).toBe(false);
  await name.click();
  await name.evaluate((input) => {
    window.addEventListener(
      "input",
      (event) => {
        if (event.target === input) location.reload();
      },
      { once: true },
    );
  });
  const beforeRefresh = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await Promise.all([beforeRefresh, name.fill("刷新仍需保留的草稿")]);
  await expect(name).toHaveValue("刷新仍需保留的草稿");

  await discard.click();
  expect(await beforeUnloadWasPrevented()).toBe(false);
  const beforeClose = page.waitForEvent("dialog");
  await name.fill("关闭仍需保留的草稿");
  await page.close({ runBeforeUnload: true });
  const closeDialog = await beforeClose;
  expect(closeDialog.type()).toBe("beforeunload");
  await closeDialog.dismiss();
  await expect(name).toHaveValue("关闭仍需保留的草稿");

  await discard.click();
  expect(await beforeUnloadWasPrevented()).toBe(false);
  await page.reload();
  await expect(name).toHaveValue(savedName);
});

test("a running creation keeps its history entry without registering beforeunload", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  await page
    .locator(".home-world-library")
    .getByRole("button", { name: "新建世界" })
    .click();
  const pendingCreation = Promise.withResolvers<void>();
  await page.route("**/api/runtime/v1", async (route) => {
    const input = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (input.type !== "world.create") return route.continue();
    await pendingCreation.promise;
    return route.abort();
  });
  const start = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request: V1Request }).request.type ===
        "world.create",
  );
  await page
    .getByRole("button", { name: "从当前内容包创建", exact: true })
    .click();
  await start;
  try {
    const original = await browserHistory(page);
    await page.goBack();
    await expect(page).toHaveURL(/#\/create$/u);
    await expect(discardNavigationDialog(page)).toBeHidden();
    await expect(
      page.getByText("当前操作仍在进行，请等它结束后再切换页面。"),
    ).toBeVisible();
    expect(await browserHistory(page)).toEqual(original);
    expect(
      await page.evaluate(
        () =>
          !window.dispatchEvent(
            new Event("beforeunload", { cancelable: true }),
          ),
      ),
    ).toBe(false);
  } finally {
    pendingCreation.resolve();
  }
});

for (const supportsNavigationApi of [true, false]) {
  test(`unsaved changes survive Back into an unmarked pre-upgrade entry (Navigation API: ${supportsNavigationApi})`, async ({
    page,
  }) => {
    if (!supportsNavigationApi)
      await page.addInitScript(() =>
        Object.defineProperty(window, "navigation", { value: undefined }),
      );
    await setup(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "世界工作区" }),
    ).toBeVisible();
    await page.evaluate(() => {
      history.replaceState(null, "", "#/library");
      history.pushState(null, "", "#/models");
    });
    await page.reload();
    const name = page.getByLabel("配置名称");
    await name.fill("更新之后编辑的模型名称");
    const original = await browserHistory(page);
    await page.goBack();
    await discardNavigationDialog(page)
      .getByRole("button", { name: "取消" })
      .click();
    if (!supportsNavigationApi) {
      await expect(
        page.getByText("浏览器无法恢复旧历史地址，当前页面的修改仍在。"),
      ).toBeVisible();
      await expect(page).toHaveURL(/#\/library$/u);
      await page.goForward();
    }
    await expect(page).toHaveURL(/#\/models$/u);
    await expect(name).toHaveValue("更新之后编辑的模型名称");
    expect(await browserHistory(page)).toEqual(original);
  });
}

test("retrying a failed browser package read reuses the existing history entry", async ({
  page,
}) => {
  const data = await setup(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: `打开内容包：${data.name}`, exact: true })
    .click();
  const heading = page.getByRole("heading", {
    name: `${data.name} · AI 设定完善`,
  });
  await expect(heading).toBeVisible();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByLabel("配置名称")).toBeVisible();
  const original = await browserHistory(page);
  let failures = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (
      request.type === "content.read" &&
      request.packageId === data.packageId &&
      failures < 2
    ) {
      failures += 1;
      return route.abort();
    }
    return route.continue();
  });

  await page.goBack();
  const reload = page.getByRole("button", { name: "重新加载", exact: true });
  await expect(reload).toBeVisible();
  await expect(page).toHaveURL(/#\/models$/u);
  expect(failures).toBe(2);
  await reload.click();
  await expect(heading).toBeVisible();
  expect(await browserHistory(page)).toEqual(original);
});

test("the protagonist template draft protects unload during the input event", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/#/create");
  await page.getByRole("button", { name: "管理主角模板" }).click();
  await fillWithUnloadProtection(
    page.getByRole("textbox", { name: "模板正文" }),
    "仍未保存的主角模板",
  );
});

async function fillWithUnloadProtection(
  input: Locator,
  value: string,
): Promise<void> {
  // React handles the edit at the root before the native input event bubbles
  // to window. Record the guard result there, without another browser task.
  await input.evaluate((field) => {
    window.addEventListener(
      "input",
      (event) => {
        if (event.target !== field) return;
        const unload = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(unload);
        field.setAttribute(
          "data-unload-protected-on-input",
          String(unload.defaultPrevented),
        );
      },
      { once: true },
    );
  });
  await input.fill(value);
  expect(await input.getAttribute("data-unload-protected-on-input")).toBe(
    "true",
  );
}
