import { expect, test, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";
async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

test("导入旧玩家消息的修改默认采用本机全新上下文并禁用旧续传", async ({
  page,
}) => {
  const source = await worldArchiveFixture();
  try {
    const title = `Archive旧轨迹-${crypto.randomUUID().slice(0, 8)}`;
    await source.worlds.renameWorld(source.worldId, title);
    await source.archives.exportWorld({
      worldId: source.worldId,
      operationId: "browser-old-context",
    });
    await runtime(page, { type: "preferences.save", locale: "zh-CN" });
    await page.goto("/");
    await page
      .getByLabel("世界备份 ZIP 文件")
      .setInputFiles(
        join(
          source.root,
          "world-archives/exports/browser-old-context/archive.zip",
        ),
      );
    await expect(
      page.getByText("世界备份已导入，新世界已加入列表。", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("button", { name: `打开世界：${title}`, exact: true })
      .click();
    const player = page.locator(".call-chain-player").filter({
      hasText: "我推开旅店的大门。",
    });
    await player.getByRole("button", { name: "修改", exact: true }).click();
    await expect(
      player.getByRole("radio", { name: /沿原上下文继续/ }),
    ).toBeDisabled();
    await expect(
      player.getByRole("radio", { name: /作为全新上下文保存/ }),
    ).toBeChecked();
    await expect(
      player.getByText("此上下文来自备份；修改后须以本机选择开启全新上下文。", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await rm(source.root, { recursive: true, force: true });
  }
});
for (const locale of ["zh-CN", "en"] as const) {
  test(`世界备份浏览器下载、上传、恢复提示及世界管理导出 ${locale}`, async ({
    page,
  }, testInfo) => {
    await runtime(page, { type: "preferences.save", locale });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Archive test connection",
        presetId: "custom",
        provider: "chat_completions",
        dialect: "standard",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "archive-test-only",
        modelId: "archive-e2e-unused",
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
        reasoningEffort: "provider_default",
        reasoningSummary: "provider_default",
        thinkingMode: "provider_default",
        thinkingBudgetTokens: null,
      },
    });
    const title = `Archive旅店-${crypto.randomUUID().slice(0, 8)}`;
    const content = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.rename",
      packageId: content.localId,
      name: title,
    });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: `archive-world-${crypto.randomUUID()}`,
      packageId: content.localId,
      model: {
        provider: "chat_completions",
        modelId: "archive-e2e-unused",
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
      },
    });
    const before = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const text =
      locale === "zh-CN"
        ? {
            actions: `世界操作：${title}`,
            export: "导出备份",
            importFile: "世界备份 ZIP 文件",
            imported: "世界备份已导入，新世界已加入列表。",
            open: `打开世界：${title}`,
            manage: "世界管理",
            exportWorld: "导出世界备份",
            note: "世界从备份导入；下一次行动会从新上下文开始",
            description:
              "备份包含完整故事、世界文档和模型调用记录，不包含 API Key 和模型配置。",
          }
        : {
            actions: `World actions: ${title}`,
            export: "Export backup",
            importFile: "World backup ZIP file",
            imported:
              "World backup imported. The new world is now in your list.",
            open: `Open world: ${title}`,
            manage: "World management",
            exportWorld: "Export world backup",
            note: "World imported from backup; your next action will start a fresh context",
            description:
              "Backups include the complete story, world documents, and model call records. API keys and model configuration are excluded.",
          };
    await page.goto("/");
    await page.getByLabel(text.actions, { exact: true }).click();
    const downloaded = page.waitForEvent("download");
    const sourceCard = page.locator(".home-world-card-shell").filter({
      has: page.getByRole("button", { name: text.open, exact: true }),
    });
    await sourceCard
      .getByRole("button", { name: text.export, exact: true })
      .click();
    const archive = await downloaded;
    expect(archive.suggestedFilename()).toContain(".narraeon-world.zip");
    const path = testInfo.outputPath("world.narraeon-world.zip");
    await archive.saveAs(path);
    await expect(
      page.getByText(text.description, { exact: true }),
    ).toBeVisible();
    await page.getByLabel(text.importFile).setInputFiles(path);
    await expect(page.getByText(text.imported, { exact: true })).toBeVisible({
      timeout: 30000,
    });
    const after = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const imported = after.worlds.find(
      (world) => !before.worlds.some((old) => old.worldId === world.worldId),
    );
    expect(imported?.title).toBe(title);
    expect(imported?.worldId).not.toBe(created.world.worldId);
    // Remove the source, then open the one independent imported world bearing this name.
    await runtime(page, {
      type: "world.delete",
      worldId: created.world.worldId,
    });
    await page.reload();
    await page.getByRole("button", { name: text.open, exact: true }).click();
    await expect(page.getByText(text.note, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: text.manage, exact: true }).click();
    const secondDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: text.exportWorld, exact: true })
      .click();
    expect((await secondDownload).suggestedFilename()).toContain(
      ".narraeon-world.zip",
    );
  });
}
