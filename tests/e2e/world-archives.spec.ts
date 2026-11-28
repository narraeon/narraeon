import { expect, type Page } from "@playwright/test";
import type {
  V1PlayCallChainView,
  V1PlayTimelinePage,
  V1Request,
} from "../../src/protocol/v1.ts";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "world-archives" });

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}

test("导入备份后，自动修改使用本机新对话，缺模型时保持原端点", async ({
  page,
}) => {
  const source = await worldArchiveFixture();
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"Alex welcomes you inside."}}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("No Provider port");
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
    const { worlds } = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const worldId = worlds.find((world) => world.title === title)!.worldId;
    const readHead = () =>
      runtime<{ head: string }>(page, { type: "world.read", worldId });
    const before = (await readHead()).head;
    await page
      .getByRole("button", { name: `打开世界：${title}`, exact: true })
      .click();
    const player = page.locator(".call-chain-player").filter({
      hasText: "我推开旅店的大门。",
    });
    const edit = async () => {
      await player
        .getByRole("button", { name: "玩家消息操作", exact: true })
        .click();
      await player.getByRole("button", { name: "修改", exact: true }).click();
    };
    await edit();
    await expect(
      player.getByText("这次修改需要开启新对话。请先配置模型，再保存修改。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      player.getByRole("button", { name: "保存修改并继续" }),
    ).toBeDisabled();
    const sourceChain = await runtime<V1PlayCallChainView>(page, {
      type: "play.chain.inspect",
      worldId,
    });
    const sourcePlayer = sourceChain.events.find(
      (event) => event.kind === "player",
    )!;
    const missingModel = await page.request.post("/api/runtime/v1", {
      data: {
        protocol: "narraeon.runtime/v1",
        request: {
          type: "play.chain.revise-player",
          operationId: "archive-review-without-model",
          worldId,
          chainId: sourceChain.chainId,
          eventId: sourcePlayer.id,
          replacementExchangeId: "archive-review-without-model-exchange",
          replacementText: "我敲了敲旅店的门。",
          continuation: "auto",
          sendAfterRevision: true,
        } satisfies V1Request,
      },
    });
    expect(missingModel.ok()).toBe(false);
    expect(await missingModel.text()).toContain("请先配置模型");
    expect((await readHead()).head).toBe(before);
    expect(providerRequests).toHaveLength(0);
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Archive revision Provider",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "archive-test-only",
        modelId: "archive-local-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8192,
      },
    });
    await page.reload();
    await edit();
    await player
      .locator("summary")
      .filter({ hasText: "修改后如何继续" })
      .click();
    await expect(
      player.getByRole("radio", { name: /接着原对话继续/ }),
    ).toBeDisabled();
    await expect(player.getByRole("radio", { name: /自动选择/ })).toBeChecked();
    const editor = page.locator(".history-player-edit");
    await editor.getByLabel("修改后的行动").fill("我敲了敲旅店的门。");
    const command = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/runtime/v1") &&
        request.method() === "POST" &&
        (request.postDataJSON() as { request: V1Request }).request.type ===
          "play.chain.revise-player",
    );
    await editor.getByRole("button", { name: "保存修改并继续" }).click();
    await expect(page.getByText("Alex welcomes you inside.")).toBeVisible();
    await expect(
      page.getByText("原对话无法继续，已开启新对话。"),
    ).toBeVisible();
    const after = (await readHead()).head;
    expect(after).not.toBe(before);
    const replay = await runtime<{
      continuation: string;
      playCallChain: V1PlayCallChainView;
    }>(
      page,
      ((await command).postDataJSON() as { request: V1Request }).request,
    );
    expect(replay.continuation).toBe("fresh_context");
    expect(replay.playCallChain.parentHead).toBe(after);
    expect((await readHead()).head).toBe(after);
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toContain("我敲了敲旅店的门。");
    expect(providerRequests[0]).not.toContain("Alex抬起头，向你点头致意。");
    await expect(
      page.getByText("我敲了敲旅店的门。", { exact: true }),
    ).toHaveCount(1);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    await rm(source.root, { recursive: true, force: true });
  }
});
for (const locale of ["zh-CN", "en"] as const) {
  test(`无模型时的世界备份下载、上传、恢复提示及世界管理导出 ${locale}`, async ({
    page,
  }, testInfo) => {
    await runtime(page, { type: "preferences.save", locale });
    const model = await runtime<ModelConnectionLibraryView>(page, {
      type: "model.read",
    });
    if (model.activeConnectionId !== null)
      await runtime(page, {
        type: "model.delete",
        connectionId: model.activeConnectionId,
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
    });
    const sourceTimeline = await runtime<V1PlayTimelinePage>(page, {
      type: "play.timeline.page",
      worldId: created.world.worldId,
      limit: 5,
    });
    expect(sourceTimeline.activeChainId).toBeNull();
    expect(sourceTimeline.items).toMatchObject([{ kind: "genesis" }]);
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
            story: "导出故事",
            backup: "世界备份",
            backupImport:
              "将世界保存为 ZIP，之后可在「我的世界」导入并继续游玩。",
            exportWorld: "导出世界备份",
            branch: "从这里开新分支",
            downloadStarted: "世界备份已开始下载。",
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
            story: "Export story",
            backup: "World backup",
            backupImport:
              "Save your world as a ZIP file. Import it from My worlds to keep playing.",
            exportWorld: "Export world backup",
            branch: "Branch from here",
            downloadStarted: "Your world backup download has started.",
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
    expect(
      await runtime<V1PlayTimelinePage>(page, {
        type: "play.timeline.page",
        worldId: imported!.worldId,
        limit: 5,
      }),
    ).toMatchObject({ activeChainId: null, items: sourceTimeline.items });
    // Remove the source, then open the one independent imported world bearing this name.
    await runtime(page, {
      type: "world.delete",
      worldId: created.world.worldId,
    });
    await page.reload();
    await page.getByRole("button", { name: text.open, exact: true }).click();
    await expect(page.getByText(text.note, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: text.manage, exact: true }).click();
    const management = page.getByRole("dialog", { name: text.manage });
    const backup = management.getByRole("article", { name: text.backup });
    const storyHeading = backup
      .locator("xpath=preceding-sibling::*[1]")
      .getByRole("heading");
    await expect(storyHeading).toHaveText(text.story);
    await expect(
      backup.locator("xpath=following-sibling::*[1]").getByRole("heading"),
    ).toHaveText(text.branch);
    await expect(backup.getByText(text.backupImport)).toBeVisible();
    const exportBackup = backup.getByRole("button", {
      name: text.exportWorld,
      exact: true,
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const [story, button] = await Promise.all([
        storyHeading.boundingBox(),
        exportBackup.boundingBox(),
      ]);
      expect(button!.x).toBeCloseTo(story!.x, 0);
    }
    const secondDownload = page.waitForEvent("download");
    await exportBackup.click();
    expect((await secondDownload).suggestedFilename()).toContain(
      ".narraeon-world.zip",
    );
    await expect(backup.getByRole("status")).toHaveText(text.downloadStarted);
    await expect(backup.getByText(text.description)).toBeVisible();
  });
}
