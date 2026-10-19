import { worldArchiveFixture } from "../support/worldArchiveFixture.ts";
import { expect as baseExpect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { V1Request } from "../../src/protocol/v1.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import {
  availableRuntimePort,
  RuntimeServerPool,
} from "../support/runtimeServer.ts";

const expect = baseExpect.configure({ timeout: 15_000 });

test("重新生成最新回复追加一次时间线修订，保留原文和旧端点，不重复提交玩家消息", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const root = await mkdtemp(join(tmpdir(), "narraeon-regenerate-"));
  const servers = new RuntimeServerPool();
  const providerRequests: string[] = [];
  const replies = [
    "第一段回复",
    "原来的第二段回复",
    "重新生成的第二段回复",
    "空输入续写回复",
  ];
  let finishRegeneration: (() => void) | undefined;
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      providerRequests.push(body);
      const text = replies[providerRequests.length - 1];
      if (text === undefined) {
        response.writeHead(500);
        response.end("Unexpected model request");
        return;
      }
      if (providerRequests.length === 3)
        finishRegeneration = () => sendNarrative(response, text);
      else sendNarrative(response, text);
    });
  });
  try {
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("No Provider port");
    const port = await availableRuntimePort();
    await servers.start(root, port);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Regeneration fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-secret",
        modelId: "regeneration-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const package_ = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.rename",
      packageId: package_.localId,
      name: "重新生成测试世界",
    });
    await runtime(page, {
      type: "content.replace",
      packageId: package_.localId,
      files: contentFiles(),
    });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: "regenerate-world",
      packageId: package_.localId,
      model: {
        provider: "chat_completions",
        modelId: "regeneration-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const worldId = created.world.worldId;
    const store = new FileNativeWorldStore(join(root, "data"));
    await page.reload();
    await page
      .getByRole("button", { name: "打开世界：重新生成测试世界", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "重新生成", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("你的行动").fill("第一次行动");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    await expect(page.getByText("第一段回复", { exact: true })).toBeVisible();
    const originalText = "第二次行动\n保留同一输入";
    await page.getByLabel("你的行动").fill(originalText);
    await page.getByRole("button", { name: "追加行动", exact: true }).click();
    await expect(
      page.getByText("原来的第二段回复", { exact: true }),
    ).toBeVisible();
    const regenerate = page.getByRole("button", {
      name: "重新生成",
      exact: true,
    });
    await expect(regenerate).toHaveCount(1);
    await expect(regenerate).toBeEnabled();
    const before = await store.readAuthorityHistory(worldId);
    expect(before.commits).toHaveLength(4);
    const firstReply = page
      .locator(".call-chain-assistant")
      .filter({ hasText: "第一段回复" });
    await expect(
      firstReply.getByRole("button", { name: "重新生成", exact: true }),
    ).toHaveCount(0);
    let dialogs = 0;
    page.on("dialog", async (dialog) => {
      dialogs += 1;
      await dialog.dismiss();
    });
    await page.getByLabel("你的行动").fill("仍未发送的行动草稿");
    await regenerate.click();
    await expect(
      page.getByText("正在重新生成…", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => finishRegeneration !== undefined).toBe(true);
    await expect(regenerate).toBeDisabled();
    finishRegeneration!();
    finishRegeneration = undefined;
    await expect(
      page.getByText("已重新生成；原回复已离开当前时间线", { exact: true }),
    ).toBeVisible();
    const timeline = page.getByLabel("故事时间线");
    await expect(timeline).toContainText("第一段回复");
    await expect(timeline).toContainText("重新生成的第二段回复");
    await expect(timeline).not.toContainText("原来的第二段回复");
    await expect(page.locator(".call-chain-player")).toHaveCount(2);
    await expect(page.getByLabel("你的行动")).toHaveValue("仍未发送的行动草稿");
    expect(dialogs).toBe(0);
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests[2]).toContain("第一段回复");
    expect(providerRequests[2]).not.toContain("原来的第二段回复");
    const sent = JSON.parse(providerRequests[2]!) as {
      messages: { role: string; content: unknown }[];
    };
    expect(
      sent.messages.filter(
        ({ role, content }) => role === "user" && content === originalText,
      ),
    ).toHaveLength(1);

    const after = await store.readAuthorityHistory(worldId);
    const added = after.commits.slice(before.commits.length);
    expect(added.map(({ mode }) => mode)).toEqual([
      "timeline_revision",
      "play",
    ]);
    expect(added[0]!.historyAppend).toEqual([
      expect.objectContaining({ role: "player", exactText: originalText }),
    ]);
    expect(added[1]!.historyAppend).toEqual([
      expect.objectContaining({
        role: "narrator",
        exactText: "重新生成的第二段回复",
      }),
    ]);
    expect(added[0]!.auditParent.head).toBe(before.head);
    expect(added[0]!.timelineParent.head).toBe(before.commits[1]!.head);
    const recovered = await store.recoverEndpoint(worldId, after.head);
    expect(
      recovered.history
        .filter(({ role }) => role === "player")
        .map(({ exactText }) => exactText),
    ).toEqual(["第一次行动", originalText]);
    const oldEndpoint = await store.recoverEndpoint(worldId, before.head);
    expect(oldEndpoint.history.at(-1)?.exactText).toBe("原来的第二段回复");
    const workspace = await runtime<{ worlds: { worldId: string }[] }>(page, {
      type: "workspace.read",
    });
    expect(workspace.worlds.map(({ worldId: id }) => id)).toEqual([worldId]);

    await page.reload();
    await expect(page).toHaveURL(/#\/world\//u);
    await expect(timeline).toContainText("重新生成的第二段回复");
    await expect(timeline).not.toContainText("原来的第二段回复");
    await expect(regenerate).toHaveCount(1);
    await page.getByLabel("你的行动").fill("");
    await page.getByRole("button", { name: "追加行动", exact: true }).click();
    await expect(
      page.getByText("空输入续写回复", { exact: true }),
    ).toBeVisible();
    await expect(regenerate).toHaveCount(0);
  } finally {
    finishRegeneration?.();
    await servers.stopAll();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("导入后无需新回合即可用全新上下文重新生成，并显示小于百分之一占用", async ({
  page,
}) => {
  test.setTimeout(120000);
  const source = await worldArchiveFixture();
  const root = await mkdtemp(join(tmpdir(), "narraeon-import-regenerate-"));
  const servers = new RuntimeServerPool();
  const requests: string[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      sendNarrative(response, "导入世界重新生成的回复");
    });
  });
  try {
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("No provider port");
    const port = await availableRuntimePort();
    await servers.start(root, port);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Import regeneration",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-secret",
        modelId: "local-model",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    await source.archives.exportWorld({
      worldId: source.worldId,
      operationId: "regenerate-import",
    });
    await page
      .getByLabel("世界备份 ZIP 文件")
      .setInputFiles(
        join(
          source.root,
          "world-archives/exports/regenerate-import/archive.zip",
        ),
      );
    await expect(
      page.getByText("世界备份已导入，新世界已加入列表。", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "打开世界：雨夜旅店", exact: true })
      .click();
    await expect(page.getByText("上下文 —", { exact: true })).toBeVisible();
    const regenerate = page.getByRole("button", {
      name: "重新生成",
      exact: true,
    });
    await expect(regenerate).toBeEnabled();
    await regenerate.click();
    const fallback = page.getByRole("button", {
      name: "用全新上下文重新生成",
      exact: true,
    });
    await expect(fallback).toBeVisible();
    await expect(
      page.getByText(
        "原上下文无法用于这次重新生成。可使用当前模型和预设，从同一条玩家输入开启全新上下文。",
        { exact: true },
      ),
    ).toBeVisible();
    expect(requests).toHaveLength(0);
    await fallback.click();
    await expect(
      page.getByText("已重新生成；原回复已离开当前时间线", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("导入世界重新生成的回复", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Alex抬起头，向你点头致意。", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".call-chain-player")).toHaveCount(1);
    await expect(page.getByText("上下文 <1%", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    const sent = JSON.parse(requests[0]!) as {
      messages: { role: string; content: unknown }[];
    };
    expect(
      sent.messages.filter(
        ({ role, content }) =>
          role === "user" && content === "我推开旅店的大门。",
      ),
    ).toHaveLength(1);
    expect(requests[0]).not.toContain("Alex抬起头，向你点头致意。");
  } finally {
    await servers.stopAll();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    await rm(root, { recursive: true, force: true });
    await rm(source.root, { recursive: true, force: true });
  }
});

function sendNarrative(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 20 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
  );
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  return page.evaluate(
    async ({ request: nextRequest }) => {
      const response = await fetch("/api/runtime/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "narraeon.runtime/v1",
          request: nextRequest,
        }),
      });
      const body = (await response.json()) as { result?: T; error?: unknown };
      if (!response.ok) throw new Error(JSON.stringify(body.error));
      return body.result as T;
    },
    { request },
  );
}

function contentFiles() {
  return [
    { path: "opening.md", contents: "Alex 等你开口。\n" },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: Current Situation\n  summary: Current scene\n  aliases: []\nSituation: Alex is waiting.\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents: "# World rules\n\nDo not act for the player.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}
