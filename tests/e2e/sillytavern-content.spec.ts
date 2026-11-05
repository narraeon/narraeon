import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const locale of ["zh-CN", "en"] as const)
  for (const mobile of [false, true]) {
    test(`SillyTavern content wizard ${locale} ${mobile ? "mobile" : "desktop"}`, async ({
      page,
    }) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      await page.goto("/");
      await page
        .locator(".workspace-locale-picker select")
        .selectOption(locale);
      const source = {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Harbor",
          description: "A navigator",
          personality: "Patient",
          scenario: "At the harbor",
          first_mes: "The boat arrives.",
          mes_example: "A dialogue",
          character_book: {
            entries: [
              {
                id: 1,
                comment: "Harbor",
                content: "A foggy port",
                enabled: true,
                keys: ["harbor"],
                insertion_order: 100,
              },
            ],
          },
        },
      };
      const picker = page.locator(
        'input[accept=".json,.png,application/json,image/png"]',
      );
      await picker.setInputFiles({
        name: "card.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(source)),
      });
      const dialog = page.getByRole("dialog", {
        name:
          locale === "en"
            ? "SillyTavern content import wizard"
            : "SillyTavern 内容导入向导",
      });
      await expect(
        dialog.getByText("A navigator", { exact: true }),
      ).toBeVisible();
      const evidence = "/tmp/narraeon-139-evidence";
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: `${evidence}/${locale}-${mobile ? "mobile" : "desktop"}-top.png`,
      });
      await dialog
        .getByLabel(locale === "en" ? "Character document" : "角色文档")
        .check();
      await dialog
        .getByLabel(locale === "en" ? "Current situation" : "当前情境", {
          exact: true,
        })
        .check();
      await dialog
        .getByLabel(locale === "en" ? "Choose one opening" : "选择一个开场白")
        .selectOption("0");
      await dialog
        .getByLabel(locale === "en" ? "Destination" : "目标用途")
        .selectOption("world");
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Preview target files" : "预览目标文件",
        })
        .click();
      await expect(
        dialog.getByText("opening.md", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: `${evidence}/${locale}-${mobile ? "mobile" : "desktop"}.png`,
      });
      await dialog
        .getByRole("button", { name: locale === "en" ? "Cancel" : "取消" })
        .click();
      await expect(dialog).toHaveCount(0);
      await picker.setInputFiles({
        name: "card.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(source)),
      });
      await expect(
        dialog.getByText("A navigator", { exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Preview target files" : "预览目标文件",
        })
        .click();
      await dialog
        .getByRole("button", {
          name:
            locale === "en"
              ? "Create independent content package"
              : "创建独立内容包",
        })
        .click();
      await expect(dialog).toHaveCount(0);
    });
  }
