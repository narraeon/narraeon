import type { Page } from "@playwright/test";

export async function openWorkspaceCreationTool(
  page: Page,
  tool: "orchestrations" | "preview" = "orchestrations",
): Promise<void> {
  const nav = page.getByRole("navigation", {
    name: /^(工作区导航|Workspace navigation)$/u,
  });
  const mobile = nav.getByRole("button", { name: /^(切换页面|Switch page)$/u });
  if (await mobile.isVisible()) await mobile.click();
  await nav
    .getByRole("button", { name: /^(创作工具|Creation tools)$/u })
    .click();
  await nav
    .getByRole("button", {
      name:
        tool === "orchestrations"
          ? /^(编排方案|Orchestrations)$/u
          : /^(提示词预览|Prompt Preview)$/u,
    })
    .click();
}
