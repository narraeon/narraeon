import { expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

let provider: Server;
let providerUrl: string;
let exchange = 0;
const opening = "门外传来脚步。\n\n窗户仍敞着。\n";
const player = "我推开门。\n\n再停下来。";
const narrator = "门外没有人。\n\n你听见一声鸟鸣。";

test.use({ runtimeScope: "story-export" });

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      exchange += 1;
      const delta =
        exchange % 2 === 1
          ? {
              content: "工具中间正文，不导出。",
              reasoning_content: "返回推理，不导出。",
              tool_calls: [
                {
                  index: 0,
                  id: "checkpoint",
                  type: "function",
                  function: {
                    name: "world_checkpoint",
                    arguments: "{}",
                  },
                },
              ],
            }
          : { content: narrator };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 20 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Provider port missing");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

for (const locale of ["zh-CN", "en"] as const) {
  test(`世界管理下载两种完整故事，排除工具、推理、检查点与 usage：${locale}`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Story export fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: providerUrl,
        apiKey: "fixture",
        modelId: "story-export-fixture",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const package_ = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    const title = `雾港:${locale}`;
    await runtime(page, {
      type: "content.rename",
      packageId: package_.localId,
      name: title,
    });
    const contents = await runtime<{ files: ContentTreeFile[] }>(page, {
      type: "content.read",
      packageId: package_.localId,
    });
    await runtime(page, {
      type: "content.replace",
      packageId: package_.localId,
      files: contents.files.map((file) =>
        file.path === "opening.md" ? { ...file, contents: opening } : file,
      ),
    });
    await runtime(page, {
      type: "world.create",
      operationId: `story-export-${locale}`,
      packageId: package_.localId,
      model: {
        provider: "chat_completions",
        modelId: "story-export-fixture",
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    const exportedRequests: unknown[] = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/runtime/v1")) return;
      const body = request.postDataJSON() as { request?: { type?: string } };
      if (body.request?.type === "world.story.export")
        exportedRequests.push(body);
    });
    await page.goto("/");
    await page
      .getByRole("button", {
        name:
          locale === "zh-CN" ? `打开世界：${title}` : `Open world: ${title}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: locale === "zh-CN" ? "世界管理" : "World management",
        exact: true,
      })
      .click();
    const management = page.getByRole("dialog", {
      name: locale === "zh-CN" ? "世界管理" : "World management",
    });
    expect(exportedRequests).toHaveLength(0);
    const openingDownload = page.waitForEvent("download");
    await management
      .getByRole("button", {
        name: locale === "zh-CN" ? "导出纯文本" : "Export plain text",
        exact: true,
      })
      .click();
    const genesisFile = await openingDownload;
    expect(genesisFile.suggestedFilename()).toBe(`雾港${locale}.txt`);
    expect(await readFile(await genesisFile.path(), "utf8")).toBe(
      `${title}\n\n${opening}`,
    );
    await management
      .getByRole("button", {
        name: locale === "zh-CN" ? "关闭" : "Close",
        exact: true,
      })
      .click();
    await page
      .getByLabel(locale === "zh-CN" ? "你的行动" : "Your action", {
        exact: true,
      })
      .fill(player);
    await page
      .getByRole("button", {
        name:
          locale === "zh-CN"
            ? "从全新上下文发送行动"
            : "Send action from a fresh context",
        exact: true,
      })
      .click();
    await expect(page.getByText(narrator, { exact: true })).toBeVisible();
    await page
      .getByRole("button", {
        name: locale === "zh-CN" ? "世界管理" : "World management",
        exact: true,
      })
      .click();
    for (const format of ["markdown", "text"] as const) {
      const downloaded = page.waitForEvent("download");
      const label =
        format === "markdown"
          ? locale === "zh-CN"
            ? "导出 Markdown"
            : "Export Markdown"
          : locale === "zh-CN"
            ? "导出纯文本"
            : "Export plain text";
      await management
        .getByRole("button", { name: label, exact: true })
        .click();
      const file = await downloaded;
      expect(file.suggestedFilename()).toBe(
        `雾港${locale}.${format === "markdown" ? "md" : "txt"}`,
      );
      const playerLabel = locale === "zh-CN" ? "我" : "Me";
      const colon = locale === "zh-CN" ? "：" : ": ";
      const playerBlock =
        format === "markdown"
          ? `> **${playerLabel}**${colon}我推开门。\n> \n> 再停下来。`
          : `${playerLabel}${colon}${player}`;
      expect(await readFile(await file.path(), "utf8")).toBe(
        `${format === "markdown" ? "# " : ""}${title}\n\n${opening}\n\n${playerBlock}\n\n${narrator}`,
      );
    }
    expect(exportedRequests).toHaveLength(3);
  });
}

async function runtime<T>(page: Page, request: V1Request): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
