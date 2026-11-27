import { createServer, type Server } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { PlayRequestContext } from "../../src/protocol/playRequestContext.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "model-call-details" });

type Surface = "play" | "setting" | "revision";
const tools: Record<Surface, { name: string; parameters: object }> = {
  play: { name: "context_read", parameters: { ref: "@current-situation" } },
  setting: { name: "setting_read", parameters: { path: "opening.md" } },
  revision: {
    name: "world_revision_read",
    parameters: { path: "state/current-situation.yaml" },
  },
};
let provider: Server;
let providerUrl: string;
let surface: Surface;
let calls: number;
let releaseTool: (() => void) | undefined;
const finalText = "The requested file was read.";

test.beforeAll(async () => {
  provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = (value: object) =>
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`,
        );
      const finish = (input: number, output: number) =>
        response.end(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })}\n\ndata: [DONE]\n\n`,
        );
      if (++calls === 1) {
        const tool = tools[surface];
        delta({
          content: "I will read the file.",
          reasoning_content: "I need the current file first.",
          tool_calls: [
            {
              index: 0,
              id: "details-read",
              type: "function",
              function: { name: tool.name, arguments: "{" },
            },
          ],
        });
        releaseTool = () => {
          delta({
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify(tool.parameters).slice(1),
                },
              },
            ],
          });
          finish(31, 0);
        };
        response.on("close", () => {
          releaseTool = undefined;
        });
      } else {
        delta({ content: finalText });
        finish(42, 5);
      }
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture port");
  providerUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    provider.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
});

for (const kind of ["play", "setting", "revision"] as const) {
  test(`${kind} shows two calls with independent usage and retrieves only the opened context`, async ({
    page,
  }) => {
    surface = kind;
    calls = 0;
    await runtime(page, { type: "preferences.save", locale: "zh-CN" });
    const model = {
      provider: "chat_completions" as const,
      modelId: "details-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_096,
    };
    await runtime(page, {
      type: "model.save",
      connection: {
        ...model,
        name: "Details fixture",
        presetId: "custom",
        baseUrl: providerUrl,
        apiKey: "details-secret",
      },
    });
    const pack = await runtime<{ localId: string }>(page, {
      type: "content.create-sample",
      locale: "zh-CN",
    });
    const world =
      kind === "setting"
        ? null
        : (
            await runtime<{ world: { worldId: string } }>(page, {
              type: "world.create",
              operationId: "details-world",
              packageId: pack.localId,
              model,
            })
          ).world;
    const contexts: Promise<PlayRequestContext>[] = [];
    let timelineDetails = 0;
    page.on("response", (response) => {
      if (
        !response.url().endsWith("/api/runtime/v1") ||
        response.request().method() !== "POST"
      )
        return;
      const body = response.request().postDataJSON() as {
        request?: V1Request;
      } | null;
      if (body?.request?.type === "play.timeline.detail") timelineDetails++;
      if (!body?.request?.type.endsWith(".context")) return;
      contexts.push(
        response
          .json()
          .then((data: { result: PlayRequestContext }) => data.result),
      );
    });
    const open = async () => {
      await page.goto(
        kind === "setting"
          ? `/#/content/${pack.localId}`
          : `/#/world/${world!.worldId}`,
      );
      if (kind === "revision") {
        await page.getByRole("button", { name: "世界", exact: true }).click();
        await page.getByRole("button", { name: "修订当前世界" }).click();
      }
    };
    await open();
    if (kind === "play") {
      await page.getByRole("button", { name: "阅读设置" }).click();
      await page.getByRole("checkbox", { name: "显示技术信息" }).check();
      await page
        .getByLabel("阅读设置")
        .getByRole("button", { name: "关闭" })
        .click();
      await page.getByLabel("你的行动").fill("Read the file and reply.");
      await page.getByRole("button", { name: "从全新上下文发送行动" }).click();
    } else {
      await page
        .locator("#setting-conversation-input")
        .fill("Read the file and reply.");
      await page.getByRole("button", { name: "发送", exact: true }).click();
    }

    const group = page.locator(".model-call-details");
    await expect(group.locator(":scope > summary")).toContainText(
      "1 个模型步骤",
    );
    await group.locator(":scope > summary").click();
    const first = group.locator(".model-call").first();
    await expect(first.getByText("正在接收", { exact: true })).toBeVisible();
    // Before the first tool fragment, the same label is a noninteractive placeholder.
    const liveTools = first
      .locator("summary")
      .filter({ hasText: /^工具调用 · 0 次$/u });
    await expect(liveTools).toBeVisible();
    await liveTools.click();
    await expect(first.getByText("正在接收的工具调用片段")).toBeVisible();
    expect(contexts).toHaveLength(0);
    await expect.poll(() => releaseTool !== undefined).toBe(true);
    releaseTool?.();

    await expect(page.getByText(finalText, { exact: true })).toBeVisible();
    await expect(group.locator(":scope > summary")).toContainText(
      "2 个模型步骤",
    );
    await expect(first.getByText("已完成", { exact: true })).toBeVisible();
    const second = group.locator(".model-call").nth(1);
    await expect(
      first.getByText(/调用量详情 · 输入 31 · 输出 0 tokens/u),
    ).toBeVisible();
    await expect(
      second.getByText(/调用量详情 · 输入 42 · 输出 5 tokens/u),
    ).toBeVisible();
    await first.getByText(/调用量详情 · 输入 31/u).click();
    await expect(first.getByText("缓存写入", { exact: true })).toBeVisible();
    await expect(second.getByText("未返回", { exact: true })).toBeVisible();
    await expect(
      second.getByText("工具调用 · 0 次", { exact: true }),
    ).toBeVisible();
    const receipt = first.getByText(`调用 ${tools[kind].name}`, {
      exact: true,
    });
    if (!(await receipt.isVisible()))
      await first.getByText("工具调用 · 1 次", { exact: true }).click();
    await receipt.click();
    await expect(first.getByText("工具参数", { exact: true })).toBeVisible();
    await expect(
      first.getByText("Runtime 工具结果", { exact: true }),
    ).toBeVisible();
    expect(contexts).toHaveLength(0);

    await first.getByText("本次上下文", { exact: true }).click();
    await expect.poll(() => contexts.length).toBe(1);
    const initial = await contexts[0]!;
    expect(initial.status).toBe("available");
    expect(
      initial.messages.some(({ role }) => role === "tool · details-read"),
    ).toBe(false);
    await second.getByText("本次上下文", { exact: true }).click();
    await expect.poll(() => contexts.length).toBe(2);
    const continuation = await contexts[1]!;
    expect(continuation.status).toBe("available");
    expect(continuation.messages).toContainEqual({
      role: expect.stringContaining("tool · details-read"),
      text: expect.any(String),
    });
    expect(JSON.stringify([initial, continuation])).not.toContain(
      "details-secret",
    );

    await page.reload();
    if (
      kind === "revision" &&
      !(await page.locator("#setting-conversation-input").isVisible())
    )
      await open();
    await expect(page.getByText(finalText, { exact: true })).toBeVisible();
    const readsBeforeOpen = timelineDetails;
    const groupSummary = group.locator(":scope > summary");
    await groupSummary.focus();
    await page.keyboard.press("Enter");
    await expect(
      second.getByText(/调用量详情 · 输入 42 · 输出 5 tokens/u),
    ).toBeVisible();
    expect(contexts).toHaveLength(2);
    expect(timelineDetails).toBe(readsBeforeOpen);

    const context = first
      .locator("summary")
      .filter({ hasText: /^本次上下文$/u });
    const reasoning = first
      .locator("summary")
      .filter({ hasText: /^模型推理$/u });
    for (const [summary, loadedText] of [
      [context, /历史逻辑上下文/u],
      [reasoning, "I need the current file first."],
    ] as const) {
      const details = summary.locator("..");
      await expect(details).not.toHaveAttribute("open", "");
      const measure = () =>
        summary.evaluate((element) => {
          const details = element.parentElement!;
          const outer = details.getBoundingClientRect();
          return {
            height: outer.height,
            extra: outer.bottom - element.getBoundingClientRect().bottom,
          };
        });
      const initial = await measure();
      expect(initial.extra).toBeLessThanOrEqual(1);
      await expect(details).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await summary.focus();
      await page.keyboard.press("Space");
      await expect(details.getByText(loadedText)).toBeVisible();
      await page.keyboard.press("Space");
      await expect(details).not.toHaveAttribute("open", "");
      expect((await measure()).height).toBeCloseTo(initial.height);
    }
    expect(contexts).toHaveLength(3);
    expect(timelineDetails - readsBeforeOpen).toBe(kind === "play" ? 1 : 0);
    expect(calls).toBe(2);
  });
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
