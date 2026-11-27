import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "home-card-actions" });

const worldTitles = ["Harbor houses", "Garden path"] as const;
const packageTitles = [
  "A sketch for the coastal village and its unreasonably long and otherwise unbroken WatchtowerWatchtowerWatchtowerWatchtowerWatchtowerWatchtower alias",
  "Cottage story",
] as const;

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}

async function createCards(
  page: Page,
  titles: readonly string[] = packageTitles,
  createWorlds = true,
) {
  await runtime(page, { type: "preferences.save", locale: "en" });
  for (const name of titles) {
    const { localId } = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, { type: "content.rename", packageId: localId, name });
    for (const title of createWorlds && name === titles[0] ? worldTitles : []) {
      const { world } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId: localId,
      });
      await runtime(page, {
        type: "world.rename",
        worldId: world.worldId,
        name: title,
      });
    }
  }
}

const worldAction = (page: Page, title: string) =>
  page.getByLabel(`World actions: ${title}`, { exact: true });
const packageAction = (page: Page, title: string) =>
  page.getByLabel(`Content-package actions: ${title}`, { exact: true });
const renameWorld = (page: Page, title: string) =>
  page.getByRole("button", { name: `Rename world: ${title}`, exact: true });
const renamePackage = (page: Page, title: string) =>
  page.getByRole("button", {
    name: `Rename content package: ${title}`,
    exact: true,
  });

test("desktop card actions close on Escape and outside clicks, and switch without blocking the second row", async ({
  page,
}) => {
  await createCards(page);
  await page.goto("/#/");
  const [firstTitle, secondTitle] = worldTitles;
  const first = worldAction(page, firstTitle);
  const second = worldAction(page, secondTitle);
  const firstRename = renameWorld(page, firstTitle);
  const secondRename = renameWorld(page, secondTitle);
  const rowBefore = await second.boundingBox();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(firstRename).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Export backup", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(firstRename).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(firstRename).toBeHidden({ timeout: 1_000 });
  await expect(first).toBeFocused();

  await first.click();
  await expect(firstRename).toBeVisible();
  expect(await second.boundingBox()).toEqual(rowBefore);
  await second.click();
  await expect(firstRename).toBeHidden();
  await expect(secondRename).toBeVisible();
  await page.getByRole("heading", { name: "Continue playing" }).click();
  await expect(secondRename).toBeHidden();

  await first.click();
  const title = packageTitles[0];
  await packageAction(page, title).click();
  await expect(firstRename).toBeHidden();
  await expect(renamePackage(page, title)).toBeVisible();
  await renamePackage(page, title).click();
  await expect(
    page.getByRole("textbox", { name: "Content-package title" }),
  ).toBeFocused();
  await expect(renamePackage(page, title)).toBeHidden();
});

test.describe("touch", () => {
  test.use({
    viewport: { width: 390, height: 500 },
    hasTouch: true,
    isMobile: true,
  });

  test("content library actions stay within a narrow viewport and dismiss on tap", async ({
    page,
  }) => {
    const firstTitle = `${packageTitles[0]} touch`;
    const secondTitle = `${packageTitles[1]} touch`;
    await createCards(page, [firstTitle, secondTitle], false);
    await page.goto("/#/library");
    const first = packageAction(page, firstTitle);
    const second = packageAction(page, secondTitle);
    await first.tap();
    const firstRename = renamePackage(page, firstTitle);
    await expect(firstRename).toBeVisible();
    await second.tap();
    await expect(firstRename).toBeHidden({ timeout: 1_000 });
    const secondRename = renamePackage(page, secondTitle);
    await expect(secondRename).toBeVisible();
    const panel = await secondRename.locator("..").boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    expect(panel!.y).toBeGreaterThanOrEqual(54);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(500);
    await page
      .getByRole("heading", { name: "Content package", exact: true })
      .tap();
    await expect(secondRename).toBeHidden();
  });
});
