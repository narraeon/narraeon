import { deflateSync } from "node:zlib";
import { expect } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "sillytavern-content-import" });

const worldBook = {
  entries: {
    0: {
      uid: 0,
      comment: "With rules",
      content: "A foggy port",
      key: ["harbor"],
      constant: false,
      probability: 0,
      cooldown: 0,
      group: "",
      keysecondary: [],
    },
    1: { uid: 1, comment: "Without rules", content: "A lighthouse" },
  },
};
const worldBookFile = {
  name: "world-book.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(worldBook)),
};

test("content import contains focus, respects pending work, and restores the file picker", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  const picker = page.getByLabel(
    "Import SillyTavern character card or world book",
  );
  const dialog = page.getByRole("dialog", {
    name: "SillyTavern content import wizard",
  });
  const close = dialog.getByRole("button", {
    name: "Close import wizard",
    exact: true,
  });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  const androidBack = () =>
    page.evaluate(() =>
      (
        window as { narraeonAndroidBack?: () => boolean }
      ).narraeonAndroidBack?.(),
    );

  await picker.setInputFiles(worldBookFile);
  await expect(dialog.getByText("A foggy port", { exact: true })).toBeVisible();
  await expect(close).toBeFocused();
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await picker.evaluate((input) => input.focus());
  await expect(cancel).toBeFocused();

  let releasePreview!: () => void;
  const holdPreview = new Promise<void>(
    (resolve) => (releasePreview = resolve),
  );
  await page.route("**/api/runtime/v1", async (route) => {
    const request = (route.request().postDataJSON() as { request: V1Request })
      .request;
    if (request.type === "content.sillytavern.preview") await holdPreview;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Preview target files" }).click();
    await expect(cancel).toBeDisabled();
    await expect(close).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(await androidBack()).toBe(true);
    await expect(dialog).toBeVisible();
  } finally {
    releasePreview();
  }
  await expect(cancel).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();

  await picker.focus();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  await chooser.setFiles(worldBookFile);
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(picker).toBeFocused();
  await picker.setInputFiles(worldBookFile);
  await expect(dialog).toBeVisible();
  expect(await androidBack()).toBe(true);
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();
});

test("world book rules show supplied values and keep the complete list collapsed", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".workspace-locale-picker select").selectOption("en");
  await page
    .getByLabel("Import SillyTavern character card or world book")
    .setInputFiles(worldBookFile);
  const dialog = page.getByRole("dialog", {
    name: "SillyTavern content import wizard",
  });
  const detail = dialog.locator(".import-browser-detail article");
  await expect(detail).toContainText("A foggy port");
  await expect(
    dialog.getByText(/trigger rules are for reference only in Narraeon/u),
  ).toBeVisible();
  const visibleRules = detail.locator("dl > div:visible");
  await expect(visibleRules).toHaveCount(4);
  for (const [name, value] of [
    ["Keywords", "harbor"],
    ["Constant (other filters still apply)", "No"],
    ["Activation probability", "0%"],
    ["Cooldown turns", "0"],
  ] as const) {
    await expect(
      visibleRules
        .filter({ has: page.getByText(name, { exact: true }) })
        .locator("dd"),
    ).toHaveText(value);
  }
  const complete = detail.getByText("All source rules", { exact: true });
  await complete.click();
  await expect(detail.locator("details dl > div:visible")).toHaveCount(23);
  await expect(
    detail.getByText(/Not specified or follows source globals/u).first(),
  ).toBeVisible();
  await detail.getByText("Source rules JSON", { exact: true }).click();
  await expect(detail.getByText(/"probability": 0/u)).toBeVisible();
  await dialog.getByRole("button", { name: /Without rules/u }).click();
  await expect(visibleRules).toHaveCount(0);
  await expect(complete).toBeVisible();
});

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
          alternate_greetings: ["A second greeting."],
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
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Current situation" : "当前情境",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByText("At the harbor", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("A navigator", { exact: true }),
      ).toHaveCount(0);
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Character document" : "角色文档",
          exact: true,
        })
        .click();
      const rect = await dialog.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);

      await page.screenshot({
        path: test
          .info()
          .outputPath(`${locale}-${mobile ? "mobile" : "desktop"}-top.png`),
      });
      await dialog
        .getByLabel(locale === "en" ? "Character document" : "角色文档")
        .check();
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Current situation" : "当前情境",
          exact: true,
        })
        .click();
      await dialog
        .getByRole("button", {
          name: locale === "en" ? "Character document" : "角色文档",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByLabel(locale === "en" ? "Character document" : "角色文档"),
      ).toBeChecked();
      await dialog
        .getByLabel(locale === "en" ? "Current situation" : "当前情境", {
          exact: true,
        })
        .check();
      const opening1 = dialog.getByLabel(
        locale === "en" ? "Choose one opening 1" : "选择一个开场白 1",
      );
      const opening2 = dialog.getByLabel(
        locale === "en" ? "Choose one opening 2" : "选择一个开场白 2",
      );
      await opening1.check();
      await opening2.check();
      await expect(opening1).not.toBeChecked();
      await opening2.click();
      await expect(opening2).not.toBeChecked();
      await opening1.check();
      await dialog
        .getByLabel(locale === "en" ? "Harbor Destination" : "Harbor 目标用途")
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
        path: test
          .info()
          .outputPath(`${locale}-${mobile ? "mobile" : "desktop"}.png`),
      });
      await page.keyboard.press("Escape");
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
