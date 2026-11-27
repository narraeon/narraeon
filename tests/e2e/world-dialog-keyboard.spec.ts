import { expect, type Locator, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";
import {
  rawControlFile,
  selectControlFile,
  worldRulesPath,
} from "../support/worldControlEditor.ts";

test.use({ runtimeScope: "world-dialog-keyboard" });

test.beforeEach(async ({ page }) => {
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Keyboard fixture",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "keyboard-fixture",
      modelId: "keyboard-fixture",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  const content = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const created = await runtime<{ world: { worldId: string } }>(page, {
    type: "world.create",
    operationId: crypto.randomUUID(),
    packageId: content.localId,
    model: {
      provider: "chat_completions",
      modelId: "keyboard-fixture",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    },
  });
  await page.goto(`/#/world/${created.world.worldId}`);
  await expect(page.getByLabel("故事时间线")).toBeVisible();
});

test("AI 读取键盘焦点在弹窗内循环，关闭后回到侧栏入口", async ({
  page,
  browserName,
}) => {
  const { activate, tab } = keyboard(page, browserName);
  const toolbar = page.getByRole("navigation", { name: "世界阅读工具" });
  await activate(toolbar.getByRole("button", { name: "AI 读取" }));
  const opener = page.getByRole("button", { name: "展开完整读取记录" });
  await activate(opener);

  const dialog = page.getByRole("dialog", { name: "AI 如何读取" });
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
  await expect(close).toHaveCSS("outline-style", "solid");
  await tab(true);
  await expect(dialog.getByText("查看下次编译材料：全新上下文")).toBeFocused();
  await tab();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(close).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(close).toBeFocused();
  expect(await androidBack(page)).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("世界管理键盘焦点循环，Escape 保留未保存编辑并回到顶部入口", async ({
  page,
  browserName,
}) => {
  const { activate, tab } = keyboard(page, browserName);
  const toolbar = page.getByRole("navigation", { name: "世界阅读工具" });
  const opener = toolbar.getByRole("button", { name: "世界管理" });
  await activate(opener);

  const dialog = page.getByRole("dialog", { name: "世界管理" });
  const close = dialog.getByRole("button", { name: "关闭", exact: true });
  const runtimeDetails = dialog
    .locator("summary")
    .filter({ hasText: /^运行详情$/u });
  await expect(close).toBeFocused();
  await expect(close).toBeInViewport();
  await expect(close).toHaveCSS("outline-style", "solid");
  await tab(true);
  await expect(runtimeDetails).toBeFocused();
  await page.keyboard.press("Enter");
  await tab();
  const rawRuntime = dialog.getByText("查看 Runtime 原始诊断", { exact: true });
  await expect(rawRuntime).toBeFocused();
  await tab();
  await expect(close).toBeFocused();
  await tab(true);
  await expect(rawRuntime).toBeFocused();

  await activate(dialog.getByText("世界控制 · 高级编辑"));
  await selectControlFile(dialog, worldRulesPath);
  const editor = rawControlFile(dialog, worldRulesPath);
  await editor.fill("未保存的控制草稿");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Enter");
  await activate(dialog.getByText("世界控制 · 高级编辑"));
  await selectControlFile(dialog, worldRulesPath);
  await expect(editor).toHaveValue("未保存的控制草稿");
});

test("世界管理从侧栏打开，关闭按钮和 Android 返回都恢复入口焦点", async ({
  page,
  browserName,
}) => {
  const { activate } = keyboard(page, browserName);
  await page.setViewportSize({ width: 390, height: 844 });
  const toolbar = page.getByRole("navigation", { name: "世界阅读工具" });
  await activate(toolbar.getByRole("button", { name: "世界", exact: true }));
  const rail = page.getByRole("complementary", { name: "当前世界" });
  const opener = rail.getByRole("button", { name: "世界管理" });
  const dialog = page.getByRole("dialog", { name: "世界管理" });
  const close = dialog.getByRole("button", { name: "关闭", exact: true });

  await activate(opener);
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  await activate(opener);
  expect(await androidBack(page)).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(rail).toBeVisible();
  await expect(opener).toBeFocused();
  expect(await androidBack(page)).toBe(true);
  await expect(rail).toBeHidden();
});

function androidBack(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() =>
    (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack?.(),
  );
}

function keyboard(page: Page, browserName: string) {
  // On macOS, WebKit's default Tab skips buttons. Option+Tab visits them.
  const modifier =
    browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  const tab = (backward = false) =>
    page.keyboard.press(modifier + (backward ? "Shift+Tab" : "Tab"));

  async function activate(target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    for (let step = 0; step < 40; step++) {
      if (
        await target.evaluate((element) => element === document.activeElement)
      )
        break;
      await tab();
    }
    await expect(target).toBeFocused();
    await page.keyboard.press("Enter");
  }

  return { activate, tab };
}

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
