import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
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
    await page.goto("/#/orchestrations");
    const presets = page.getByRole("region", {
      name: t("编排方案工作台", "Orchestrations"),
    });
    await expect(presets).toBeVisible();
    await expect(presets.locator(".play-preset-header .eyebrow")).toHaveText(
      t("提示词编排", "Prompt orchestration"),
    );
  });

  test(`${locale}: read history, continue in a new chat, and resume generation`, async ({
    page,
  }) => {
    const firstRead = t("@shen-he", "@nora");
    const secondRead = t("@lin-lan", "@evelyn");
    const unlistedTitle = t("测试用未列出文档", "Unlisted fixture document");
    const failedRead = "@fixture-unlisted#/missing";
    const responses = [
      { ref: firstRead },
      { text: "Fixture first reply" },
      { ref: secondRead },
      { ref: failedRead },
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
                      arguments: JSON.stringify({ ref: next.ref }),
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
      const { files, treeRevision } = await runtime<{
        files: ContentTreeFile[];
        treeRevision: string;
      }>(page, {
        type: "content.read",
        packageId: pack.localId,
      });
      await runtime(page, {
        type: "content.replace",
        packageId: pack.localId,
        baseTreeRevision: treeRevision,
        files: [
          ...files,
          {
            path: "world/notes/unlisted.yaml",
            contents: [
              "$document:",
              "  id: note.fixture-unlisted",
              "  ref: fixture-unlisted",
              "  title: " + unlistedTitle,
              "  summary: A document outside the configured catalogs.",
              "  aliases: []",
              "description: Available only through an explicit read.",
            ].join("\n"),
          },
        ],
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
      const readsButton = page.getByRole("button", {
        name: t("AI 读取", "Model reads"),
        exact: true,
      });
      const readDialog = page.getByRole("dialog", {
        name: t("AI 如何读取", "How the model reads"),
      });
      const showReadDialog = async () => {
        await page
          .getByRole("button", {
            name: t("展开完整读取记录", "Open the complete read record"),
          })
          .click();
      };
      const closeReads = async () => {
        await readDialog
          .getByRole("button", { name: t("关闭", "Close") })
          .click();
        await page
          .getByRole("button", { name: t("收起世界栏", "Close world panel") })
          .click();
      };
      const releaseReading = Promise.withResolvers<void>();
      await page.route("**/api/runtime/v1", async (route) => {
        const { request } = route.request().postDataJSON() as {
          request?: V1Request;
        };
        if (request?.type === "world.play-context.read")
          await releaseReading.promise;
        await route.fallback();
      });
      await readsButton.click();
      try {
        await expect(
          page.getByText(
            t(
              "正在检查 AI 读过的世界文档…",
              "Checking which world files the AI read…",
            ),
            { exact: true },
          ),
        ).toBeVisible();
      } finally {
        releaseReading.resolve();
      }
      await showReadDialog();
      await expect(
        readDialog
          .locator(".ai-reading-flow")
          .getByText(t("暂无当前对话记录", "No current conversation record"), {
            exact: true,
          }),
      ).toBeVisible();
      await closeReads();
      await page.unroute("**/api/runtime/v1");
      expect(calls).toBe(0);

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

      await readsButton.click();
      await showReadDialog();
      const reading = readDialog;
      const readLabel = t(
        "AI 在这段对话中读过",
        "What the AI has read in this conversation",
      );
      const readCard = reading
        .locator(".ai-reading-flow")
        .getByRole("article")
        .filter({
          has: page.getByText(t("按需读取", "On-demand reads"), {
            exact: true,
          }),
        });
      await expect(
        readCard.getByText(readLabel, { exact: true }),
      ).toBeVisible();
      await expect(
        readCard.getByText(t("2 次成功记录", "2 successful reads"), {
          exact: true,
        }),
      ).toBeVisible();
      const documentTable = (title: string) =>
        reading.locator(".ai-reading-table").filter({
          has: page.getByRole("heading", { name: title, exact: true }),
        });
      const latest = documentTable(
        t("最近一次请求材料", "Latest request materials"),
      );
      const next = documentTable(
        t("下次发送的世界内容预览", "World content preview for the next send"),
      );
      const cumulative = documentTable(readLabel);
      await expect(
        reading.getByText(t("发送与读取记录", "Send and read records"), {
          exact: true,
        }),
      ).toBeVisible();
      await expect(reading.locator(".ai-reading-caveat")).toHaveText(
        t(
          "记录显示实际发给模型的内容和工具返回的结果，无法确认模型记住了什么或会怎么做。",
          "The records show what was sent to the model and what tools returned. They cannot tell you what the model remembers or how it will respond.",
        ),
      );
      for (const title of [t("沈禾", "Nora"), t("林岚", "Evelyn")]) {
        await expect(
          cumulative.getByText(title, { exact: true }).locator(".."),
        ).toContainText(t("精确全文", "Exact full document"));
        await expect(
          latest
            .getByText(title, { exact: true })
            .locator("..")
            .getByText(t("全文", "Full document"), { exact: true }),
        ).toBeVisible();
      }
      const catalogTitle = t("柜台上的托付", "A letter left for safekeeping");
      await expect(
        latest.getByText(catalogTitle, { exact: true }).locator(".."),
      ).toContainText(t("标题 + 摘要", "Title + summary"));
      const inn = t("雨灯旅店", "Rain Lantern Inn");
      await expect(
        next.getByText(inn, { exact: true }).locator(".."),
      ).toContainText(
        t(
          "列在下次发送的预览材料中",
          "Listed in the next send preview materials",
        ),
      );
      for (const [table, detail] of [
        [
          latest,
          t(
            "最近一次请求的材料未列出这份文档",
            "This document is absent from the latest request materials",
          ),
        ],
        [
          next,
          t(
            "下次发送的预览未列出这份文档",
            "This document is absent from the next send preview",
          ),
        ],
        [
          cumulative,
          t(
            "这段对话的请求材料未列出这份文档，也没有成功读取记录",
            "This document is absent from the conversation’s request materials, and no successful read was recorded",
          ),
        ],
      ] as const) {
        await expect(
          table.getByText(unlistedTitle, { exact: true }).locator(".."),
        ).toContainText(detail);
      }
      await reading
        .getByText(
          t(
            "查看按需读取返回的完整记录",
            "View complete records returned by on-demand reads",
          ),
          { exact: true },
        )
        .click();
      await expect(
        reading.getByRole("heading", { name: failedRead }).locator(".."),
      ).toContainText(t("读取失败", "Read failed"));
      await closeReads();
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

      const callsBeforeManagement = calls;
      const readWorld = (worldId: string) =>
        runtime<{ head: string }>(page, { type: "world.read", worldId });
      const { head } = await readWorld(world.worldId);
      const readControl = (worldId: string, head: string) =>
        runtime<ContentTreeFile[]>(page, {
          type: "world.surface.read",
          worldId,
          surface: "control",
          head,
        });
      const control = await readControl(world.worldId, head);
      const changedControl = control.map((file) =>
        file.path === "frame.yaml"
          ? { ...file, contents: file.contents + "\n# Copy verification\n" }
          : file,
      );
      expect(changedControl).not.toEqual(control);
      await page
        .getByRole("button", {
          name: t("世界管理", "World management"),
          exact: true,
        })
        .click();
      const management = page.getByRole("dialog", {
        name: t("世界管理", "World management"),
      });
      const branch = management.getByRole("heading", {
        name: t("从这里开新分支", "Branch from here"),
      });
      await expect(branch).toBeVisible();
      await management
        .getByText(
          t("世界控制 · 高级编辑", "World control · Advanced editor"),
          { exact: true },
        )
        .click();
      await expect(
        management.getByText(
          t(
            "世界控制修改需先预览，再一次性应用。",
            "Preview world-control changes before applying them together.",
          ),
          { exact: true },
        ),
      ).toBeVisible();
      const controlInput = management.getByLabel(
        t("世界控制文件（JSON）", "World-control files (JSON)"),
      );
      await expect(controlInput).toHaveValue(JSON.stringify(control, null, 2));
      await controlInput.fill(JSON.stringify(changedControl, null, 2));
      const apply = management.getByRole("button", {
        name: t("整批应用世界控制", "Apply all world-control changes"),
      });
      await expect(apply).toBeDisabled();
      await management
        .getByRole("button", {
          name: t("预览世界控制", "Preview world control"),
        })
        .click();
      await expect(page.locator(".world-feedback")).toContainText(
        t(
          "世界控制修改已预览，可以一次性应用。",
          "World-control changes have been previewed and can now be applied together.",
        ),
      );
      await expect(apply).toBeEnabled();
      await expect(
        management.getByText(t("有尚未应用的修改", "Unapplied changes")),
      ).toBeVisible();
      expect((await readWorld(world.worldId)).head).toBe(head);
      await apply.click();
      await expect(page.locator(".world-feedback")).toContainText(
        t("世界控制已整批应用。", "World control was applied as a whole."),
      );
      const applied = await readWorld(world.worldId);
      expect(applied.head).not.toBe(head);
      expect(await readControl(world.worldId, applied.head)).toEqual(
        changedControl,
      );
      const forkResponse = page.waitForResponse((response) => {
        const request = response.request();
        return (
          request.url().endsWith("/api/runtime/v1") &&
          request.method() === "POST" &&
          (request.postDataJSON() as { request?: V1Request }).request?.type ===
            "world.derive"
        );
      });
      await branch
        .locator("../..")
        .getByRole("button", {
          name: t("创建分叉", "Create fork"),
        })
        .click();
      const { result } = (await (await forkResponse).json()) as {
        result: { world: { worldId: string } };
      };
      const forkId = result.world.worldId;
      expect(forkId).not.toBe(world.worldId);
      await expect(page).toHaveURL(new RegExp(`/#/world/${forkId}$`, "u"));
      expect(await readControl(forkId, (await readWorld(forkId)).head)).toEqual(
        changedControl,
      );
      expect((await readWorld(world.worldId)).head).toBe(applied.head);
      expect(calls).toBe(callsBeforeManagement);
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
