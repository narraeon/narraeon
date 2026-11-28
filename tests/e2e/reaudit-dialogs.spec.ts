import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { v1Protocol } from "../../src/protocol/v1Version.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "reaudit-preset-dialogs" });

const runtimeUrl = "**/api/runtime/v1";

async function open(page: Page, hash: string, locale: "zh-CN" | "en") {
  const response = await page.request.post("/api/runtime/v1", {
    data: {
      protocol: v1Protocol,
      request: { type: "preferences.save", locale },
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto(`/${hash}`);
}

function androidBack(page: Page) {
  return page.evaluate(() =>
    (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack?.(),
  );
}

function presetFile({ count = 1, variables = false } = {}) {
  const prompts = Array.from({ length: count }, (_, index) => ({
    identifier: `prompt-${index + 1}`,
    name: `Layout prompt ${index + 1}`,
    role: "system",
    content: [
      ...(variables
        ? [
            "{{getvar::weather0}}",
            ...Array.from(
              { length: count },
              (_, declaration) => `{{setvar::weather${declaration}::fog}}`,
            ),
          ]
        : []),
      ...Array.from({ length: count }, (_, line) => `Body line ${line + 1}`),
    ].join("\n"),
  }));
  return {
    name: "layout.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        prompts,
        prompt_order: [
          {
            character_id: 100001,
            order: prompts.map(({ identifier }) => ({
              identifier,
              enabled: identifier === "prompt-1",
            })),
          },
        ],
      }),
    ),
  };
}

test("preset file errors are announced beside the picker and recover after reselecting (#459)", async ({
  page,
}) => {
  await open(page, "#/orchestrations", "zh-CN");
  await page.evaluate(() => {
    File.prototype.text = function () {
      if (this.name === "broken.json")
        return Promise.reject(new Error("read failed"));
      return Blob.prototype.text.call(this);
    };
  });
  await page.getByText("编排方案管理", { exact: true }).click();
  const picker = page.getByLabel("选择 SillyTavern JSON 文件");
  await picker.setInputFiles({ ...presetFile(), name: "broken.json" });
  await expect(page.getByRole("alert")).toContainText(
    "无法读取 SillyTavern JSON 文件",
  );
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveAccessibleDescription(
    "无法读取 SillyTavern JSON 文件，请重新选择。",
  );
  await picker.setInputFiles(presetFile());
  const dialog = page.getByRole("dialog", { name: "SillyTavern 导入向导" });
  await expect(dialog.getByText("Body line 1", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭导入向导" }).click();
  await expect(picker).toBeFocused();
  await expect(page.getByText("无法读取 SillyTavern JSON 文件")).toHaveCount(0);
});

test("preset modal contains keyboard focus and handles Escape and Android back in order (#459)", async ({
  page,
}) => {
  await open(page, "#/orchestrations", "en");
  const inspection = Promise.withResolvers<void>();
  await page.route(runtimeUrl, async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type === "play.sillytavern.inspect") await inspection.promise;
    await route.continue();
  });
  const menu = page.getByText("Manage orchestrations", { exact: true });
  await menu.click();
  const picker = page.getByLabel("Choose SillyTavern JSON file");
  const dialog = page.getByRole("dialog", {
    name: "SillyTavern import wizard",
  });
  const title = dialog.getByRole("heading", {
    name: "SillyTavern import wizard",
  });
  const close = dialog.getByRole("button", { name: "Close import wizard" });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await picker.setInputFiles(presetFile({ variables: true }));
  try {
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    await expect.soft(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect.soft(dialog).toBeVisible();
    expect.soft(await androidBack(page)).toBe(true);
    await expect.soft(dialog).toBeVisible();
  } finally {
    inspection.resolve();
  }
  await expect(close).toBeEnabled();
  await expect(title).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.soft(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.soft(close).toBeFocused();
  const reference = dialog.getByRole("button", {
    name: "{{getvar::weather0}}",
    exact: true,
  });
  await reference.click();
  const tooltip = dialog.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(reference).toBeFocused();
  // A mouse click opens the same tooltip without changing the keyboard path.
  await reference.click();
  await expect(tooltip).toBeVisible();
  expect(await androidBack(page)).toBe(true);
  await expect(tooltip).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(await androidBack(page)).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(picker).toBeFocused();
  expect(await androidBack(page)).toBe(true);
  await expect(picker).toBeHidden();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Enter");
  await picker.setInputFiles(presetFile());
  await expect(close).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(picker).toBeFocused();

  await picker.setInputFiles(presetFile());
  await dialog.getByRole("button", { name: "Conversion preview" }).click();
  await dialog.getByRole("button", { name: "Import independent copy" }).click();
  await expect(dialog).toBeHidden();
  await expect(picker).toBeHidden();
  await expect(menu).toBeFocused();
});

for (const variables of [true, false]) {
  test(`preset panels fit and scroll across breakpoint widths (variables: ${variables}) (#461)`, async ({
    page,
  }) => {
    await open(page, "#/orchestrations", "en");
    await page.getByText("Manage orchestrations", { exact: true }).click();
    const picker = page.getByLabel("Choose SillyTavern JSON file");
    await picker.setInputFiles(presetFile({ count: 26, variables }));
    const dialog = page.getByRole("dialog", {
      name: "SillyTavern import wizard",
    });
    const browser = dialog.locator(".import-browser");
    await expect(browser.locator(".st-variables")).toHaveCount(
      variables ? 1 : 0,
    );
    await expect(
      browser.getByText("Body line 26", { exact: false }),
    ).toBeAttached();

    for (const [width, height] of [
      [390, 844],
      [650, 740],
      [651, 740],
      [750, 350],
      [750, 480],
      [850, 740],
      [851, 740],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      const panels = await browser.evaluate((element) =>
        Array.from(element.children, (panel) => {
          const { x, y, width, height, bottom } = panel.getBoundingClientRect();
          const style = getComputedStyle(panel);
          return {
            x,
            y,
            width,
            height,
            bottom,
            rightBorder: style.borderRightWidth,
            bottomBorder: style.borderBottomWidth,
            topBorder: style.borderTopWidth,
            leftBorder: style.borderLeftWidth,
            scrollRoom: panel.scrollHeight - panel.clientHeight,
          };
        }),
      );
      const [list, detail, declarations] = panels;
      const size = `${width}×${height}`;
      if (!list || !detail) throw new Error(`Missing import panels at ${size}`);
      for (const panel of panels) {
        expect.soft(panel.height, size).toBeGreaterThan(35);
        expect.soft(panel.scrollRoom, size).toBeGreaterThan(0);
      }
      if (width <= 850) {
        expect.soft(detail.x, size).toBe(list.x);
        expect.soft(detail.y, size).toBeCloseTo(list.bottom, 0);
        expect.soft(list.rightBorder, size).toBe("0px");
        expect.soft(list.bottomBorder, size).toBe("1px");
        expect.soft(list.height, size).toBeLessThan(detail.height);
        if (declarations) {
          expect.soft(declarations.y, size).toBeCloseTo(detail.bottom, 0);
          expect.soft(declarations.topBorder, size).toBe("1px");
        }
      } else {
        expect.soft(detail.x, size).toBeCloseTo(list.x + list.width, 0);
        expect.soft(detail.y, size).toBe(list.y);
        expect.soft(list.rightBorder, size).toBe("1px");
        expect.soft(list.bottomBorder, size).toBe("0px");
        if (declarations) {
          expect
            .soft(declarations.x, size)
            .toBeCloseTo(detail.x + detail.width, 0);
          expect.soft(declarations.leftBorder, size).toBe("1px");
        }
      }
    }
    await page.setViewportSize({ width: 750, height: 480 });
    await browser.getByRole("button", { name: /Layout prompt 26/u }).click();
    await expect(browser.locator(".import-browser-detail pre")).toContainText(
      "Body line 26",
    );
    await expect(
      dialog.getByRole("button", { name: "Conversion preview" }),
    ).toBeInViewport();
    await page.setViewportSize({ width: 750, height: 350 });
    if (variables) {
      await browser
        .getByRole("button", { name: "Original declaration" })
        .last()
        .click();
      await expect(
        browser.getByText("{{setvar::weather25::fog}}", { exact: true }),
      ).toBeVisible();
    }
    const preview = dialog.getByRole("button", { name: "Conversion preview" });
    await preview.click();
    await expect(
      dialog.getByRole("button", { name: "Back to source" }),
    ).toBeVisible();
  });
}

test("restores opener and moves focus to the new editor on success (#460)", async ({
  page,
}) => {
  await open(page, "#/library", "zh-CN");
  const opener = page.getByRole("button", { name: "新建内容包" });
  const dialog = page.getByRole("dialog", { name: "新建内容包" });
  const mode = dialog.getByRole("radio", { name: "互动式小说" });
  const submit = dialog.getByRole("button", { name: "创建", exact: true });
  await opener.click();
  await expect(mode).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.soft(submit).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.soft(mode).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  expect(await androidBack(page)).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await page.goto("/#/create");
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  const create = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route(runtimeUrl, async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type === "content.create" && ++attempts === 1) {
      await create.promise;
      await route.fulfill({ status: 500, body: "Delayed package failure" });
    } else await route.continue();
  });
  await page.keyboard.press("Enter");
  await submit.click();
  try {
    await expect(dialog.getByRole("status")).toHaveText("正在创建内容包…");
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("heading")).toBeFocused();
    await page.keyboard.press("Escape");
    expect(await androidBack(page)).toBe(true);
    await expect(dialog).toBeVisible();
  } finally {
    create.resolve();
  }
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/content\//u);
  await expect(page.locator("#setting-improvement-title")).toBeFocused();
  expect(attempts).toBe(2);
});
