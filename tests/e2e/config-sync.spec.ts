import { expect, type Page, type Route } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { AppPreferences } from "../../src/protocol/appPreferences.ts";
import type {
  FileNativePlayPresetView,
  FileNativePlayPresetLibrary as PlayPresetScreenLibrary,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
interface PlayPresetReceipt {
  currentPresetId: string;
  preset: FileNativePlayPresetView;
}
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "config-sync" });

test.beforeEach(async ({ page }) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "同步测试模型",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "fixture-secret",
      modelId: "fixture-model",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
});

test("preset conflict preserves edits and rejection while a bounded offline read can be recovered manually", async ({
  page,
}) => {
  const created = await runtime<PlayPresetReceipt>(page, {
    type: "play.create",
    name: "冲突原始编排方案",
  });
  let writes = 0;
  let reads = 0;
  let offline = true;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "play.save") {
      writes++;
      await runtime(page, {
        type: "play.save",
        presetId: created.preset.id,
        name: "其他页面的新名称",
        files: created.preset.files,
      });
      await route.fulfill({
        status: 409,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "preset_conflict",
            message: "编排方案版本冲突，请核对最新编排方案后再保存。",
          },
        },
      });
    } else if (request.type === "play.read") {
      reads++;
      if (offline) await route.abort("failed");
      else await route.continue();
    } else await route.continue();
  });
  await page.goto(`/#/orchestrations/${created.preset.id}`);
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u })
    .click();
  await page.getByLabel("编排方案名称", { exact: true }).fill("我的名称草稿");
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  await page.getByLabel("提示词正文", { exact: true }).fill("保留我的正文编辑");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("暂时无法同步", { exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await expect(page.getByLabel("编排方案名称", { exact: true })).toHaveValue(
    "我的名称草稿",
  );
  offline = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "其他页面的新名称", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel("编排方案名称", { exact: true })).toHaveValue(
    "我的名称草稿",
  );
  await expect(
    page.getByText("编排方案版本冲突，请核对最新编排方案后再保存。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("暂时无法同步", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  expect(reads).toBe(2);
  await expect(page.getByLabel("提示词正文", { exact: true })).toHaveValue(
    "保留我的正文编辑",
  );
});

test("model save and delete lost receipts reconcile the library once, and endpoint tests never replay", async ({
  page,
}) => {
  let saves = 0;
  let tests = 0;
  let deletes = 0;
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "model.save" || request.type === "model.delete") {
      if (request.type === "model.save") saves++;
      else deletes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else if (request.type === "model.models") {
      tests++;
      await route.fulfill({
        status: 502,
        json: {
          protocol: "narraeon.runtime/v1",
          error: {
            code: "provider_error",
            message: "端点拒绝连接测试，请检查连接地址。",
          },
        },
      });
    } else {
      if (request.type === "model.read") reads++;
      await route.continue();
    }
  });
  await page.goto("/#/models");
  await page.getByLabel("配置名称").fill("后端已保存但回包丢失");
  await page.getByRole("button", { name: "保存模型连接并启用" }).click();
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "后端已保存但回包丢失",
  );
  await expect(page.getByLabel("配置名称")).toHaveValue("后端已保存但回包丢失");
  await page.getByRole("button", { name: "从端点拉取模型" }).click();
  await expect(
    page.getByText("端点拒绝连接测试，请检查连接地址。", { exact: true }),
  ).toBeVisible();
  expect(saves).toBe(1);
  expect(tests).toBe(1);
  expect(reads).toBe(2);
  const current = await runtime<{ activeConnectionId: string }>(page, {
    type: "model.read",
  });
  const copied = await runtime<{ copiedConnectionId: string }>(page, {
    type: "model.copy",
    connectionId: current.activeConnectionId,
    name: "另一个当前模型",
  });
  await runtime(page, {
    type: "model.select",
    connectionId: copied.copiedConnectionId,
  });
  // A clean editor must stop pointing at a deleted record after readback.
  await page.reload();
  const oldCard = page.locator(".config-card").filter({
    has: page.getByRole("heading", {
      name: "后端已保存但回包丢失",
      exact: true,
    }),
  });
  await oldCard.getByRole("button", { name: "编辑", exact: true }).click();
  await oldCard.getByRole("button", { name: "删除", exact: true }).click();
  const confirm = page.getByRole("dialog", {
    name: /删除模型连接“后端已保存但回包丢失”/,
  });
  await expect(confirm).toBeVisible();
  expect(deletes).toBe(0);
  await confirm.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByLabel("配置名称")).toHaveValue("默认模型");
  expect(deletes).toBe(1);
  expect(reads).toBe(3);
});

test("portable preset import and export lost results only read the library and never repeat the one-time action", async ({
  page,
}) => {
  const library = await runtime<PlayPresetScreenLibrary>(page, {
    type: "play.read",
  });
  const exported = await runtime<{
    files: { path: string; contents: string }[];
  }>(page, { type: "play.export", presetId: library.currentPresetId });
  let imports = 0;
  let exports = 0;
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "play.import" || request.type === "play.export") {
      if (request.type === "play.import") imports++;
      else exports++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else {
      if (request.type === "play.read") reads++;
      await route.continue();
    }
  });
  await page.goto("/#/orchestrations");
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案管理$/u })
    .click();
  await page.getByLabel("选择要导入的编排方案", { exact: true }).setInputFiles({
    name: "丢包的独立编排方案.orchestration.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported.files)),
  });
  await expect(
    page.getByRole("option", { name: "丢包的独立编排方案", exact: true }),
  ).toHaveCount(1);
  await expect(page.getByLabel("切换编排方案")).toHaveValue(
    library.currentPresetId,
  );
  expect(imports).toBe(1);
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u })
    .click();
  await page.getByRole("button", { name: "导出编排方案", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  expect(exports).toBe(1);
  expect(
    (await runtime<PlayPresetScreenLibrary>(page, { type: "play.read" }))
      .presets,
  ).toHaveLength(library.presets.length + 1);
});

test("preset enabled and script flags and selection reconcile lost receipts", async ({
  page,
}) => {
  const created = await runtime<PlayPresetReceipt>(page, {
    type: "play.create",
    name: "同步启停编排方案",
  });
  const writes: string[] = [];
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (
      request.type === "play.scripts" ||
      request.type === "play.enable" ||
      request.type === "play.select"
    ) {
      writes.push(request.type);
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    if (request.type === "play.read") reads++;
    await route.continue();
  });
  await page.goto(`/#/orchestrations/${created.preset.id}`);
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u })
    .click();
  await page
    .getByRole("button", {
      name: created.preset.scriptsEnabled
        ? "停用 JavaScript"
        : "启用 JavaScript（本地可信代码）",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: created.preset.scriptsEnabled
        ? "启用 JavaScript（本地可信代码）"
        : "停用 JavaScript",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "停用编排方案", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "启用编排方案", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "启用编排方案", exact: true }).click();
  await page
    .getByRole("button", { name: "应用为当前编排方案", exact: true })
    .click();
  await expect(page.locator(".play-preset-header-fact strong")).toHaveText(
    "同步启停编排方案",
  );
  expect(writes).toEqual([
    "play.scripts",
    "play.enable",
    "play.enable",
    "play.select",
  ]);
  expect(reads).toBe(4);
});

test("draft output and interface preview have independent bounded reads and keep local input", async ({
  page,
}) => {
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
  const world = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: "config-preview-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "fixture-model",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
  const created = await runtime<PlayPresetReceipt>(page, {
    type: "play.create",
    name: "当前草稿预览",
  });
  let offline = true;
  let writes = 0;
  const readCounts = new Map<string, number>();
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "play.workbench.read") {
      const key = JSON.stringify(request);
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
      if (offline) return route.abort("failed");
    }
    if (request.type === "play.save" || request.type === "play.chain.start")
      writes++;
    await route.continue();
  });
  await page.goto(`/#/orchestrations/${created.preset.id}`);
  await page.getByRole("button", { name: "新增后置请求", exact: true }).click();
  await page.getByRole("button", { name: "界面产物", exact: true }).click();
  await page.getByText("游玩效果预览 · 就地展开", { exact: true }).click();
  const output = page
    .locator(".preset-draft-preview")
    .filter({ hasText: "游玩效果预览 · 就地展开" });
  await output.getByLabel("本页输入草稿（尚未发送）").fill("保留当前样例输入");
  await expect(output.getByText("暂时无法同步", { exact: true })).toBeVisible();
  expect([...readCounts.values()].every((count) => count <= 2)).toBe(true);
  offline = false;
  await output.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(output.getByText("暂时无法同步", { exact: true })).toHaveCount(
    0,
  );
  await expect(output.getByLabel("本页输入草稿（尚未发送）")).toHaveValue(
    "保留当前样例输入",
  );
  await page.getByRole("button", { name: "新增纯界面", exact: true }).click();
  const panel = page.getByRole("region", { name: "纯界面预览", exact: true });
  await panel
    .getByLabel("预览世界", { exact: true })
    .selectOption(world.world.worldId);
  offline = true;
  await panel.getByRole("button", { name: "预览界面", exact: true }).click();
  await expect(panel.getByText("暂时无法同步", { exact: true })).toBeVisible();
  offline = false;
  await panel.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(panel.getByText("暂时无法同步", { exact: true })).toHaveCount(0);
  await expect(page.getByText("草稿尚未保存", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
});

for (const embedded of [false, true])
  test(`prompt preview rejects old input and offers bounded read recovery (${embedded ? "embedded" : "standalone"})`, async ({
    page,
  }) => {
    await runtime(page, { type: "content.create-sample", locale: "zh-CN" });
    let reads = 0;
    let offline = false;
    let release!: () => void;
    const held = Promise.withResolvers<void>();
    await page.route("**/api/runtime/v1", async (route) => {
      if (input(route).type !== "prompt.preview") return route.continue();
      reads++;
      if (reads === 1) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        held.resolve();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return route.fulfill({ response });
      }
      if (offline) await route.abort("failed");
      else await route.continue();
    });
    await page.goto(embedded ? "/#/orchestrations" : "/#/preview");
    if (embedded)
      await page
        .locator("summary")
        .filter({ hasText: /^发送给 AI 的内容预览$/u })
        .click();
    const preview = page.locator(".prompt-preview-screen");
    await preview
      .getByRole("button", { name: "生成真实预览", exact: true })
      .click();
    await held.promise;
    await preview
      .getByLabel("预览玩家输入")
      .fill("保留当前预览输入，不采用旧回包。");
    release();
    await expect(
      preview.getByRole("heading", { name: "编译通过", exact: true }),
    ).toHaveCount(0);
    offline = true;
    await preview
      .getByRole("button", { name: "生成真实预览", exact: true })
      .click();
    await expect(
      preview.getByText("暂时无法同步", { exact: true }),
    ).toBeVisible();
    expect(reads).toBe(3);
    offline = false;
    await preview
      .getByRole("button", { name: "重新加载", exact: true })
      .click();
    await expect(
      preview.getByRole("heading", { name: "编译通过", exact: true }),
    ).toBeVisible();
    await expect(preview.getByLabel("预览玩家输入")).toHaveValue(
      "保留当前预览输入，不采用旧回包。",
    );
    expect(reads).toBe(4);
  });

test("SillyTavern inspection can recover in its dialog and a lost import response retains the source without replay", async ({
  page,
}) => {
  const before = await runtime<PlayPresetScreenLibrary>(page, {
    type: "play.read",
  });
  let inspections = 0;
  let imports = 0;
  let libraryReads = 0;
  let libraryOffline = true;
  let offline = true;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "play.sillytavern.inspect") {
      inspections++;
      if (offline) return route.abort("failed");
    }
    if (request.type === "play.sillytavern.import") {
      imports++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    if (request.type === "play.read" && imports > 0) {
      libraryReads++;
      if (libraryOffline) return route.abort("failed");
    }
    await route.continue();
  });
  await page.goto("/#/orchestrations");
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案管理$/u })
    .click();
  const source = {
    prompts: [
      {
        identifier: "plain",
        name: "待迁移提示",
        role: "user",
        content: "保留迁移正文",
      },
    ],
    prompt_order: [
      { character_id: 100001, order: [{ identifier: "plain", enabled: true }] },
    ],
  };
  await page.getByLabel("选择 SillyTavern JSON 文件").setInputFiles({
    name: "迁移草稿.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(source)),
  });
  const dialog = page.getByRole("dialog", { name: "SillyTavern 导入向导" });
  await expect(dialog.getByText("暂时无法同步", { exact: true })).toBeVisible();
  expect(inspections).toBe(2);
  offline = false;
  await dialog.getByRole("button", { name: "重新加载" }).click();
  await dialog.getByRole("checkbox", { name: /待迁移提示/u }).check();
  await dialog.getByRole("button", { name: "转换预览", exact: true }).click();
  await dialog
    .getByRole("button", { name: "导入独立副本", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("尚无法确认");
  await expect(dialog.getByText("暂时无法同步", { exact: true })).toBeVisible();
  expect(libraryReads).toBe(1);
  libraryOffline = false;
  await dialog.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(dialog.getByText("暂时无法同步", { exact: true })).toHaveCount(
    0,
  );
  expect(libraryReads).toBe(2);
  await expect(dialog.getByLabel("新编排方案名称")).toHaveValue("迁移草稿");
  expect(imports).toBe(1);
  expect(
    (await runtime<PlayPresetScreenLibrary>(page, { type: "play.read" }))
      .presets,
  ).toHaveLength(before.presets.length + 1);
});

test("invalid SillyTavern source retains a localized diagnostic after one recovery", async ({
  page,
}) => {
  let reads = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/runtime/v1") &&
      (request.postDataJSON() as { request: V1Request }).request.type ===
        "play.sillytavern.inspect"
    )
      reads++;
  });
  await page.goto("/#/orchestrations");
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案管理$/u })
    .click();
  await page.getByLabel("选择 SillyTavern JSON 文件").setInputFiles({
    name: "无效草稿.json",
    mimeType: "application/json",
    buffer: Buffer.from("not JSON"),
  });
  const dialog = page.getByRole("dialog", { name: "SillyTavern 导入向导" });
  await expect(dialog.getByRole("alert")).toContainText("JSON 格式无效");
  expect(reads).toBe(2);
});

test("reading preferences reconcile a committed save with a lost response without calling a model", async ({
  page,
}) => {
  const package_ = await runtime<{ localId: string }>(page, {
    type: "content.create-sample",
    locale: "zh-CN",
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: "config-reading-world",
    packageId: package_.localId,
    model: {
      provider: "chat_completions",
      modelId: "fixture-model",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
    },
  });
  let writes = 0;
  let reads = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const request = input(route);
    if (request.type === "preferences.save") {
      writes++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    if (writes && request.type === "preferences.read") reads++;
    await route.continue();
  });
  await page.goto(`/#/world/${created.world.worldId}`);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("显示技术信息").check();
  await expect(page.locator(".world-reader-page")).toHaveClass(
    /is-detailed-mode/u,
  );
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByLabel("显示技术信息")).toBeChecked();
  expect(writes).toBe(1);
  expect(
    (await runtime<AppPreferences>(page, { type: "preferences.read" })).reading
      .showTechnicalInfo,
  ).toBe(true);
  const preferences = await runtime<AppPreferences>(page, {
    type: "preferences.read",
  });
  await runtime(page, {
    type: "preferences.save",
    reading: { ...preferences.reading, showTechnicalInfo: false },
  });
  await page.getByLabel("界面语言").selectOption("en");
  await expect(page.getByLabel("Interface language")).toHaveValue("en");
  await expect(page.locator(".world-reader-page")).toHaveClass(
    /is-story-mode/u,
  );
  expect(writes).toBe(2);
});

function input(route: Route): V1Request {
  return (route.request().postDataJSON() as { request: V1Request }).request;
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
