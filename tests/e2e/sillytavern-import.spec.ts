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
    {
      identifier: "__settings",
      name: "Collision prompt",
      role: "user",
      content: "Collision text",
    },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: "orphan", enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: "plain", enabled: true },
        { identifier: "macro", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "__settings", enabled: true },
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
      if (mobile)
        await page
          .getByRole("button", {
            name: locale === "en" ? "Switch page" : "切换页面",
          })
          .click();
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

      await page.screenshot({
        path: test
          .info()
          .outputPath(`${locale}-${mobile ? "mobile" : "desktop"}.png`),
      });
      const bounds = await wizard.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width).toBeGreaterThan(mobile ? 340 : 800);
      await expect(wizard.getByText("Hello {{char}}")).toHaveCount(0);
      await wizard.getByRole("button", { name: "Macro", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(wizard.getByText("Hello {{char}}")).toBeVisible();
      await expect(wizard.getByText("Plain original")).toHaveCount(0);
      await expect(
        wizard.getByRole("checkbox", { name: "Plain", exact: true }),
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
      await wizard
        .getByRole("button", { name: "Collision prompt", exact: true })
        .click();
      await expect(wizard.getByText("Collision text")).toBeVisible();
      await expect(wizard.getByText("$.temperature")).toHaveCount(0);
      await wizard
        .getByRole("button", {
          name: locale === "en" ? "Settings not migrated" : "未迁移的设置",
        })
        .click();
      await expect(wizard).toContainText("0.7");
      await expect(wizard).not.toContainText(
        "secret-password-should-not-appear",
      );
      await expect(wizard).not.toContainText("secret-url-should-not-appear");
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .check();
      await wizard.getByRole("button", { name: "Macro", exact: true }).click();
      await wizard.getByRole("button", { name: "Plain", exact: true }).click();
      await expect(
        wizard.getByRole("checkbox", { name: "Plain", exact: true }),
      ).toBeChecked();
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .uncheck();
      await expect(wizard.getByText("Plain original")).toBeVisible();
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .check();
      await wizard
        .getByRole("checkbox", { name: "Macro", exact: true })
        .check();
      await wizard
        .getByRole("checkbox", { name: "Orphan", exact: true })
        .check();

      await page.screenshot({
        path: test
          .info()
          .outputPath(
            `preset-${locale}-${mobile ? "mobile" : "desktop"}-detail.png`,
          ),
      });
      await wizard
        .getByRole("button", { name: text.preview, exact: true })
        .click();
      await page.screenshot({
        path: test
          .info()
          .outputPath(
            `preset-${locale}-${mobile ? "mobile" : "desktop"}-result.png`,
          ),
      });
      await expect(
        wizard.getByText("unsupported_macro", { exact: false }),
      ).toBeVisible();
      await wizard
        .getByRole("button", {
          name: locale === "en" ? "Back to source" : "返回来源",
        })
        .click();
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .uncheck();
      await expect(
        wizard.getByRole("button", { name: text.import }),
      ).toHaveCount(0);
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .check();
      await wizard
        .getByRole("button", { name: text.preview, exact: true })
        .click();
      await wizard
        .getByRole("button", {
          name: locale === "en" ? "Back to source" : "返回来源",
        })
        .click();
      await wizard
        .getByLabel(locale === "en" ? "New preset name" : "新预设名称")
        .fill("changed");
      await expect(
        wizard.getByRole("button", { name: text.import }),
      ).toHaveCount(0);
      await wizard
        .getByRole("button", { name: text.cancel, exact: true })
        .click();
      const afterCancel = await runtime<FileNativePlayPresetLibrary>(page, {
        type: "play.read",
      });
      expect(afterCancel.presets).toHaveLength(before.presets.length);
      await choose();
      await wizard
        .getByRole("checkbox", { name: "Plain", exact: true })
        .check();
      await wizard
        .getByRole("checkbox", { name: "Macro", exact: true })
        .check();
      await wizard
        .getByRole("checkbox", { name: "Orphan", exact: true })
        .check();
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

for (const mobile of [false, true]) {
  test(`static variable inspection ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    if (mobile) await page.getByRole("button", { name: "切换页面" }).click();
    await page.getByRole("button", { name: "预设", exact: true }).click();
    await page.getByText("预设管理", { exact: true }).click();
    const macroSource = {
      prompts: [
        {
          identifier: "a",
          name: "Declaration",
          role: "system",
          content: "{{setvar::mood::quiet}}",
        },
        {
          identifier: "b",
          name: "Reference",
          role: "user",
          content: "Mood: {{getvar::mood}}",
        },
      ],
      extensions: {
        tavern_helper: {
          scripts: [
            {
              type: "folder",
              name: "Folder",
              scripts: [
                {
                  type: "script",
                  name: "Embedded",
                  content: "<script>window.bad = true</script>",
                  enabled: true,
                },
                {
                  type: "script",
                  name: "Remote",
                  url: "https://example.test/a.js",
                },
              ],
            },
          ],
        },
        regex_scripts: [
          {
            scriptName: "Rule",
            findRegex: "/x/g",
            replaceString: "<b>y</b>",
            disabled: false,
          },
        ],
      },
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "a", enabled: false },
            { identifier: "b", enabled: true },
          ],
        },
      ],
    };
    await page.getByLabel("选择 SillyTavern JSON 文件").setInputFiles({
      name: "macros.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(macroSource)),
    });
    const wizard = page.getByRole("dialog", { name: "SillyTavern 导入向导" });
    await wizard
      .getByRole("button", { name: "Reference", exact: true })
      .click();
    const ref = wizard.getByRole("button", { name: "{{getvar::mood}}" });
    await ref.click();
    await expect(wizard.getByRole("tooltip")).toContainText("运行时值未知");
    await wizard.getByRole("button", { name: "Folder / Embedded" }).click();
    await expect(
      wizard.getByText("<script>window.bad = true</script>"),
    ).toBeVisible();
    await expect(
      wizard.getByRole("button", { name: "{{getvar::mood}}" }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => "bad" in window)).toBe(false);
    await page.screenshot({
      path: test
        .info()
        .outputPath(`script-${mobile ? "mobile" : "desktop"}.png`),
    });
    await wizard.getByRole("button", { name: "Folder / Remote" }).click();
    await expect(wizard.getByText(/未携带源码/)).toContainText(
      "https://example.test/a.js",
    );
    await wizard.getByRole("button", { name: "Rule", exact: true }).click();
    await expect(wizard.getByText("<b>y</b>")).toBeVisible();
    await wizard
      .getByRole("button", { name: "Reference", exact: true })
      .click();
    await wizard.getByRole("checkbox", { name: "Declaration" }).check();
    await ref.click();
    await expect(wizard.getByRole("tooltip")).toContainText("quiet");
    await expect(wizard.getByRole("tooltip")).toContainText("源停用");
    await page.screenshot({
      path: test
        .info()
        .outputPath(`variables-${mobile ? "mobile" : "desktop"}.png`),
    });
    const conversion = await runtime<unknown>(page, {
      type: "play.sillytavern.preview",
      source: JSON.stringify(macroSource),
      selected: ["a", "b"],
      groupId: "100001",
      name: "Macro preview",
    });
    expect(JSON.stringify(conversion)).not.toContain("window.bad");
    expect(JSON.stringify(conversion)).not.toContain("<b>y</b>");
    await wizard.getByRole("checkbox", { name: "Declaration" }).uncheck();
    await ref.focus();
    await expect(wizard.getByRole("tooltip")).toContainText("运行时值未知");
    await page.keyboard.press("Escape");
    await expect(wizard.getByRole("tooltip")).toHaveCount(0);
  });
}
