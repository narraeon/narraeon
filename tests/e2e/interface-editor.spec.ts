import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { V1Request } from "../../src/protocol/v1.ts";

test("纯界面编辑、草稿预览和游玩显示不增加模型调用，字段提交后更新", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let requests = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: requests === 1 ? { tool_calls: [{ index: 0, id: "update-field", type: "function", function: { name: "world_patch", arguments: JSON.stringify({ target: "@current-situation", edits: [{ op: "replace", locator: { yaml: ["Situation"] }, value: "Updated saved field 42" }] }) } }] } : { content: "Alex greets you." } }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing provider address");
  try {
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "Interface fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "interface-fixture",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const content = await runtime<{ localId: string }>(page, {
      type: "content.create",
    });
    await runtime(page, {
      type: "content.replace",
      packageId: content.localId,
      files: contentFiles(),
    });
    await runtime(page, {
      type: "content.rename",
      packageId: content.localId,
      name: `界面验证世界42-${Date.now()}`,
    });
    const created = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: `interface-world-${Date.now()}`,
      packageId: content.localId,
      model: {
        provider: "chat_completions",
        modelId: "interface-fixture",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    const worldId = created.world.worldId;
    const workspace = await runtime<{
      worlds: { worldId: string; title: string }[];
    }>(page, { type: "workspace.read" });
    const worldTitle = workspace.worlds.find(
      (world) => world.worldId === worldId,
    )!.title;
    await page.reload();
    await page.getByRole("button", { name: "预设", exact: true }).click();
    await page.getByText("预设管理", { exact: true }).click();
    await page
      .getByRole("button", { name: "复制推荐状态栏", exact: true })
      .click();
    await page.getByRole("tab", { name: /界面扩展/u }).click();
    await expect(page.getByText(/先在“调用链”新增后置请求/u)).toHaveCount(0);
    await page.getByLabel("玩家视图面板 1 标题").fill("未保存状态栏42");
    await page
      .getByLabel("玩家视图面板 1 显示位置")
      .selectOption("composer_above");
    await page
      .getByText("编辑资源 player-view-status.css", { exact: true })
      .click();
    await page
      .getByLabel("资源内容 player-view-status.css")
      .fill("body { color: rgb(120, 0, 120); }");
    await page.getByLabel("预览世界").selectOption(worldId);
    await page.getByRole("button", { name: "预览界面", exact: true }).click();
    const preview = page
      .locator(".interface-extension-preview")
      .frameLocator('iframe[title="current_view"]');
    await expect(
      preview.getByRole("heading", { name: "未保存状态栏42" }),
    ).toBeVisible();
    await expect(
      preview.getByText("Alex is folding a jersey.", { exact: true }),
    ).toBeVisible();
    await expect(preview.locator("body")).toHaveCSS(
      "color",
      "rgb(120, 0, 120)",
    );
    expect(requests).toBe(0);
    await page.getByLabel("玩家视图面板 1 标题").fill("已保存状态栏42");
    await expect(
      page.locator(".interface-extension-preview iframe"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page.getByRole("button", { name: "预览界面", exact: true }).click();
    await expect(
      preview.getByRole("heading", { name: "已保存状态栏42" }),
    ).toBeVisible();
    await page.getByText("预设操作", { exact: true }).click();
    await page
      .getByRole("button", { name: "停用 JavaScript", exact: true })
      .click();
    await expect(
      page.locator(".interface-extension-preview iframe"),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "启用 JavaScript", exact: true })
      .click();
    await expect(
      page.locator(".interface-extension-preview iframe"),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "新增玩家视图面板", exact: true })
      .click();
    await page.getByLabel("玩家视图面板 2 标题").fill("内置面板42");
    await page.getByLabel("玩家视图面板 2 视图").fill("other");
    const added = page.locator(".play-preset-player-panel-card").nth(1);
    await added.getByLabel("排列方式").selectOption("grid");
    await page.getByRole("button", { name: "预览界面", exact: true }).click();
    await expect(
      page
        .locator(".interface-extension-preview")
        .getByRole("heading", { name: "内置面板42", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-player-view-layout="grid"]')
        .getByText("Alex is folding a jersey.", { exact: true }),
    ).toBeVisible();
    await added.getByRole("button", { name: "删除面板", exact: true }).click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "应用为当前玩法", exact: true })
      .click();
    await page.goto("/");
    await page
      .getByRole("button", { name: `打开世界：${worldTitle}`, exact: true })
      .click();
    const panel = page
      .locator('[data-extension-mount="composer_above"]')
      .frameLocator('iframe[title="current_view"]');
    await expect(
      panel.getByRole("heading", { name: "已保存状态栏42" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "此刻", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "状态默认卡片", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "其他默认卡片", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "此刻", exact: true }).click();
    expect(requests).toBe(0);
    await page.getByLabel("你的行动").fill("Say hello.");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    await expect(
      page.getByText("Alex greets you.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "追加行动", exact: true }),
    ).toBeEnabled();
    // Only the main model tool response and final narration were dispatched.
    expect(requests).toBe(2);
    await expect(
      panel.getByText("Updated saved field 42", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole("button", { name: `打开世界：${worldTitle}`, exact: true })
      .click();
    await expect(
      panel.getByText("Updated saved field 42", { exact: true }),
    ).toBeVisible();
    expect(requests).toBe(2);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

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
    {
      path: "opening.md",
      contents:
        "The dormitory door closes behind you, and Alex waits for you to speak.\n",
    },
    {
      path: "world/current-situation.yaml",
      contents:
        "$document:\n  id: situation.current\n  ref: current-situation\n  title: Current Situation\n  summary: The current situation in the dormitory.\n  aliases: []\nSituation: Alex is folding a jersey.\n",
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: history, recent: 4 }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World rules\n\nKeep facts consistent and do not act for the player.\n",
    },
    {
      path: "control/player-views.yaml",
      contents:
        'format: narraeon.player-views/v1\nviews:\n  - id: status\n    title: 状态默认卡片\n    items:\n      - id: situation\n        label: 当前字段\n        select: { document: "@current-situation", locator: { yaml: [Situation] } }\n  - id: other\n    title: 其他默认卡片\n    items:\n      - id: other-item\n        label: 其他字段\n        select: { document: "@current-situation", locator: { yaml: [Situation] } }\n',
    },
  ];
}
