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
  browserName,
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
  await openList.press("Enter");
  const draftNotice = list.getByText(
    "Save or discard your changes before editing, cloning, or deleting a saved configuration.",
  );
  await expect.soft(draftNotice).toBeInViewport({ timeout: 1500 });
  for (const action of ["Edit", "Clone configuration", "Delete"]) {
    await expect(
      second.getByRole("button", { name: action, exact: true }),
    ).toBeDisabled();
  }
  const returnToDraft = list.getByRole("button", {
    name: "Return to draft",
  });
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(returnToDraft).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(formHeading).toBeFocused();
  await expect(name).toHaveValue("Unsaved first connection");
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "Second connection",
  );
  await openList.tap();
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
  await expect(draftNotice).toBeHidden();
  await page
    .getByRole("combobox", { name: "Interface language" })
    .selectOption("zh-CN");
  await page.setViewportSize({ width: 640, height: 844 });
  const chineseName = page.getByLabel("配置名称", { exact: true });
  await chineseName.fill("尚未保存的配置名");
  await page.getByRole("button", { name: /已保存配置/u }).tap();
  const chineseList = page.getByRole("region", { name: "已保存模型配置" });
  await expect
    .soft(
      chineseList.getByText(
        "编辑、克隆或删除已保存的配置前，请先保存或放弃当前修改。",
      ),
    )
    .toBeVisible({ timeout: 1500 });
  const chineseReturn = chineseList.getByRole("button", { name: "返回草稿" });
  await expect(chineseReturn).toBeVisible();
  await chineseReturn.tap();
  await expect(page.getByRole("heading", { name: "编辑配置" })).toBeFocused();
  await expect(chineseName).toHaveValue("尚未保存的配置名");
  await expect(page.locator(".model-active-summary strong")).toHaveText(
    "Unsaved first connection",
  );
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.getByRole("button", { name: /已保存配置/u }).tap();
  await expect(chineseReturn).toBeHidden();
  const other = chineseList
    .getByRole("article")
    .filter({ hasText: "Second connection" });
  for (const action of ["编辑", "克隆配置", "删除"]) {
    await expect(
      other.getByRole("button", { name: action, exact: true }),
    ).toBeEnabled();
  }
});

test.describe("desktop model settings", () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    hasTouch: false,
  });

  test("follows the saved list, discloses each model prompt, and focuses hidden invalid fields", async ({
    browserName,
    page,
  }) => {
    const tab =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    await runtime(page, { type: "preferences.save", locale: "en" });
    const longName = "ConnectionLongName".repeat(7);
    const prefilledPrompt = "A saved connection prompt.";
    for (let index = 0; index < 12; index += 1) {
      await runtime(page, {
        type: "model.save",
        connection: {
          name: index === 0 ? longName : `Connection ${index}`,
          presetId: "custom",
          provider: "chat_completions",
          baseUrl: "http://127.0.0.1:9/v1",
          authMode: "none",
          modelId: `fixture-${index}`,
          modelPrompt: index === 11 ? prefilledPrompt : "",
          contextWindowTokens: 64_000,
          maxOutputTokens: 8_192,
        },
      });
    }
    await page.goto("/#/models");
    const list = page.getByRole("region", {
      name: "Saved model configurations",
    });
    const form = page.locator("form.config-form");
    const heading = form.getByRole("heading", { name: "Edit configuration" });
    const createAnother = form.getByRole("button", { name: "Create another" });
    await expect(createAnother).toBeVisible();
    for (const width of [1440, 960, 641]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await Promise.all(
        [
          "model-preset",
          "model-name",
          "model-base-url",
          "model-auth-mode",
          "model-id",
        ].map(async (id) => ({
          label: (await form.locator(`label[for="${id}"]`).boundingBox())!,
          control: (await form.locator(`#${id}`).boundingBox())!,
        })),
      );
      const x = boxes[0]!.label.x;
      for (const { label, control } of boxes) {
        expect(label.x).toBe(x);
        expect(control.x).toBe(x);
        expect(label.y + label.height).toBeLessThanOrEqual(control.y);
      }
      expect(await list.evaluate((element) => element.scrollWidth)).toBe(
        await list.evaluate((element) => element.clientWidth),
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(
      await list.evaluate((element) => element.scrollHeight),
    ).toBeGreaterThan(await list.evaluate((element) => element.clientHeight));
    expect((await list.boundingBox())!.x).toBeLessThan(
      (await form.boundingBox())!.x,
    );

    await createAnother.focus();
    await page.keyboard.press(`Shift+${tab}`);
    expect(
      await list.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press(tab);
    await expect(createAnother).toBeFocused();

    const summary = form
      .locator("summary")
      .filter({ hasText: "Model prompt (optional)" });
    const prompt = form.getByLabel("Model prompt (optional)", { exact: true });
    await expect(summary).toContainText("Filled in");
    await expect(prompt).toBeHidden();
    await summary.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press(tab);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(prefilledPrompt);
    await prompt.fill("");
    await expect(summary).not.toContainText("Filled in");

    const otherEdit = list
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: longName, exact: true }),
      })
      .getByRole("button", { name: "Edit", exact: true });
    await expect(otherEdit).toBeDisabled();
    await form.getByRole("button", { name: "Discard changes" }).click();
    await expect(summary).toContainText("Filled in");
    await otherEdit.focus();
    await page.keyboard.press("Enter");
    await expect(heading).toBeFocused();
    await expect(form.getByLabel("Configuration name")).toHaveValue(longName);
    await expect(summary).not.toContainText("Filled in");
    await expect(prompt).toBeHidden();

    const advanced = form.getByText("Advanced protocol options", {
      exact: true,
    });
    await advanced.click();
    await form.locator("#model-provider").selectOption("anthropic_messages");
    await form.getByLabel("API Key", { exact: true }).fill("fixture-secret");
    await form.locator("#model-thinking-mode").selectOption("enabled");
    const budget = form.getByLabel("Thinking budget tokens");
    const name = form.getByLabel("Configuration name", { exact: true });
    const save = form.getByRole("button", {
      name: "Save and enable model connection",
    });
    const active = page.locator(".model-active-summary strong");
    await budget.fill("600");
    await name.fill("");
    await advanced.click();
    await expect(budget).toBeHidden();
    await save.click();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("");
    await expect(budget).toBeVisible();
    await expect(budget).toHaveValue("600");
    await expect(active).toHaveText("Connection 11");

    await name.fill("Corrected connection");
    await advanced.click();
    await expect(budget).toBeHidden();
    await save.click();
    await expect(budget).toBeVisible();
    await expect(budget).toBeFocused();
    await expect(budget).toHaveValue("600");
    await expect(name).toHaveValue("Corrected connection");
    await expect(active).toHaveText("Connection 11");

    await budget.fill("2048");
    await advanced.click();
    await save.click();
    await expect(active).toHaveText("Corrected connection");
    await expect(budget).toBeHidden();
    await advanced.click();
    await expect(budget).toHaveValue("2048");
  });
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
