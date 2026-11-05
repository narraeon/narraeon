import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  return page.evaluate(async (request) => {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "narraeon.runtime/v1", request }),
    });
    const body = (await response.json()) as { result: T; error: unknown };
    if (!response.ok) throw new Error(JSON.stringify(body.error));
    return body.result;
  }, request);
}

const source = {
  reverse_proxy: "secret-url-should-not-appear",
  proxy_password: "secret-password-should-not-appear",
  temperature: 0.7,
  prompts: [
    {
      identifier: "plain",
      name: "Plain",
      role: "assistant",
      content: "Plain original",
    },
    {
      identifier: "macro",
      name: "Macro",
      role: "user",
      content: "Hello {{char}}",
    },
    {
      identifier: "orphan",
      name: "Orphan",
      role: "system",
      content: "Unordered original",
    },
    { identifier: "chatHistory", name: "History", marker: true },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: "orphan", enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: "plain", enabled: true },
        { identifier: "macro", enabled: true },
        { identifier: "chatHistory", enabled: true },
      ],
    },
  ],
};

for (const locale of ["zh-CN", "en"] as const)
  for (const mobile of [false, true]) {
    const text =
      locale === "en"
        ? {
            preset: "Presets",
            manage: "Manage presets",
            file: "Choose SillyTavern JSON file",
            wizard: "SillyTavern import wizard",
            preview: "Conversion preview",
            cancel: "Cancel",
            import: "Import independent copy",
            status: "SillyTavern preset imported as an independent copy",
            unordered: "Unordered prompts",
          }
        : {
            preset: "预设",
            manage: "预设管理",
            file: "选择 SillyTavern JSON 文件",
            wizard: "SillyTavern 导入向导",
            preview: "转换预览",
            cancel: "取消",
            import: "导入独立副本",
            status: "SillyTavern 预设已导入为独立副本",
            unordered: "未编排提示",
          };
    test(`SillyTavern file selection, review, cancel and import (${locale}, ${mobile ? "mobile" : "desktop"})`, async ({
      page,
    }) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      await page.goto("/");
      await page
        .locator(".workspace-locale-picker select")
        .selectOption(locale);
      if (locale === "en")
        await page.getByRole("button", { name: "Switch page" }).click();
      await page
        .getByRole("button", { name: text.preset, exact: true })
        .click();
      await page.getByText(text.manage, { exact: true }).click();
      const before = await runtime<FileNativePlayPresetLibrary>(page, {
        type: "play.read",
      });
      const choose = async () =>
        page.getByLabel(text.file).setInputFiles({
          name: "silly.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(source)),
        });
      await choose();
      const wizard = page.getByRole("dialog", { name: text.wizard });
      await expect(wizard.getByText("Plain original")).toBeVisible();
      const bounds = await wizard.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThan(mobile ? 340 : 800);
      await expect(wizard.getByText("Hello {{char}}")).toHaveCount(0);
      await wizard.getByRole("button", { name: "Macro", exact: true }).click();
      await expect(wizard.getByText("Hello {{char}}")).toBeVisible();
      await expect(wizard.getByText("Plain original")).toHaveCount(0);
      await expect(
        wizard.getByLabel("Plain", { exact: true }),
      ).not.toBeChecked();
      await expect(
        wizard.getByText(text.unordered, { exact: true }),
      ).toBeVisible();
      await wizard
        .getByRole("button", {
          name: locale === "en" ? "Settings not migrated" : "未迁移的设置",
        })
        .click();
      await expect(wizard).toContainText("$.temperature");
      await expect(wizard).toContainText("0.7");
      await expect(wizard).not.toContainText(
        "secret-password-should-not-appear",
      );
      await expect(wizard).not.toContainText("secret-url-should-not-appear");
      await wizard.getByLabel("Plain", { exact: true }).check();
      await wizard.getByRole("button", { name: "Macro", exact: true }).click();
      await wizard.getByRole("button", { name: "Plain", exact: true }).click();
      await expect(wizard.getByLabel("Plain", { exact: true })).toBeChecked();
      await wizard.getByLabel("Plain", { exact: true }).uncheck();
      await expect(wizard.getByText("Plain original")).toBeVisible();
      await wizard.getByLabel("Plain", { exact: true }).check();
      await wizard.getByLabel("Macro", { exact: true }).check();
      await wizard.getByLabel("Orphan", { exact: true }).check();
      await mkdir("/tmp/narraeon-140-evidence", { recursive: true });
      await page.screenshot({
        path: `/tmp/narraeon-140-evidence/preset-${locale}-${mobile ? "mobile" : "desktop"}-detail.png`,
      });
      await wizard
        .getByRole("button", { name: text.preview, exact: true })
        .click();
      await page.screenshot({
        path: `/tmp/narraeon-140-evidence/preset-${locale}-${mobile ? "mobile" : "desktop"}-result.png`,
      });
      await expect(
        wizard.getByText("unsupported_macro", { exact: false }),
      ).toBeVisible();
      await wizard
        .getByRole("button", { name: text.cancel, exact: true })
        .click();
      const afterCancel = await runtime<FileNativePlayPresetLibrary>(page, {
        type: "play.read",
      });
      expect(afterCancel.presets).toHaveLength(before.presets.length);
      await choose();
      await wizard.getByLabel("Plain", { exact: true }).check();
      await wizard.getByLabel("Macro", { exact: true }).check();
      await wizard.getByLabel("Orphan", { exact: true }).check();
      await wizard
        .getByRole("button", { name: text.preview, exact: true })
        .click();
      await wizard
        .getByRole("button", { name: text.import, exact: true })
        .click();
      await expect(
        page.getByRole("status").filter({ hasText: text.status }),
      ).toBeVisible();
      const after = await runtime<FileNativePlayPresetLibrary>(page, {
        type: "play.read",
      });
      expect(after.currentPresetId).toBe(before.currentPresetId);
      const imported = after.presets.find(
        (preset) => !before.presets.some((old) => old.id === preset.id),
      )!;
      expect(imported.name).toBe("silly");
      expect(imported.scriptsEnabled).toBe(false);
      expect(JSON.stringify(imported.files)).toContain("Plain original");
      expect(JSON.stringify(imported.files)).toContain("Hello {{char}}");
      expect(JSON.stringify(imported.files)).toContain("Unordered original");
      expect(JSON.stringify(imported.files)).not.toContain(
        "secret-password-should-not-appear",
      );
    });
  }
