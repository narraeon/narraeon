import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { createZip } from "../support/createZip.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "home-model-status" });

test("home and library keep their current connection and content-package status clear in both languages", async ({
  page,
}) => {
  for (const locale of ["en", "zh-CN"] as const) {
    const en = locale === "en";
    await runtime(page, { type: "preferences.save", locale });
    await page.goto("/#/");
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: en ? "Model settings" : "模型设置",
        exact: true,
      }),
    ).toHaveAccessibleDescription(en ? "Not configured" : "尚未配置");
    await expect(
      page.getByRole("button", {
        name: en ? "Configure model connection" : "配置模型连接",
      }),
    ).toBeVisible();
    await page.goto("/#/library");
    await expect(
      page.getByRole("button", {
        name: en ? "Choose a story to play" : "挑一个故事开玩",
      }),
    ).toBeVisible();
  }

  const pack = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  await runtime(page, {
    type: "content.rename",
    packageId: pack.localId,
    name: "Ready fixture",
  });
  const archive = createZip([{ path: "opening.md", contents: "Opening.\n" }]);
  await runtime(page, {
    type: "content.import",
    title: "Repair fixture",
    archiveBase64: archive.toString("base64"),
  });
  for (const name of ["Local east", "Local west"]) {
    await runtime(page, {
      type: "model.save",
      connection: {
        name,
        presetId: "custom",
        provider: "chat_completions",
        authMode: "none",
        baseUrl: "http://127.0.0.1:9/v1",
        modelId: "fixture-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 4_096,
      },
    });
  }

  for (const locale of ["en", "zh-CN"] as const) {
    const en = locale === "en";
    const current = en ? "Local west" : "Local east";
    const next = en ? "Local east" : "Local west";
    await runtime(page, { type: "preferences.save", locale });
    await page.setViewportSize({
      width: en ? 1440 : 390,
      height: 860,
    });
    await page.reload();
    const settings = page.getByRole("button", {
      name: en ? "Model settings" : "模型设置",
      exact: true,
    });
    const visibleName = settings.getByText(current, { exact: true });
    await expect(visibleName).toBeInViewport();
    await expect(settings).toHaveAccessibleDescription(
      en ? `Current connection: ${current}` : `当前连接：${current}`,
    );

    for (const route of ["/#/", "/#/library"]) {
      await page.goto(route);
      const ready = page.getByRole("button", {
        name: en
          ? "Open content package: Ready fixture"
          : "打开内容包：Ready fixture",
        exact: true,
      });
      const repair = page.getByRole("button", {
        name: en
          ? "Open content package: Repair fixture"
          : "打开内容包：Repair fixture",
        exact: true,
      });
      const gameplay = en ? "Interactive fiction" : "互动式小说";
      await expect(ready).toHaveText(`Ready fixture${gameplay}`);
      await expect(ready).toHaveAccessibleDescription(gameplay);
      await expect(repair).toContainText(en ? "Needs repair" : "待修复");
      await expect(repair).toHaveAccessibleDescription(
        en ? /Open and fix issues/u : /打开并修复/u,
      );
      const footer = page.getByLabel(en ? "Workspace status" : "工作区状态");
      await expect(footer).not.toContainText(current);
      await expect(footer).toContainText(
        en ? "Current orchestration" : "当前编排方案",
      );
      await expect(footer).toContainText(
        en ? "Usable content packages · 1" : "可用内容包 · 1",
      );
      await expect
        .soft(footer)
        .toContainText(en ? "· 1 needs repair" : "· 1 份待修复", {
          timeout: 1500,
        });
    }

    const quickSwitch = page.getByRole("button", {
      name: en ? "Quick switch model connection" : "快速切换模型连接",
    });
    await quickSwitch.click();
    const item = page.getByRole("menuitemradio", {
      name: new RegExp(next, "u"),
    });
    await item.click();
    await expect(quickSwitch).toBeFocused();
    await expect(settings).toHaveAccessibleDescription(
      en ? `Current connection: ${next}` : `当前连接：${next}`,
    );
    await expect(page).toHaveURL(/#\/library$/u);
  }

  await runtime(page, {
    type: "content.import",
    title: "Second repair fixture",
    archiveBase64: archive.toString("base64"),
  });
  await page.getByRole("combobox", { name: "界面语言" }).selectOption("en");
  await expect(page.getByLabel("Workspace status")).toContainText(
    "· 2 need repair",
  );
});

test("the header keeps the current underline during pointer and keyboard navigation", async ({
  browserName,
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/");
  const header = page.getByRole("navigation", { name: "Workspace navigation" });
  const worlds = header.getByRole("button", { name: "My worlds" });
  const library = header.getByRole("button", { name: "Content library" });
  const settings = header.getByRole("button", { name: "Model settings" });
  const activeColor = "rgb(207, 190, 160)";
  await expect(worlds).toHaveCSS("border-bottom-color", activeColor);
  await worlds.hover();
  await expect.soft(worlds).toHaveCSS("border-bottom-color", activeColor, {
    timeout: 1500,
  });
  await library.hover();
  await expect(library).toHaveCSS("background-color", "rgb(55, 61, 62)");
  await expect(library).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await page.mouse.move(500, 250);
  await worlds.focus();
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(library).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/library$/u);
  await expect(library).toBeFocused();
  await expect
    .soft(library)
    .toHaveCSS("border-bottom-color", activeColor, { timeout: 1500 });
  const navigationBottom = await library.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  await library.hover();
  await expect
    .soft(library)
    .toHaveCSS("border-bottom-color", activeColor, { timeout: 1500 });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await settings.click();
    await expect(settings).toHaveAttribute("aria-current", "page");
    await settings.hover();
    await expect
      .soft(settings)
      .toHaveCSS("border-bottom-color", activeColor, { timeout: 1500 });
    await expect
      .soft(settings)
      .toHaveCSS("border-bottom-width", "2px", { timeout: 1500 });
    await expect
      .soft(settings)
      .toHaveCSS("border-bottom-left-radius", "0px", { timeout: 1500 });
    const bottom = await settings.evaluate(
      (element) => element.getBoundingClientRect().bottom,
    );
    expect.soft(bottom).toBe(navigationBottom);
    expect
      .soft(bottom)
      .toBe(
        await page
          .locator(".workspace-header")
          .evaluate((element) => element.getBoundingClientRect().bottom),
      );
  }
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
