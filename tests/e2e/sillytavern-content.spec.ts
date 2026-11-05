import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function cardPng(source: unknown): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "tEXt",
      Buffer.from(
        `chara\0${Buffer.from(JSON.stringify(source)).toString("base64")}`,
      ),
    ),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
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
      await picker.setInputFiles(
        locale === "en" && mobile
          ? { name: "card.png", mimeType: "image/png", buffer: cardPng(source) }
          : {
              name: "card.json",
              mimeType: "application/json",
              buffer: Buffer.from(JSON.stringify(source)),
            },
      );
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
      await expect(dialog.getByRole("status")).toContainText(
        locale === "en" ? "Needs completion" : "需要完善",
      );
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
