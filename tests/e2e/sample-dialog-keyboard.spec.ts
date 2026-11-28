import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { v1Protocol } from "../../src/protocol/v1Version.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "reaudit-sample-dialog" });

function androidBack(page: Page) {
  return page.evaluate(() =>
    (window as { narraeonAndroidBack?: () => boolean }).narraeonAndroidBack?.(),
  );
}

test("retains focus while creating, retries, and focuses the new world page (#460)", async ({
  page,
}) => {
  const response = await page.request.post("/api/runtime/v1", {
    data: {
      protocol: v1Protocol,
      request: { type: "preferences.save", locale: "en" },
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  const early = page.getByRole("button", { name: "Choose a story to play" });
  const library = page.getByRole("button", {
    name: "Create from a built-in story",
  });
  const dialog = page.getByRole("dialog", { name: "Choose a story" });
  const choices = dialog.getByRole("list").getByRole("button");
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await early.click();
  await expect.soft(choices.first()).toBeFocused({ timeout: 700 });
  await page.keyboard.press("Shift+Tab");
  await expect.soft(cancel).toBeFocused({ timeout: 700 });
  await page.keyboard.press("Tab");
  await expect.soft(choices.first()).toBeFocused({ timeout: 700 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(early).toBeFocused();

  await page.goto("/#/library");
  await library.click();
  expect(await androidBack(page)).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(library).toBeFocused();
  const create = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route("**/api/runtime/v1", async (route) => {
    const { request } = route.request().postDataJSON() as {
      request: V1Request;
    };
    if (request.type === "content.create-sample" && ++attempts === 1) {
      await create.promise;
      await route.fulfill({ status: 500, body: "Delayed sample failure" });
    } else await route.continue();
  });
  await library.click();
  await choices.first().click();
  try {
    await expect(dialog.getByRole("status")).toHaveText("Preparing story…");
    await page.keyboard.press("Tab");
    await expect
      .soft(dialog.locator(":focus"))
      .toHaveCount(1, { timeout: 700 });
    await page.keyboard.press("Shift+Tab");
    await expect
      .soft(dialog.locator(":focus"))
      .toHaveCount(1, { timeout: 700 });
    await page.keyboard.press("Escape");
    expect(await androidBack(page)).toBe(true);
    await expect(dialog).toBeVisible();
  } finally {
    create.resolve();
  }
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(choices.first()).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(choices.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/create$/u);
  await expect(
    page.getByRole("heading", { name: "Create world", exact: true }),
  ).toBeFocused();
  expect(attempts).toBe(2);
});
