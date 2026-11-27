import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appLocales } from "../../src/protocol/appPreferences.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";

for (const locale of appLocales) {
  test(`the content-package frame editor shows the player copy (${locale})`, async ({
    page,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-frame-copy-"));
    const servers = new RuntimeServerPool();
    const chinese = locale === "zh-CN";
    try {
      const port = await availableRuntimePort();
      await servers.start(root, port);
      await page.goto(`http://127.0.0.1:${port}`);
      await page
        .locator(".workspace-locale-picker select")
        .selectOption(locale);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);

      const createPackage = chinese ? "新建内容包" : "Create content package";
      await page
        .getByRole("button", { name: createPackage, exact: true })
        .click();
      await page
        .getByRole("dialog", { name: createPackage })
        .getByRole("button", { name: chinese ? "创建" : "Create", exact: true })
        .click();
      await page
        .getByRole("navigation", {
          name: chinese ? "设定完善工具" : "Setting-improvement tools",
        })
        .getByRole("button", { name: chinese ? "编辑" : "Edit", exact: true })
        .click();
      await page
        .getByRole("button", {
          name: chinese ? "打开 control/frame.yaml" : "Open control/frame.yaml",
          exact: true,
        })
        .click();

      const editor = page.getByRole("region", {
        name: chinese ? "世界提示框架" : "World prompt frame",
      });
      for (const text of chinese
        ? [
            "当前场景与常驻视图",
            "当前场景文档将从这里读取",
            "常驻视图在 control/player-views.yaml 中配置。",
          ]
        : [
            "Current scene and pinned views",
            "Reads the active scene document from here",
            "Pinned views are configured in control/player-views.yaml.",
          ]) {
        await expect(editor.getByText(text, { exact: true })).toBeVisible();
      }
      await expect(
        editor.getByRole("combobox", {
          name: chinese ? "当前情境文档" : "Current-situation document",
          exact: true,
        }),
      ).toHaveValue("@current-situation");

      const source = editor.getByLabel(
        chinese ? "编辑 control/frame.yaml" : "Edit control/frame.yaml",
      );
      const sourceToggle = editor.getByRole("button", {
        name: chinese ? "源码" : "Source",
        exact: true,
      });
      const formToggle = editor.getByRole("button", {
        name: chinese ? "表单" : "Form",
        exact: true,
      });
      await expect(source).toBeHidden();
      await sourceToggle.click();
      await expect(source).toBeVisible();
      await expect(source).toHaveValue(/format: narraeon\.world-frame\/v1/u);

      const formatted = (await source.inputValue()).replace(
        /^format: narraeon\.world-frame\/v1/mu,
        "# Author header\nformat: narraeon.world-frame/v1 # Format note",
      );
      await source.fill(formatted);
      await formToggle.click();
      const showSize = (name: string) =>
        editor.getByText(name, { exact: true }).first().click();
      const noSize = chinese ? "设置建议体积" : "Set advisory size";
      await showSize(noSize);
      const sizeLabel = chinese
        ? "建议体积（UTF-8 字节，可留空）"
        : "Advisory size (UTF-8 bytes, optional)";
      await editor
        .getByRole("spinbutton", { name: sizeLabel })
        .first()
        .fill("1234");
      await sourceToggle.click();
      await expect(source).toHaveValue(
        /^# Author header\nformat: narraeon\.world-frame\/v1 # Format note/mu,
      );
      const unsupported = formatted.replace(/^bindings:/mu, "bindings: &keep");
      await source.fill(unsupported);
      await expect(source).toHaveValue(unsupported);
      await expect(
        editor.getByText(
          chinese
            ? "当前 YAML 暂时无法可视化"
            : "Current YAML cannot be visualized yet",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        editor.getByRole("spinbutton", { name: sizeLabel }),
      ).toHaveCount(0);
      await expect(formToggle).toBeDisabled();
      await source.fill(formatted);
      await formToggle.click();
      await showSize(noSize);
      await expect(
        editor.getByRole("spinbutton", { name: sizeLabel }).first(),
      ).toBeVisible();
      await editor
        .getByRole("spinbutton", { name: sizeLabel })
        .first()
        .fill("1234");
      const button = (zh: string, en: string) =>
        page.getByRole("button", { name: chinese ? zh : en, exact: true });
      await button("整批保存", "Save all changes").click();
      await expect(
        page.getByText(chinese ? "当前树已保存" : "Current tree saved", {
          exact: true,
        }),
      ).toBeVisible();
      await button("收起文件面板", "Close file panel").click();
      await button("创建世界", "Create world").click();
      await expect(
        page.getByLabel(chinese ? "你的行动" : "Your action"),
      ).toBeVisible();
      await button("世界", "Worlds").click();
      await button("修订当前世界", "Revise current world").click();
      await page
        .getByRole("navigation", {
          name: chinese ? "世界修订工具" : "World-revision tools",
        })
        .getByRole("button", { name: chinese ? "编辑" : "Edit", exact: true })
        .click();
      await button(
        "打开 control/frame.yaml",
        "Open control/frame.yaml",
      ).click();
      await showSize(
        chinese ? "建议体积 · 1,234 字节" : "Advisory size · 1,234 bytes",
      );
      await expect(
        editor.getByRole("spinbutton", { name: sizeLabel }).first(),
      ).toHaveValue("1234");
      await editor
        .getByRole("spinbutton", { name: sizeLabel })
        .first()
        .fill("2345");
      await sourceToggle.click();
      await expect(source).toHaveValue(
        /^# Author header\nformat: narraeon\.world-frame\/v1 # Format note/mu,
      );
      await expect(source).toHaveValue(/advisoryBytes: 2345/u);
      await button("保存到修订", "Save to revision").click();
      await expect(
        page.getByText(
          chinese ? "修订工作树已保存" : "Revision worktree saved",
          { exact: true },
        ),
      ).toBeVisible();
    } finally {
      await servers.stopAll();
      await rm(root, { force: true, recursive: true });
    }
  });
}
