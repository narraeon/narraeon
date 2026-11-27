import { openWorkspaceCreationTool } from "../support/workspaceNavigation.ts";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/isolatedRuntimeTest.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import type { SillyTavernSource } from "../../src/shared/sillytavern-source.ts";

test.use({ runtimeScope: "sillytavern-preset-import" });

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

test("preset wizard gives the source detail the empty variables column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await openWorkspaceCreationTool(page);
  await page.getByText("Manage orchestrations", { exact: true }).click();
  await page.getByLabel("Choose SillyTavern JSON file").setInputFiles({
    name: "variables.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        prompts: [
          source.prompts[0],
          source.prompts[1],
          {
            identifier: "declaration",
            name: "Declaration",
            role: "system",
            content: "{{setvar::weather::fog}}",
          },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "plain", enabled: true },
              { identifier: "macro", enabled: false },
              { identifier: "declaration", enabled: false },
            ],
          },
        ],
      }),
    ),
  });
  const wizard = page.getByRole("dialog", {
    name: "SillyTavern import wizard",
  });
  await expect(wizard.getByText("Plain original")).toBeVisible();
  const detail = wizard.locator(".import-browser-detail");
  const detailWidth = async () => (await detail.boundingBox())!.width;
  const emptyWidth = await detailWidth();
  await expect(wizard.getByText("No selected declarations")).toBeVisible();

  const macro = wizard.getByRole("checkbox", { name: "Macro", exact: true });
  await macro.check();
  await expect(
    wizard.getByText(
      "The scan is incomplete or contains macros it cannot parse.",
    ),
  ).toBeVisible();
  expect.soft(await detailWidth()).toBe(emptyWidth);

  const declaration = wizard.getByRole("checkbox", {
    name: "Declaration",
    exact: true,
  });
  await declaration.check();
  await expect(wizard.getByText("weather", { exact: true })).toBeVisible();
  await expect(wizard.getByText(/Uncertain candidate: fog/u)).toBeVisible();
  expect.soft(await detailWidth()).toBeLessThan(emptyWidth - 100);
  await wizard.getByRole("button", { name: "Original declaration" }).click();
  await expect(
    wizard.getByText("{{setvar::weather::fog}}", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(wizard.getByText("weather", { exact: true })).toBeVisible();
  expect(
    await wizard.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  await declaration.uncheck();
  expect.soft(await detailWidth()).toBe(emptyWidth);
  await macro.uncheck();
  await expect(
    wizard.getByText(
      "The scan is incomplete or contains macros it cannot parse.",
    ),
  ).toHaveCount(0);
});

for (const locale of ["zh-CN", "en"] as const)
  for (const mobile of [false, true]) {
    const text =
      locale === "en"
        ? {
            manage: "Manage orchestrations",
            file: "Choose SillyTavern JSON file",
            wizard: "SillyTavern import wizard",
            preview: "Conversion preview",
            cancel: "Cancel",
            import: "Import independent copy",
            status:
              "Imported an independent orchestration from the SillyTavern preset",
            unordered: "Unordered prompts",
          }
        : {
            manage: "编排方案管理",
            file: "选择 SillyTavern JSON 文件",
            wizard: "SillyTavern 导入向导",
            preview: "转换预览",
            cancel: "取消",
            import: "导入独立副本",
            status: "已从 SillyTavern 预设导入独立编排方案",
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
      await openWorkspaceCreationTool(page);
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
      ).toBeChecked();
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
        .getByLabel(
          locale === "en" ? "New orchestration name" : "新编排方案名称",
        )
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
      expect(imported.files["orchestration.yaml"]).toContain(
        "narraeon.orchestration/v1",
      );
      expect(imported.files["preset.yaml"]).toBeUndefined();
      expect(JSON.stringify(imported.files)).toContain("Plain original");
      expect(JSON.stringify(imported.files)).toContain("Hello {{char}}");
      expect(JSON.stringify(imported.files)).toContain("Unordered original");
      expect(JSON.stringify(imported.files)).not.toContain(
        "secret-password-should-not-appear",
      );
    });
  }

test("switching order groups replaces defaults and clears a previous conversion", async ({
  page,
}) => {
  await page.goto("/#/orchestrations");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await page.getByText("Manage orchestrations", { exact: true }).click();
  await page.getByLabel("Choose SillyTavern JSON file").setInputFiles({
    name: "order-test.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(source)),
  });
  const wizard = page.getByRole("dialog", {
    name: "SillyTavern import wizard",
  });
  const checkbox = (name: string) =>
    wizard.getByRole("checkbox", { name, exact: true });
  const group = wizard.getByLabel("Source order group");
  const convert = wizard.getByRole("button", {
    name: "Conversion preview",
    exact: true,
  });
  const importCopy = wizard.getByRole("button", {
    name: "Import independent copy",
    exact: true,
  });
  await expect(group).toHaveValue("100001");
  await expect(checkbox("Plain")).toBeChecked();
  await expect(checkbox("Orphan")).not.toBeChecked();
  await convert.click();
  await expect(importCopy).toBeVisible();
  await group.selectOption("100000");
  await expect(importCopy).toHaveCount(0);
  await expect(checkbox("Plain")).not.toBeChecked();
  await expect(checkbox("Orphan")).toBeChecked();
  await group.selectOption("100001");
  await expect(checkbox("Plain")).toBeChecked();
  await expect(checkbox("Orphan")).not.toBeChecked();
  await wizard
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(wizard.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await wizard
    .getByRole("button", { name: "Select enabled source prompts", exact: true })
    .click();
  await expect(wizard.getByRole("checkbox", { checked: true })).toHaveCount(4);
  await checkbox("History").uncheck();
  await checkbox("Orphan").check();
  await convert.click();
  await expect(
    wizard.getByText(/Orphan — Imported user prompt — Disabled/u),
  ).toBeVisible();
  await importCopy.click();
  await expect(wizard).toHaveCount(0);
  const library = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const preset = library.presets.find(({ name }) => name === "order-test");
  expect(preset).toBeDefined();
  const provenance = await runtime<SillyTavernSource>(page, {
    type: "play.sillytavern.source.read",
    presetId: preset!.id,
  });
  expect(provenance).toMatchObject({
    kind: "snapshot",
    snapshot: { groupId: "100001" },
  });
  if (provenance.kind !== "snapshot")
    throw new Error("Expected a source snapshot");
  expect(
    provenance.snapshot.entries.map(({ id, enabled, selected, content }) => [
      id,
      enabled,
      selected,
      content,
    ]),
  ).toEqual([
    ["plain", true, true, "Plain original"],
    ["macro", true, true, "Hello {{char}}"],
    ["chatHistory", true, false, undefined],
    ["__settings", true, true, "Collision text"],
    ["orphan", undefined, true, "Unordered original"],
  ]);
  await page.reload();
  await page.getByText("SillyTavern source", { exact: true }).click();
  await expect(
    page.getByText(/History · Source enabled state Enabled · Not selected/u),
  ).toBeVisible();
  await page.getByText(/Orphan · Source enabled state/u).click();
  await expect(
    page.getByText("Unordered original", { exact: true }),
  ).toBeVisible();
});

test("Prompt Manager defaults open an editable unconnected orchestration and settings returns with the message", async ({
  page,
}) => {
  await page.goto("/#/orchestrations");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await page.getByText("Manage orchestrations", { exact: true }).click();
  const manager = {
    version: 1,
    type: "full",
    data: {
      prompts: source.prompts,
      prompt_order: [
        { identifier: "plain", enabled: true },
        { identifier: "macro", enabled: false },
        { identifier: "chatHistory", enabled: true },
      ],
    },
  };
  await page.getByLabel("Choose SillyTavern JSON file").setInputFiles({
    name: "offline-manager.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manager)),
  });
  const wizard = page.getByRole("dialog", {
    name: "SillyTavern import wizard",
  });
  const checkbox = (name: string) =>
    wizard.getByRole("checkbox", { name, exact: true });
  await expect(wizard.getByLabel("Source order group")).toHaveCount(0);
  await expect(checkbox("Plain")).toBeChecked();
  await expect(checkbox("History")).toBeChecked();
  await expect(checkbox("Macro")).not.toBeChecked();
  await expect(checkbox("Orphan")).not.toBeChecked();
  await checkbox("Macro").check();
  await wizard
    .getByRole("button", { name: "Conversion preview", exact: true })
    .click();
  await wizard
    .getByRole("button", { name: "Import and organize with AI", exact: true })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Switch orchestration", exact: true })
      .locator("option:checked"),
  ).toHaveText("offline-manager");
  const originalUrl = page.url();
  const assistant = page.getByRole("region", {
    name: "AI orchestration editing",
    exact: true,
  });
  const pending = assistant.getByLabel(
    "Message to the orchestration assistant",
  );
  const configure = assistant.getByRole("button", {
    name: "Configure model",
    exact: true,
  });
  await expect(configure).toBeVisible();
  const message =
    "Explain which of my imported prompts can be applied globally.";
  await pending.fill(message);
  await page.getByText("SillyTavern source", { exact: true }).click();
  await expect(page.getByText("manager", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add prompt", exact: true }).click();
  await page.getByLabel("Prompt name", { exact: true }).fill("Offline edit");
  await page
    .getByLabel("Prompt text", { exact: true })
    .fill("Locally edited with no connection.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Orchestration saved.", { exact: true }),
  ).toBeVisible();

  const commands: V1Request[] = [];
  const runtimeRoute = "**/api/runtime/v1";
  let rejectSave = true;
  await page.route(runtimeRoute, async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    commands.push(request);
    if (request.type !== "model.save" || !rejectSave) return route.continue();
    await route.fulfill({
      status: 400,
      json: {
        protocol: "narraeon.runtime/v1",
        error: { code: "invalid_request", message: "Fixture save rejected." },
      },
    });
  });
  const fillModel = async () => {
    await page
      .getByLabel("Configuration name", { exact: true })
      .fill("Workbench fixture");
    await page
      .getByLabel("Base URL", { exact: true })
      .fill("http://127.0.0.1:1/v1");
    await page.getByLabel("API Key", { exact: true }).fill("test-key");
    await page.getByLabel("Model ID", { exact: true }).fill("fixture-model");
    await page
      .getByRole("button", {
        name: "Save and enable model connection",
        exact: true,
      })
      .click();
  };
  await configure.click();
  await expect(page).toHaveURL(/#\/models$/u);
  await fillModel();
  await expect(
    page.getByText("Fixture save rejected.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to orchestration", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect(page).toHaveURL(originalUrl);
  await expect(pending).toHaveValue(message);
  await expect(configure).toBeVisible();
  rejectSave = false;
  await configure.click();
  await fillModel();
  await expect(page).toHaveURL(originalUrl);
  await expect(pending).toHaveValue(message);
  await expect(configure).toHaveCount(0);
  expect(
    commands.filter(({ type }) => /send|generate|chain\./u.test(type)),
  ).toEqual([]);
  const library = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const imported = library.presets.find(
    ({ name }) => name === "offline-manager",
  );
  expect(imported?.id).not.toBe(library.currentPresetId);
  expect(imported?.draft?.files["orchestration.yaml"]).toContain(
    "Locally edited with no connection.",
  );
});

for (const mobile of [false, true]) {
  test(`static variable inspection ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await openWorkspaceCreationTool(page);
    await page.getByText("编排方案管理", { exact: true }).click();
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
