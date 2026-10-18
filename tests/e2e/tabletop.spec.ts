import { expect, test, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

test("跑团内容包在对话框选择判定方案，改方案后世界卡片显示新标签，互动式小说没有方案控件", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let tabletopPackageId: string | undefined;
  let fictionPackageId: string | undefined;
  let worldId: string | undefined;
  const model = {
    provider: "chat_completions" as const,
    modelId: "tabletop-browser",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
  };
  try {
    await runtime(page, { type: "preferences.save", locale: "zh-CN" });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Tabletop browser fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "fixture",
        modelId: model.modelId,
        contextWindowTokens: model.contextWindowTokens,
        maxOutputTokens: model.maxOutputTokens,
      },
    });
    await page.goto("/");

    await page.getByRole("button", { name: "新建内容包", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建内容包" });
    await expect(dialog.getByRole("group", { name: "判定方案" })).toHaveCount(
      0,
    );
    await dialog.getByRole("radio", { name: "跑团", exact: true }).check();
    const scheme = dialog.getByRole("group", { name: "判定方案" });
    await expect(scheme.getByRole("radio", { name: "d100" })).toBeChecked();
    await scheme.getByRole("radio", { name: "d20", exact: true }).check();
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime/v1") &&
        (
          response.request().postDataJSON() as {
            request?: { type?: string };
          } | null
        )?.request?.type === "content.create",
    );
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    const created = (await (await createdResponse).json()) as {
      result: { localId: string; title: string; gameplay: unknown };
    };
    tabletopPackageId = created.result.localId;
    const title = created.result.title;
    expect(created.result.gameplay).toEqual({
      mode: "tabletop",
      scheme: "d20",
    });
    await expect(dialog).toHaveCount(0);

    const gameplay = page.getByRole("region", { name: "玩法" });
    await expect(
      gameplay.getByText("跑团 · d20", { exact: true }),
    ).toBeVisible();
    await gameplay.getByRole("radio", { name: "混乱袋", exact: true }).check();
    await expect(
      gameplay.getByText("跑团 · 混乱袋", { exact: true }),
    ).toBeVisible();
    await expect(
      gameplay.getByRole("radio", { name: "混乱袋", exact: true }),
    ).toBeChecked();
    expect(
      (
        await runtime<{ gameplay: unknown }>(page, {
          type: "content.read",
          packageId: tabletopPackageId,
        })
      ).gameplay,
    ).toEqual({ mode: "tabletop", scheme: "bag" });

    await page.getByRole("button", { name: "创建世界", exact: true }).click();
    await expect
      .poll(async () => {
        const workspace = await runtime<{ worlds: { title: string }[] }>(page, {
          type: "workspace.read",
        });
        return workspace.worlds.some((world) => world.title === title);
      })
      .toBe(true);
    const workspace = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    worldId = workspace.worlds.find((world) => world.title === title)?.worldId;

    await page.goto("/");
    await expect(
      page.getByRole("button", { name: `打开内容包：${title}` }),
    ).toContainText("跑团 · 混乱袋");
    await expect(
      page.getByRole("button", { name: `打开世界：${title}` }),
    ).toContainText("跑团 · 混乱袋");

    await page.getByRole("button", { name: "新建内容包", exact: true }).click();
    const fictionDialog = page.getByRole("dialog", { name: "新建内容包" });
    await expect(
      fictionDialog.getByRole("group", { name: "判定方案" }),
    ).toHaveCount(0);
    const fictionResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime/v1") &&
        (
          response.request().postDataJSON() as {
            request?: { type?: string };
          } | null
        )?.request?.type === "content.create",
    );
    await fictionDialog
      .getByRole("button", { name: "创建", exact: true })
      .click();
    fictionPackageId = (
      (await (await fictionResponse).json()) as { result: { localId: string } }
    ).result.localId;
    const fictionGameplay = page.getByRole("region", { name: "玩法" });
    await expect(
      fictionGameplay.getByText("互动式小说", { exact: true }),
    ).toBeVisible();
    await expect(fictionGameplay.getByRole("radio")).toHaveCount(0);
  } finally {
    if (worldId !== undefined)
      await runtime(page, { type: "world.delete", worldId });
    for (const packageId of [tabletopPackageId, fictionPackageId])
      if (packageId !== undefined)
        await runtime(page, { type: "content.delete", packageId });
  }
});
