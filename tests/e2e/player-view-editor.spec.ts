import { expect, type Locator } from "@playwright/test";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { createZip } from "../support/createZip.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

const playerViews = "control/player-views.yaml";
const weatherLocator = JSON.stringify({ yaml: ["background", "Weather"] });
const headingLocator = JSON.stringify({ markdown: ["Crossing"] });
const originalYAML = `# Keep the author's header
format: narraeon.player-views/v1
description: Archive notes # An unrelated field
views:
  - id: status
    title: Weather desk
    items:
      - id: weather
        label: Weather
        select:
          document: situation.weather # Preserve the legacy handle
          locator: { yaml: [background, Weather] }
      - id: broken
        label: Archived source
        select:
          document: "@gone"
          locator: { yaml: [old-field] }
  - id: spare
    title: Spare view
    items: []
`;

const weather = `$document:
  id: situation.weather
  ref: current-situation
  title: Harbor weather
  summary: Conditions at the harbor.
  aliases: []
background:
  Weather: Saved rain
`;
const almanac = `---
$document:
  id: document.almanac
  ref: almanac
  title: Almanac
  summary: Notes about the crossing.
  aliases: []
---

# Almanac

## Crossing

Under the old arch.

### Landing

Leave the boat at the far steps.

## Beyond

Do not show this neighboring section.
`;
const fixture = [
  { path: "opening.md", contents: "A boat is waiting.\n" },
  {
    path: "world/current-situation.yaml",
    contents:
      weather +
      Array.from(
        { length: 170 },
        (_, index) => "note-" + index + ": archived\n",
      ).join(""),
  },
  { path: "world/almanac.md", contents: almanac },
  {
    path: "control/frame.yaml",
    contents: `format: narraeon.world-frame/v1
bindings: { currentSituation: "@current-situation" }
instructions: []
context:
  - slot: { kind: current_situation }
  - slot: { kind: additional_materials }
`,
  },
  { path: playerViews, contents: originalYAML },
];

test.use({ runtimeScope: "player-view-editor", actionTimeout: 10_000 });

for (const locale of appLocales) {
  test(`edits and previews exact player-view sources in the file workbench (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const mobile = locale === "zh-CN";
    const label = (zh: string, en: string) => (mobile ? zh : en);
    await page.setViewportSize({
      width: mobile ? 390 : 1280,
      height: mobile ? 844 : 950,
    });
    const calls: V1Request["type"][] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/runtime/v1")
      ) {
        calls.push(
          (request.postDataJSON() as { request: V1Request }).request.type,
        );
      }
    });
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page
      .getByText(label("导入内容包 ZIP", "Import content package ZIP"), {
        exact: true,
      })
      .click();
    await page
      .getByLabel(label("内容包 ZIP 文件", "Content-package ZIP file"))
      .setInputFiles({
        name: `player-views-${locale}.zip`,
        mimeType: "application/zip",
        buffer: createZip(fixture),
      });
    await page
      .getByRole("button", {
        name: label("导入 ZIP", "Import ZIP"),
        exact: true,
      })
      .click();
    const settingTools = page.getByRole("navigation", {
      name: label("设定完善工具", "Setting-improvement tools"),
    });
    const edit = (tools: Locator) =>
      tools
        .getByRole("button", { name: label("编辑", "Edit"), exact: true })
        .click();
    await edit(settingTools);

    const content = page.getByRole("complementary", {
      name: label("内容包文件编辑", "Content-package file editing"),
    });
    async function openFile(panel: Locator, path: string): Promise<void> {
      const picker = panel.getByRole("combobox", {
        name: label("选择编辑文件", "Choose a file to edit"),
      });
      if (mobile) await picker.selectOption(path);
      else
        await panel
          .getByRole("button", {
            name: label(`打开 ${path}`, `Open ${path}`),
            exact: true,
          })
          .click();
    }

    const editor = (panel: Locator) =>
      panel.getByRole("region", {
        name: label("玩家视图编辑", "Player view editor"),
        exact: true,
      });
    const preview = (panel: Locator) =>
      panel.getByRole("region", {
        name: label("玩家视图草稿预览", "Player view draft preview"),
      });
    const source = (panel: Locator, path: string) =>
      panel.getByRole("textbox", {
        name: label(`编辑 ${path}`, `Edit ${path}`),
        exact: true,
      });
    const button = (panel: Locator, zh: string, en: string) =>
      panel.getByRole("button", {
        name: label(zh, en),
        exact: true,
      });
    const items = (panel: Locator) =>
      panel
        .getByRole("list", {
          name: label("显示项", "Display items"),
        })
        .getByRole("listitem");
    const displayLabels = (panel: Locator) =>
      panel.getByRole("textbox", {
        name: label("显示名称", "Display label"),
      });
    const viewName = (panel: Locator) =>
      panel.getByRole("textbox", {
        name: label("视图名称", "View name"),
      });
    const picker = (panel: Locator) =>
      panel.getByRole("group", {
        name: label("选择玩家视图", "Select player view"),
      });
    const scope = (item: Locator) =>
      item.getByRole("combobox", {
        name: label("显示范围", "Show"),
      });
    const document = (item: Locator) =>
      item.getByRole("combobox", {
        name: label("来源文档", "Source document"),
      });

    await openFile(content, playerViews);
    await expect(preview(content)).toContainText("Saved rain");
    const editorBounds = await viewName(editor(content)).boundingBox();
    const previewBounds = await preview(content).boundingBox();
    expect(editorBounds).not.toBeNull();
    expect(previewBounds).not.toBeNull();
    if (mobile) {
      expect(previewBounds!.y).toBeGreaterThan(
        editorBounds!.y + editorBounds!.height,
      );
      await expect
        .poll(async () => {
          const bounds = await preview(content).boundingBox();
          return bounds === null ? Infinity : bounds.x + bounds.width;
        })
        .toBeLessThanOrEqual(390);
    } else {
      expect(previewBounds!.x).toBeGreaterThan(
        editorBounds!.x + editorBounds!.width,
      );
    }

    const beforeDraft = calls.length;
    const weatherPath = "world/current-situation.yaml";
    await openFile(content, weatherPath);
    const contentWeather = source(content, weatherPath);
    await contentWeather.fill(
      (await contentWeather.inputValue()).replace("Saved rain", "Draft snow"),
    );
    await openFile(content, playerViews);
    const form = editor(content);
    await expect(preview(content)).toContainText("Draft snow");
    await expect(
      scope(items(form).first()).locator("option:checked"),
    ).toContainText("Draft snow");
    await expect(
      document(items(form).nth(1)).locator("option:checked"),
    ).toContainText("@gone");
    await expect(
      scope(items(form).nth(1)).locator("option:checked"),
    ).toContainText("old-field");
    await expect(items(form).nth(1)).toContainText(
      label(
        "找不到此项的来源。请选择其他文档或节点。",
        "This item's source could not be found. Choose another document or node.",
      ),
    );

    // Picking a document keeps the author's previous selector until a scope is chosen.
    await document(items(form).nth(1)).selectOption("@almanac");
    await expect(
      scope(items(form).nth(1)).locator("option:checked"),
    ).toContainText("old-field");
    await scope(items(form).nth(1)).selectOption(headingLocator);
    await displayLabels(form).nth(1).fill("Crossing note");
    await expect(preview(content)).toContainText("Under the old arch.");
    await expect(preview(content)).toContainText(
      "Leave the boat at the far steps.",
    );
    await expect(preview(content)).not.toContainText("neighboring section");
    await button(items(form).nth(1), "上移", "Move up").click();
    await expect(displayLabels(form).first()).toHaveValue("Crossing note");

    await button(form, "新增显示项", "Add display item").click();
    await document(items(form).last()).selectOption("@current-situation");
    const largeScope = scope(items(form).last());
    await expect(largeScope.locator("option")).toHaveCount(1);
    await largeScope.focus();
    await expect(largeScope.locator("option")).toHaveCount(173);
    await largeScope.selectOption(weatherLocator);
    await expect(
      preview(content).getByText("Draft snow", { exact: true }),
    ).toHaveCount(2);
    await button(
      items(form).last(),
      "移除显示项",
      "Remove display item",
    ).click();
    await expect(items(form)).toHaveCount(2);

    await button(form, "新增视图", "Add view").click();
    await viewName(form).fill("Temporary view");
    await button(form, "上移", "Move up").click();
    await expect(picker(form).getByRole("button").nth(1)).toHaveText(
      "Temporary view",
    );
    await button(form, "移除视图", "Remove view").click();
    await button(picker(form), "Weather desk", "Weather desk").click();
    await viewName(form).fill("Harbor board");
    await expect(
      preview(content).getByRole("heading", { name: "Harbor board" }),
    ).toBeVisible();

    await button(form, "源码", "Source").click();
    const yaml = source(form, playerViews);
    const edited = await yaml.inputValue();
    for (const text of [
      "# Keep the author's header",
      "description: Archive notes # An unrelated field",
      "document: situation.weather # Preserve the legacy handle",
    ])
      expect(edited).toContain(text);
    const invalid =
      "format: narraeon.player-views/v1\nviews: [ # keep broken source\n";
    await yaml.fill(invalid);
    await expect(yaml).toHaveValue(invalid);
    await expect(button(form, "表单", "Form")).toBeDisabled();
    await yaml.fill(edited);
    await expect(yaml).toHaveValue(edited);
    await button(form, "表单", "Form").click();
    await expect(preview(content)).toContainText("Draft snow");
    expect(
      calls
        .slice(beforeDraft)
        .filter((type) =>
          /files\.replace$|^content\.replace$|\.(?:message|apply|start|append)$/u.test(
            type,
          ),
        ),
    ).toEqual([]);

    await button(content, "整批保存", "Save all changes").click();
    await expect(
      content.getByText(label("当前树已保存", "Current tree saved")),
    ).toBeVisible();
    await page.reload();
    await edit(settingTools);
    await openFile(content, playerViews);
    await expect(viewName(editor(content))).toHaveValue("Harbor board");
    await expect(preview(content)).toContainText("Draft snow");
    await button(content, "收起文件面板", "Close file panel").click();
    await button(settingTools, "创建世界", "Create world").click();

    const action = page.getByLabel(label("你的行动", "Your action"));
    await expect(action).toBeVisible();
    // Applying a revision requires an enabled connection in the existing workflow.
    // This endpoint is deliberately unreachable, and no model call is needed.
    const configure = {
      type: "model.save",
      connection: {
        name: "Player-view editor fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "player-view-test",
        modelId: "player-view-test",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    } satisfies V1Request;
    const configured = await page.request.post(
      new URL("/api/runtime/v1", page.url()).href,
      {
        data: { protocol: "narraeon.runtime/v1", request: configure },
      },
    );
    expect(configured.ok()).toBe(true);
    await page.reload();
    await button(page.locator("body"), "世界", "Worlds").click();
    await button(
      page.locator("body"),
      "修订当前世界",
      "Revise current world",
    ).click();
    const revisionTools = page.getByRole("navigation", {
      name: label("世界修订工具", "World-revision tools"),
    });
    await edit(revisionTools);
    const revision = page.getByRole("complementary", {
      name: label("世界修订文件编辑", "Edit world-revision files"),
    });
    await openFile(revision, playerViews);
    await expect(preview(revision)).toContainText("Draft snow");
    const beforeRevisionDraft = calls.length;
    const statePath = "state/current-situation.yaml";
    await openFile(revision, statePath);
    const stateWeather = source(revision, statePath);
    await stateWeather.fill(
      (await stateWeather.inputValue()).replace("Draft snow", "Revision mist"),
    );
    await openFile(revision, playerViews);
    const revisionForm = editor(revision);
    await displayLabels(revisionForm).nth(1).fill("Revised weather");
    await expect(preview(revision)).toContainText("Revision mist");
    await expect(preview(revision)).toContainText("Revised weather");
    expect(
      calls
        .slice(beforeRevisionDraft)
        .filter((type) =>
          /files\.replace$|\.(?:message|apply|start|append)$/u.test(type),
        ),
    ).toEqual([]);

    await button(revision, "保存到修订", "Save to revision").click();
    await expect(
      revision.getByText(label("修订工作树已保存", "Revision worktree saved")),
    ).toBeVisible();
    await button(revision, "收起文件面板", "Close file panel").click();
    await button(
      page.locator("body"),
      "应用并解锁",
      "Apply and unlock",
    ).click();
    await expect(page.locator(".world-feedback.status")).toContainText(
      label(
        "世界修订已应用并解锁",
        "The world revision was applied and unlocked.",
      ),
    );
    expect(
      calls.filter((type) => /\.(?:message|start|append)$/u.test(type)),
    ).toEqual([]);
  });
}
