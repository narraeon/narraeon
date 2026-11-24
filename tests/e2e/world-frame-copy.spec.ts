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
        chinese
          ? "直接编辑 control/frame.yaml"
          : "Edit control/frame.yaml directly",
      );
      await expect(source).toBeHidden();
      await editor
        .getByText(
          chinese ? "源码视图（frame.yaml）" : "Source view (frame.yaml)",
          {
            exact: true,
          },
        )
        .click();
      await expect(source).toBeVisible();
      await expect(source).toHaveValue(/format: narraeon\.world-frame\/v1/u);
    } finally {
      await servers.stopAll();
      await rm(root, { force: true, recursive: true });
    }
  });
}
