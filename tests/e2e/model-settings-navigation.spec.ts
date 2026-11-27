import { expect, type Page } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({
  runtimeScope: "model-settings-navigation",
  hasTouch: true,
  viewport: { width: 390, height: 844 },
});

test("narrow model settings reach saved configurations without scrolling the form", async ({
  page,
}) => {
  await runtime(page, { type: "preferences.save", locale: "en" });
  await page.goto("/#/models");
  const name = page.getByLabel("Configuration name", { exact: true });
  const list = page.getByRole("region", { name: "Saved model configurations" });
  const openList = page.getByRole("button", { name: /Saved configurations/u });
  const backToForm = page.getByRole("button", {
    name: "Back to configuration form",
    exact: true,
  });
  await expect(
    page.getByRole("heading", { name: "New configuration", exact: true }),
  ).toBeInViewport();
  await expect(openList).toHaveCount(0);
  await expect(list).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(list).toContainText("No model configurations saved yet.");
  await expect(name).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });

  for (const [index, label] of [
    "First connection",
    "Second connection",
  ].entries()) {
    await runtime(page, {
      type: "model.save",
      connection: {
        name: label,
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        authMode: "none",
        modelId: `fixture-${index}`,
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
  }
  await page.reload();
  await expect(name).toHaveValue("Second connection");
  await expect(openList).toBeInViewport();
  await expect(openList).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
  await openList.focus();
  await page.keyboard.press("Enter");
  await expect(backToForm).toHaveAttribute("aria-expanded", "true");
  await expect(name).toBeHidden();

  const first = list.locator("article").filter({ hasText: "First connection" });
  const second = list
    .locator("article")
    .filter({ hasText: "Second connection" });
  const editFirst = first.getByRole("button", { name: "Edit", exact: true });
  const selectFirst = first.getByRole("button", {
    name: "Switch to this configuration",
  });
  await expect(selectFirst).toBeInViewport();
  await editFirst.focus();
  await page.keyboard.press("Enter");
  const formHeading = page.getByRole("heading", {
    name: "Edit configuration",
    exact: true,
  });
  await expect(formHeading).toBeFocused();
  await expect(formHeading).toBeInViewport();
  await expect(name).toHaveValue("First connection");
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "Second connection",
  );

  await name.fill("Unsaved first connection");
  await openList.tap();
  await expect(
    second.getByRole("button", { name: "Edit", exact: true }),
  ).toBeDisabled();
  await selectFirst.tap();
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "First connection",
  );
  await backToForm.tap();
  await expect(name).toHaveValue("Unsaved first connection");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(openList).toBeHidden();
  await expect(list).toBeVisible();
  await expect(formHeading).toBeVisible();
  expect((await list.boundingBox())!.x).toBeLessThan(
    (await formHeading.boundingBox())!.x,
  );
  await page
    .getByRole("button", { name: "Save and enable model connection" })
    .click();
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "Unsaved first connection",
  );
  const state = await runtime<ModelConnectionLibraryView>(page, {
    type: "model.read",
  });
  expect(state.connections.map(({ name }) => name).sort()).toEqual([
    "Second connection",
    "Unsaved first connection",
  ]);
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
