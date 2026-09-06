import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

test("A 工作台真实保存、独立三产物、正则、JS、导入及下一轮生产呈现", async ({
  page,
}) => {
  test.setTimeout(90000);
  let calls = 0;
  let names: string[] = [];
  const bodies: string[] = [];
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      bodies.push(body);
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta =
        calls === 1
          ? { content: "A45 narrative complete." }
          : {
              tool_calls: names.map((output, index) => ({
                index,
                id: `emit-${index}`,
                type: "function",
                function: {
                  name: "artifact_emit",
                  arguments: JSON.stringify({
                    output,
                    payload:
                      index === 0
                        ? "raw recap"
                        : index === 1
                          ? "second independent"
                          : [{ label: "Choose A45", prompt: "Draft A45 only" }],
                  }),
                },
              })),
            };
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  const evidence = "/tmp/narraeon-issue45-evidence";
  await mkdir(evidence, { recursive: true });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page.locator(".workspace-locale-picker select").selectOption("zh-CN");
    const created = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: `A45-${Date.now()}`,
    });
    await runtime(page, { type: "play.select", presetId: created.preset.id });
    await page.reload();
    await page.getByRole("button", { name: "预设", exact: true }).click();
    await page.getByRole("button", { name: "新增提示词", exact: true }).click();
    await page
      .getByLabel("提示词名称", { exact: true })
      .fill("雾港 · 叙事风格");
    await page
      .getByLabel("提示词正文", { exact: true })
      .fill(
        "用克制而有画面感的文字描写雾港。\n\n少解释，多呈现。每次叙事停在一个值得选择的时刻。",
      );
    await page.getByLabel("提示词正文", { exact: true }).blur();
    await page.screenshot({ path: `${evidence}/A-main.png`, fullPage: true });
    await page
      .getByRole("button", { name: "新增后置请求", exact: true })
      .click();
    await page.getByLabel("后置请求名称").fill("A45 多产物");
    await page.getByRole("button", { name: "界面产物", exact: true }).click();
    await page.getByLabel("产物名称", { exact: true }).fill("场景回顾");
    await page.getByLabel("生成内容用途").fill("回顾本轮已发生变化");
    await page
      .getByRole("button", { name: "新建 HTML 模板", exact: true })
      .click();
    await page
      .getByLabel("HTML", { exact: true })
      .fill("<h2>FIRST TEMPLATE</h2><!-- narraeon:content -->");
    await page.getByRole("button", { name: "新建规则集", exact: true }).click();
    await page
      .getByRole("button", { name: "新增正则规则", exact: true })
      .click();
    await page.getByLabel("查找", { exact: true }).fill("raw");
    await page.getByLabel("替换", { exact: true }).fill("rendered");
    await page.getByLabel("启用规则", { exact: true }).uncheck();
    await page.getByLabel("启用规则", { exact: true }).check();
    await page
      .getByRole("button", { name: "＋ 新增产物", exact: true })
      .click();
    await page.getByLabel("产物名称", { exact: true }).fill("第二份观察");
    await page.getByLabel("产物显示位置").selectOption("sidebar");
    await page
      .getByRole("button", { name: "新建 HTML 模板", exact: true })
      .click();
    await page
      .getByLabel("HTML", { exact: true })
      .fill("<h2>SECOND TEMPLATE</h2><!-- narraeon:content -->");
    await page
      .getByText("JavaScript 示例 · 新建独立产物", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "新建行动按钮示例", exact: true })
      .click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "应用为当前玩法", exact: true })
      .click();
    const library = await runtime<FileNativePlayPresetLibrary>(page, {
      type: "play.read",
    });
    const saved = library.presets.find((p) => p.id === created.preset.id)!;
    expect(saved.validation).toEqual({ status: "valid" });
    expect(saved.draft).toBeUndefined();
    const followup = saved.structure!.followups[0]!;
    names = followup.artifacts.map((a) => a.name);
    expect(names).toHaveLength(3);
    expect(followup.artifacts[0]!.displayName).toBe("场景回顾");
    expect(followup.artifacts[0]!.renderer).not.toBe(
      followup.artifacts[1]!.renderer,
    );
    await page.reload();
    await page.getByRole("button", { name: "预设", exact: true }).click();
    await page
      .getByRole("list", { name: "后置请求" })
      .getByRole("button", { name: /A45 多产物/ })
      .click();
    await page.getByRole("button", { name: "界面产物", exact: true }).click();
    await page
      .locator(".preset-output-cards")
      .getByRole("button", { name: /行动建议按钮/ })
      .click();
    await page.getByText("游玩效果预览 · 就地展开", { exact: true }).click();
    await page
      .getByRole("button", { name: "载入当前格式样例", exact: true })
      .click();
    await expect(page.getByText("样例校验通过", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "移除首个必填字段", exact: true })
      .click();
    await expect(page.getByText(/\$\[0\]\.label is required/)).toBeVisible();
    await page
      .getByLabel("示例输入", { exact: true })
      .fill('[{"label":"Preview A45","prompt":"Preview draft only"}]');
    const preview = page
      .locator(".preset-draft-preview")
      .frameLocator(`iframe[title="${names[2]}"]`);
    await preview.getByRole("button", { name: "Preview A45" }).click();
    await expect(page.getByLabel("本页输入草稿（尚未发送）")).toHaveValue(
      "Preview draft only",
    );
    await expect(
      preview.getByText("已填写草稿，尚未发送。", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(0);
    await page.getByLabel("预览禁交互状态").check();
    await expect(
      preview.getByRole("button", { name: "Preview A45" }),
    ).toBeDisabled();
    await page.screenshot({ path: `${evidence}/A-script.png`, fullPage: true });
    await page
      .locator(".preset-object-detail")
      .evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: `${evidence}/A-outputs.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({ path: `${evidence}/A-narrow.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Clone a complete request closure and keep its switch independent.
    await page
      .getByRole("button", { name: "克隆后置请求", exact: true })
      .click();
    await page.getByLabel("启用 A45 多产物 副本", { exact: true }).uncheck();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "应用为当前玩法", exact: true })
      .click();
    const clonedLibrary = await runtime<FileNativePlayPresetLibrary>(page, {
      type: "play.read",
    });
    const cloned = clonedLibrary.presets.find((p) => p.id === saved.id)!;
    expect(cloned.structure!.followups).toHaveLength(2);
    const copiedRequest = cloned.structure!.followups[1]!;
    expect(copiedRequest.id).not.toBe(followup.id);
    expect(copiedRequest.artifacts.map((a) => a.name)).toEqual(names);
    expect(copiedRequest.artifacts[0]!.renderer).not.toBe(
      followup.artifacts[0]!.renderer,
    );
    expect(cloned.files[copiedRequest.artifacts[0]!.renderer!]).toBe(
      saved.files[followup.artifacts[0]!.renderer!],
    );
    // Export and re-import through the actual browser file controls.
    await page.getByText("预设操作", { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出业务文件", exact: true }).click(),
    ]);
    const portable = await readFile(await download.path());
    await page.getByText("预设操作", { exact: true }).click();
    await page.getByText("预设管理", { exact: true }).click();
    await page.getByLabel("导入玩法预设文件").setInputFiles({
      name: "A45-import.play-preset.json",
      mimeType: "application/json",
      buffer: portable,
    });
    await expect(page.getByText(/玩法预设已导入为新的本地身份/)).toBeVisible();
    const imported = (
      await runtime<FileNativePlayPresetLibrary>(page, { type: "play.read" })
    ).presets.find(
      (p) =>
        p.name === "A45-import" &&
        !library.presets.some((old) => old.id === p.id),
    )!;
    expect(imported.scriptsEnabled).toBe(false);
    expect(imported.structure!.followups[0]!.artifacts).toEqual(
      followup.artifacts,
    );
    await runtime(page, { type: "play.select", presetId: saved.id });
    await runtime(page, {
      type: "model.save",
      connection: {
        name: "A45 fixture",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture",
        modelId: "a45",
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
      name: `A45 World ${saved.id}`,
    });
    await runtime(page, {
      type: "world.create",
      operationId: `a45-${Date.now()}`,
      packageId: content.localId,
      model: {
        provider: "chat_completions",
        modelId: "a45",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      },
    });
    await page.goto("/");
    await page
      .getByRole("button", {
        name: `打开世界：A45 World ${saved.id}`,
        exact: true,
      })
      .click();
    await page.getByLabel("你的行动").fill("Continue A45");
    await page
      .getByRole("button", { name: "从全新上下文发送行动", exact: true })
      .click();
    await expect(
      page.getByText("A45 narrative complete.", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator(`iframe[title="${names[0]}"]`)
        .getByText("rendered recap", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .frameLocator(`iframe[title="${names[1]}"]`)
        .getByText("second independent", { exact: true }),
    ).toBeVisible();
    await page
      .frameLocator(`iframe[title="${names[2]}"]`)
      .getByRole("button", { name: "Choose A45" })
      .click();
    await expect(page.getByLabel("你的行动")).toHaveValue("Draft A45 only");
    expect(calls).toBe(2);
    expect(bodies[1]).toContain("回顾本轮已发生变化");
    await page.screenshot({
      path: `${evidence}/A-production-play.png`,
      fullPage: true,
    });
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  return page.evaluate(async (request) => {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "narraeon.runtime/v1", request }),
    });
    const body = (await response.json()) as { result: T; error: unknown };
    if (!response.ok) throw new Error(JSON.stringify(body.error));
    return body.result;
  }, request);
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
