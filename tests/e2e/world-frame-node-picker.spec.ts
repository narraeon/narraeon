import { expect, type Locator } from "@playwright/test";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { createZip } from "../support/createZip.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

const framePath = "control/frame.yaml";
const ledgerPath = "notes/ledger.yaml";
const almanacPath = "notes/almanac.md";
const fixture = [
  { path: "opening.md", contents: "A boat is waiting.\n" },
  {
    path: "world/current-situation.yaml",
    contents: `$document:
  id: scene.harbor
  ref: current-situation
  title: Harbor
  summary: The harbor by the old gate.
  aliases: []
background: A boat is waiting.
`,
  },
  {
    path: `world/${ledgerPath}`,
    contents: `$document:
  id: ledger.harbor
  ref: ledger
  title: Ledger
  summary: Conditions at the harbor.
  aliases: []
conditions:
  weather: Saved rain
  harbor: Open
crew: [Jo, Min]
`,
  },
  {
    path: `world/${almanacPath}`,
    contents: `---
$document:
  id: notes.almanac
  ref: almanac
  title: Almanac
  summary: Notes for the crossing.
  aliases: []
---

# Almanac

## Crossing

Under the old arch.

### Landing

Use the far steps.
`,
  },
  {
    path: framePath,
    contents: `# Author frame comment
format: narraeon.world-frame/v1
bindings: { currentSituation: "@current-situation" }
instructions: []
context:
  - slot: { kind: current_situation }
  - slot: { kind: node, document: ledger.harbor, locator: { yaml: [conditions, weather] } } # Node note
  - slot: { kind: additional_materials }
`,
  },
  {
    path: "control/player-views.yaml",
    contents: "format: narraeon.player-views/v1\nviews: []\n",
  },
];

test.use({ runtimeScope: "frame-node-picker", actionTimeout: 10_000 });

for (const locale of appLocales) {
  test(`the frame node picker follows the local drafts in both workbenches (${locale})`, async ({
    page,
  }) => {
    const chinese = locale === "zh-CN";
    const width = chinese ? 390 : 1280;
    const t = (zh: string, en: string) => (chinese ? zh : en);
    const root = page.locator("body");
    await page.setViewportSize({ width, height: chinese ? 844 : 950 });
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page
      .getByText(t("导入内容包 ZIP", "Import content package ZIP"), {
        exact: true,
      })
      .click();
    await page
      .getByLabel(t("内容包 ZIP 文件", "Content-package ZIP file"))
      .setInputFiles({
        name: `frame-nodes-${locale}.zip`,
        mimeType: "application/zip",
        buffer: createZip(fixture),
      });

    const button = (scope: Locator, zh: string, en: string) =>
      scope.getByRole("button", { name: t(zh, en), exact: true });
    const openFile = async (panel: Locator, path: string) => {
      if (chinese) {
        await panel
          .getByRole("combobox", {
            name: t("选择编辑文件", "Choose a file to edit"),
          })
          .selectOption(path);
      } else {
        await button(panel, `打开 ${path}`, `Open ${path}`).click();
      }
    };
    const source = (panel: Locator, path: string) =>
      panel.getByRole("textbox", {
        name: t(`编辑 ${path}`, `Edit ${path}`),
        exact: true,
      });
    const frameForm = (panel: Locator) =>
      panel.getByRole("region", {
        name: t("世界提示框架", "World prompt frame"),
      });
    const nodePicker = (form: Locator, codec: "yaml" | "markdown") =>
      form.getByRole("combobox", {
        name:
          codec === "yaml"
            ? t("选择 YAML 节点（插槽 2）", "Choose YAML node (slot 2)")
            : t(
                "选择 Markdown 标题（插槽 2）",
                "Choose Markdown heading (slot 2)",
              ),
        exact: true,
      });
    const documentPicker = (form: Locator) =>
      form.getByRole("combobox", {
        name: t("文档 2", "Document 2"),
        exact: true,
      });
    const warning = (form: Locator) =>
      form.getByText(
        t(
          "当前路径无法解析或不唯一。请选择其他节点，或手动修正路径。",
          "The current path could not be resolved or is ambiguous. Choose another node or edit the path manually.",
        ),
        { exact: true },
      );
    const frameSource = (form: Locator) =>
      form.getByRole("textbox", {
        name: t(
          "直接编辑 control/frame.yaml",
          "Edit control/frame.yaml directly",
        ),
      });
    const sourceToggle = (form: Locator) =>
      form.getByText(t("源码视图（frame.yaml）", "Source view (frame.yaml)"), {
        exact: true,
      });
    const expectInsideViewport = async (picker: Locator) => {
      await expect
        .poll(async () => {
          const bounds = await picker.boundingBox();
          if (bounds === null) return Infinity;
          return Math.max(-bounds.x, bounds.x + bounds.width - width);
        })
        .toBeLessThanOrEqual(0);
    };
    const expectComments = async (form: Locator) => {
      await expect(frameSource(form)).toHaveValue(/^# Author frame comment\n/u);
      await expect(frameSource(form)).toHaveValue(/# Node note/u);
    };
    await button(root, "导入 ZIP", "Import ZIP").click();
    const settingTools = page.getByRole("navigation", {
      name: t("设定完善工具", "Setting-improvement tools"),
    });
    await button(settingTools, "编辑", "Edit").click();
    const content = page.getByRole("complementary", {
      name: t("内容包文件编辑", "Content-package file editing"),
    });
    await openFile(content, framePath);
    const form = frameForm(content);
    await expect(documentPicker(form)).toHaveValue("@ledger");
    await expect(nodePicker(form, "yaml").locator("option:checked")).toHaveText(
      "conditions › weather · Saved rain",
    );

    // Rename the selected field in an unsaved document, then repair the slot.
    const worldLedgerPath = `world/${ledgerPath}`;
    await openFile(content, worldLedgerPath);
    const ledger = source(content, worldLedgerPath);
    await ledger.fill(
      (await ledger.inputValue()).replace(
        "weather: Saved rain",
        "forecast: Draft snow",
      ),
    );
    await openFile(content, framePath);
    await expect(warning(form)).toBeVisible();
    await expect(nodePicker(form, "yaml").locator("option:checked")).toHaveText(
      "conditions › weather",
    );
    const forecast = JSON.stringify({ yaml: ["conditions", "forecast"] });
    await nodePicker(form, "yaml").selectOption(forecast);
    await expect(nodePicker(form, "yaml").locator("option:checked")).toHaveText(
      "conditions › forecast · Draft snow",
    );
    if (chinese) await expectInsideViewport(nodePicker(form, "yaml"));

    // The advanced textarea supports entering each segment on a separate line.
    await form
      .getByText(
        t("高级：手动填写节点路径", "Advanced: enter the node path manually"),
        {
          exact: true,
        },
      )
      .click();
    const manual = form.getByRole("textbox", {
      name: t("YAML 路径 2", "YAML path 2"),
    });
    await manual.fill("conditions");
    await manual.press("End");
    await manual.press("Enter");
    await manual.pressSequentially("harbor");
    await expect(manual).toHaveValue("conditions\nharbor");
    await expect(nodePicker(form, "yaml").locator("option:checked")).toHaveText(
      "conditions › harbor · Open",
    );
    await sourceToggle(form).click();
    await expectComments(form);
    await button(content, "整批保存", "Save all changes").click();
    await expect(
      content.getByText(t("当前树已保存", "Current tree saved")),
    ).toBeVisible();
    await button(content, "收起文件面板", "Close file panel").click();
    await button(settingTools, "创建世界", "Create world").click();
    await expect(page.getByLabel(t("你的行动", "Your action"))).toBeVisible();

    // The revision applies through the production Runtime; no model is called.
    const request = {
      type: "model.save",
      connection: {
        name: "Frame node fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "frame-node-test",
        modelId: "frame-node-test",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    } satisfies V1Request;
    const savedConnection = await page.request.post("/api/runtime/v1", {
      data: { protocol: "narraeon.runtime/v1", request },
    });
    expect(savedConnection.ok()).toBe(true);
    await page.reload();
    await button(root, "世界", "Worlds").click();
    await button(root, "修订当前世界", "Revise current world").click();
    const revisionTools = page.getByRole("navigation", {
      name: t("世界修订工具", "World-revision tools"),
    });
    await button(revisionTools, "编辑", "Edit").click();
    const revision = page.getByRole("complementary", {
      name: t("世界修订文件编辑", "Edit world-revision files"),
    });
    const stateAlmanacPath = `state/${almanacPath}`;
    await openFile(revision, stateAlmanacPath);
    const almanac = source(revision, stateAlmanacPath);
    await almanac.fill(
      (await almanac.inputValue()).replace("### Landing", "### Far landing"),
    );
    await openFile(revision, framePath);
    const revisionForm = frameForm(revision);
    await expect(
      nodePicker(revisionForm, "yaml").locator("option:checked"),
    ).toHaveText("conditions › harbor · Open");
    await documentPicker(revisionForm).selectOption("@almanac");
    const headings = nodePicker(revisionForm, "markdown");
    await headings.selectOption(
      JSON.stringify({ markdown: ["Crossing", "Far landing"] }),
    );
    await expect(headings.locator("option:checked")).toHaveText(
      "Crossing › Far landing",
    );
    if (chinese) await expectInsideViewport(headings);
    await expect(warning(revisionForm)).toHaveCount(0);
    await sourceToggle(revisionForm).click();
    await expectComments(revisionForm);
    await expect(frameSource(revisionForm)).toHaveValue(
      /markdown: \[ Crossing, Far landing \]/u,
    );
    await button(revision, "保存到修订", "Save to revision").click();
    await expect(
      revision.getByText(t("修订工作树已保存", "Revision worktree saved")),
    ).toBeVisible();
    await button(revision, "收起文件面板", "Close file panel").click();
    await button(root, "应用并解锁", "Apply and unlock").click();
    await expect(page.locator(".world-feedback.status")).toContainText(
      t("世界修订已应用并解锁", "The world revision was applied and unlocked."),
    );
  });
}
