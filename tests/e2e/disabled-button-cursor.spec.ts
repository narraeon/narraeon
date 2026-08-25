import { expect, test } from "@playwright/test";

test("禁用按钮使用不可用指针而不是忙碌指针", async ({ page }) => {
  await page.goto("/");

  const disabledImportButton = page.getByRole("button", { name: "导入 ZIP" });
  await expect(disabledImportButton).toBeDisabled();
  await expect(disabledImportButton).toHaveCSS("cursor", "not-allowed");
});
