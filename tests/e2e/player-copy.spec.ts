import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "player-copy" });

for (const locale of ["zh-CN", "en"] as const) {
  const en = locale === "en";
  const t = (zh: string, english: string) => (en ? english : zh);

  test(`${locale}: ZIP import creates an independent, same-name copy`, async ({
    page,
  }) => {
    await runtime(page, { type: "preferences.save", locale });
    const pack = await runtime<{ localId: string; title: string }>(page, {
      type: "content.create-sample",
      locale,
    });
    const archive = await runtime<{ base64: string }>(page, {
      type: "content.export",
      packageId: pack.localId,
    });
    const before = await runtime<{ treeRevision: string }>(page, {
      type: "content.read",
      packageId: pack.localId,
    });
    await page.goto("/#/");
    await page
      .getByText(t("导入内容包 ZIP", "Import content package ZIP"), {
        exact: true,
      })
      .click();
    await expect(
      page.getByText(
        t(
          "选择本应用导出或结构相同的内容包 ZIP。导入会创建独立副本，不会覆盖现有内容包。",
          "Choose a content package ZIP exported by this app or with the same structure. Importing creates an independent copy and leaves existing packages untouched.",
        ),
      ),
    ).toBeVisible();
    await page
      .getByLabel(t("内容包 ZIP 文件", "Content-package ZIP file"))
      .setInputFiles({
        name: pack.title + ".zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive.base64, "base64"),
      });
    await page
      .getByRole("button", { name: t("导入 ZIP", "Import ZIP"), exact: true })
      .click();
    await expect(
      page.getByText(
        t(
          "已将内容包导入为独立副本，现有内容包未被覆盖。",
          "The content package was imported as an independent copy. Existing packages were left untouched.",
        ),
        { exact: true },
      ),
    ).toBeVisible();
    const after = await runtime<{
      contentPackages: { localId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const matches = after.contentPackages.filter(
      ({ title }) => title === pack.title,
    );
    expect(matches).toHaveLength(2);
    expect(matches.map(({ localId }) => localId)).toContain(pack.localId);
    expect(
      await runtime(page, { type: "content.read", packageId: pack.localId }),
    ).toMatchObject({ treeRevision: before.treeRevision });

    await page.goto("/#/models");
    const models = page.getByRole("region", {
      name: t("模型连接", "Model connection"),
    });
    await expect(
      models.getByRole("heading", { name: t("模型连接", "Model connection") }),
    ).toBeVisible();
    await expect(models.locator(".config-header .eyebrow")).toHaveText(
      t("工作区设置", "Workspace settings"),
    );
    await page.goto("/#/presets");
    const presets = page.getByRole("region", {
      name: t("玩法预设工作台", "Play presets"),
    });
    await expect(presets).toBeVisible();
    await expect(presets.locator(".play-preset-header .eyebrow")).toHaveText(
      t("提示词编排", "Prompt orchestration"),
    );
  });

  test(`${locale}: read history, continue in a new chat, and resume generation`, async ({
    page,
  }) => {
    const firstRead = t("shen-he", "nora");
    const secondRead = t("lin-lan", "evelyn");
    const responses = [
      { ref: firstRead },
      { text: "Fixture first reply" },
      { ref: secondRead },
      { text: "Fixture second reply" },
      { text: "Fixture new-chat reply" },
      { text: "Fixture regenerated reply" },
      { text: "Fixture edited reply" },
    ];
    let calls = 0;
    const provider = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const next = responses[calls++];
        if (next === undefined) {
          response.writeHead(500).end("Unexpected model request");
          return;
        }
        const delta =
          "ref" in next
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "fixture-read-" + calls,
                    type: "function",
                    function: {
                      name: "context_read",
                      arguments: JSON.stringify({ ref: "@" + next.ref }),
                    },
                  },
                ],
              }
            : { content: next.text };
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
          );
      });
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = provider.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing local fixture port");
      const model = {
        provider: "chat_completions",
        modelId: "player-copy-model",
        contextWindowTokens: 64_000,
        maxOutputTokens: 4_096,
      } as const;
      const saveModel = async () => {
        const library = await runtime<{ activeConnectionId: string }>(page, {
          type: "model.save",
          connection: {
            ...model,
            name: "Player copy fixture",
            presetId: "custom",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "fixture-secret",
          },
        });
        return library.activeConnectionId;
      };
      await runtime(page, { type: "preferences.save", locale });
      let connectionId = await saveModel();
      const pack = await runtime<{ localId: string }>(page, {
        type: "content.create-sample",
        locale,
      });
      const { world } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: "player-copy-" + locale,
        packageId: pack.localId,
        model,
      });
      const worldUrl = `/#/world/${world.worldId}`;
      await page.goto(worldUrl);
      const story = page.getByLabel(t("故事时间线", "Story timeline"));
      const action = page.getByLabel(t("你的行动", "Your action"), {
        exact: true,
      });
      await action.fill("Fixture first action");
      await page
        .getByRole("button", {
          name: t("从全新上下文发送行动", "Send action from a fresh context"),
          exact: true,
        })
        .click();
      await expect(story.getByText("Fixture first reply")).toBeVisible();
      await action.fill("Fixture second action");
      await page
        .getByRole("button", {
          name: t("追加行动", "Append action"),
          exact: true,
        })
        .click();
      await expect(story.getByText("Fixture second reply")).toBeVisible();

      const openReads = async () => {
        await page
          .getByRole("button", {
            name: t("AI 读取", "Model reads"),
            exact: true,
          })
          .click();
        await page
          .getByRole("button", {
            name: t("展开完整读取记录", "Open the complete read record"),
          })
          .click();
        return page.getByRole("dialog", {
          name: t("AI 如何读取", "How the model reads"),
        });
      };
      const reading = await openReads();
      const readTable = reading.locator(".ai-reading-table").filter({
        has: page.getByRole("heading", {
          name: t(
            "AI 在这段对话中读过",
            "What the AI has read in this conversation",
          ),
          exact: true,
        }),
      });
      for (const title of [t("沈禾", "Nora"), t("林岚", "Evelyn")]) {
        await expect(
          readTable.getByText(title, { exact: true }).locator(".."),
        ).toContainText(t("精确全文", "Exact full document"));
      }
      await reading.getByRole("button", { name: t("关闭", "Close") }).click();
      await page
        .getByRole("button", { name: t("收起世界栏", "Close world panel") })
        .click();
      const mode = page.getByLabel(t("选择提交方式", "Choose submission mode"));
      await action.fill("Fixture new-chat action");
      await mode.click();
      const fresh = t(
        "用新对话继续（保留故事进度）",
        "Continue in a new chat (keep story progress)",
      );
      const start = page.getByRole("button", { name: fresh, exact: true });
      await expect(start.getByText(fresh, { exact: true })).toBeVisible();
      await start.click();
      await expect(story.getByText("Fixture new-chat reply")).toBeVisible();
      await expect(story.getByText("Fixture first reply")).toBeVisible();
      await expect(story.getByText("Fixture second reply")).toBeVisible();
      await expect(story.getByRole("separator")).toHaveCount(2);

      const append = t("追加当前上下文", "Append to current context");
      const recoveryCases = [
        {
          previousReply: "Fixture new-chat reply",
          nextReply: "Fixture regenerated reply",
          message: t(
            "原回复已从当前故事移除。",
            "The original reply was removed from the current story.",
          ),
        },
        {
          previousReply: "Fixture regenerated reply",
          nextReply: "Fixture edited reply",
          message: t("修改已保存。", "Your edit was saved."),
        },
      ];
      for (const [index, recovery] of recoveryCases.entries()) {
        await runtime(page, { type: "model.delete", connectionId });
        await page.reload();
        await expect(action).toBeDisabled();
        if (index === 0) {
          await story
            .getByRole("button", {
              name: t("重新生成", "Regenerate"),
              exact: true,
            })
            .click();
        } else {
          const player = story.locator(".call-chain-player").filter({
            hasText: "Fixture new-chat action",
          });
          await player
            .getByRole("button", { name: t("修改", "Edit"), exact: true })
            .click();
          await player
            .getByLabel(t("修改后的行动", "Edited action"))
            .fill("Fixture edited action");
          await story
            .getByRole("button", {
              name: t("保存修改并继续", "Save edit and continue"),
              exact: true,
            })
            .click();
        }
        const notice = page.locator(".world-feedback");
        await expect(notice).toContainText(recovery.message);
        await expect(notice).toContainText(
          t("将输入框留空", "leave the input empty"),
        );
        await expect(notice).toContainText(append);
        await expect(story.getByText(recovery.previousReply)).toHaveCount(0);
        const playCalls = calls;
        await page
          .getByRole("button", {
            name: t("配置模型", "Configure model"),
            exact: true,
          })
          .click();
        await expect(page).toHaveURL(/#\/models$/u);
        connectionId = await saveModel();
        await page.goto(worldUrl);
        await expect(action).toHaveValue("");
        await mode.click();
        const resume = page.getByRole("button", { name: append, exact: true });
        await expect(resume.getByText(append, { exact: true })).toBeVisible();
        await resume.click();
        await expect(story.getByText(recovery.nextReply)).toBeVisible();
        expect(calls).toBe(playCalls + 1);
        await expect(story.locator(".call-chain-player")).toHaveCount(3);
      }
      await expect(story.getByText("Fixture edited action")).toBeVisible();
      await runtime(page, { type: "model.delete", connectionId });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
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
