import { expect, test, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";

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
      name: `${name}-预设${suffix}`,
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

test("世界、内容包、预设刷新恢复，书签直接打开世界沿用轻量加载", async ({
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
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "预设", exact: true })
    .click();
  const length = await page.evaluate(() => history.length);
  await page.getByLabel("切换预设").selectOption(data.presets[1]!);
  await expect(page).toHaveURL(
    new RegExp(`#/presets/${data.presets[1]}$`, "u"),
  );
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.reload();
  await expect(page.getByLabel("切换预设")).toHaveValue(data.presets[1]!);
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
  await expect(page.getByLabel("切换预设")).toHaveValue(data.presets[1]!);
  await page.evaluate((id) => {
    window.location.hash = `#/presets/${id}`;
  }, data.presets[0]!);
  await expect(page.getByLabel("切换预设")).toHaveValue(data.presets[0]!);
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

for (const draft of ["content", "preset", "model", "world"] as const) {
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
      await page.getByLabel("编辑 opening.md").fill("地址测试未保存开场");
    } else if (draft === "preset") {
      await page
        .getByRole("navigation", { name: "工作区导航" })
        .getByRole("button", { name: "预设", exact: true })
        .click();
      await page.getByText("预设操作", { exact: true }).click();
      await page
        .getByLabel("玩法预设名称", { exact: true })
        .fill("地址测试未保存预设");
    } else if (draft === "model") {
      await page.getByRole("button", { name: "模型连接", exact: true }).click();
      await page.getByLabel("配置名称").fill("地址测试未保存模型");
    } else {
      await page
        .getByRole("button", { name: `打开世界：${data.name}`, exact: true })
        .click();
      await page.getByRole("button", { name: "世界管理", exact: true }).click();
      await page.getByText("世界控制 · 高级编辑", { exact: true }).click();
      await page.getByLabel("世界控制文件（JSON）").fill("地址测试未保存控制");
    }
    const address = page.url();
    await expect(
      page.getByRole("button", { name: "返回工作区", exact: true }),
    ).toBeDisabled();
    await page.goBack();
    await expect(page).toHaveURL(address);
    await expect(
      page.getByText("已保留当前页面的未保存修改，请保存或放弃后再切换。", {
        exact: true,
      }),
    ).toBeVisible();
    const labels = {
      content: "编辑 opening.md",
      preset: "玩法预设名称",
      model: "配置名称",
      world: "世界控制文件（JSON）",
    };
    const values = {
      content: "地址测试未保存开场",
      preset: "地址测试未保存预设",
      model: "地址测试未保存模型",
      world: "地址测试未保存控制",
    };
    await expect(
      page.getByLabel(labels[draft], { exact: draft === "preset" }),
    ).toHaveValue(values[draft]);
    if (draft === "content") {
      await page
        .getByRole("button", { name: "放弃未保存修改", exact: true })
        .click();
      await page.getByRole("button", { name: "收起文件面板" }).click();
      await page.goBack();
      await expect(page).toHaveURL(/#\/$/u);
      await expect(
        page.getByRole("heading", { name: "世界工作区" }),
      ).toBeVisible();
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
    ["#/presets/missing", "找不到该预设。"],
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
