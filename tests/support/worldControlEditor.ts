import { expect, type Locator } from "@playwright/test";
import type { AppLocale } from "../../src/protocol/appPreferences.ts";

export const worldRulesPath = "control/blocks/world.md";

export async function selectControlFile(
  dialog: Locator,
  path: string,
  locale: AppLocale = "zh-CN",
): Promise<void> {
  await dialog
    .getByRole("combobox", {
      name: locale === "en" ? "Choose control file" : "选择控制文件",
      exact: true,
    })
    .selectOption(path);
}

export function rawControlFile(
  dialog: Locator,
  path: string,
  locale: AppLocale = "zh-CN",
): Locator {
  return dialog.getByRole("textbox", {
    name: locale === "en" ? `Edit ${path}` : `编辑 ${path}`,
    exact: true,
  });
}

export async function openFrameSource(
  dialog: Locator,
  locale: AppLocale = "zh-CN",
): Promise<Locator> {
  const english = locale === "en";
  await selectControlFile(dialog, "control/frame.yaml", locale);
  const source = dialog.getByRole("textbox", {
    name: english
      ? "Edit control/frame.yaml directly"
      : "直接编辑 control/frame.yaml",
    exact: true,
  });
  if (!(await source.isVisible())) {
    await dialog
      .getByText(
        english ? "Source view (frame.yaml)" : "源码视图（frame.yaml）",
        {
          exact: true,
        },
      )
      .click();
  }
  await expect(source).toBeVisible();
  return source;
}
