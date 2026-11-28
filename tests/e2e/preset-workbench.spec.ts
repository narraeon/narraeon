import { openWorkspaceCreationTool } from "../support/workspaceNavigation.ts";
import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";

test("orchestration reveals prompt status and highlights the available draft action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const { preset } = await runtime<{ preset: { id: string } }>(page, {
    type: "play.create",
    name: "状态复核",
  });
  await runtime(page, {
    type: "play.scripts",
    presetId: preset.id,
    enabled: false,
  });
  await runtime(page, { type: "play.select", presetId: preset.id });
  await page.goto(`/#/orchestrations/${preset.id}`);

  const editor = page.getByRole("region", { name: "编排方案编辑器" });
  const prompt = page
    .locator(".ordered-play-editor li")
    .filter({
      hasText: "仅跑团",
    })
    .first();
  const save = page.getByRole("button", { name: "保存修改", exact: true });
  const apply = page.getByRole("button", { name: "应用为当前编排方案" });
  const quietFooter = editor.locator("footer.is-quiet");
  const primaryFill = "rgb(52, 56, 50)";
  const library = () =>
    runtime<FileNativePlayPresetLibrary>(page, { type: "play.read" });
  const revisionBefore = (await library()).presets.find(
    ({ id }) => id === preset.id,
  )?.revision;

  await expect(quietFooter).toBeVisible();
  expect((await quietFooter.boundingBox())!.height).toBeLessThan(40);
  await expect(editor.getByText("当前编排方案", { exact: true })).toBeVisible();
  await expect(
    editor.getByText("JavaScript 已停用", { exact: true }),
  ).toBeVisible();
  await expect(prompt.getByText("仅跑团", { exact: true })).toBeVisible();
  await expect(prompt.locator(".ordered-play-category")).toBeVisible();
  await prompt.getByRole("checkbox").uncheck();
  await expect(prompt.getByRole("checkbox")).not.toBeChecked();
  await expect(prompt.getByText("已停用", { exact: true })).toBeVisible();
  await expect(editor.getByText("草稿尚未保存", { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(save).toHaveCSS("background-color", primaryFill);
  await expect(apply).toBeDisabled();
  await save.click();
  await expect(
    editor.getByText("草稿已保存，待应用", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(save).not.toHaveCSS("background-color", primaryFill);
  await expect(apply).toBeEnabled();
  await expect(apply).toHaveCSS("background-color", primaryFill);
  const saved = (await library()).presets.find(({ id }) => id === preset.id)!;
  expect(saved.revision).toBe(revisionBefore);
  expect(saved.draft).toBeDefined();
  await apply.click();
  await expect(quietFooter).toBeVisible();
  expect(
    (await library()).presets.find(({ id }) => id === preset.id)?.revision,
  ).toBe(saved.draft?.revision);

  await page.setViewportSize({ width: 1440, height: 844 });
  await page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u })
    .click();
  await page.getByRole("button", { name: "停用编排方案", exact: true }).click();
  await expect(
    editor
      .locator(".play-preset-editor-badges")
      .getByText("已停用", { exact: true }),
  ).toBeVisible();
  await expect(editor.getByText("非当前方案", { exact: true })).toBeVisible();
  await expect(apply).toBeDisabled();
  await expect(apply).not.toHaveCSS("background-color", primaryFill);
});

test("orchestration AI leaves usable editing width and closes from every view", async ({
  page,
}) => {
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  await page.goto("/#/orchestrations");

  const launch = page.getByRole("button", { name: "AI 编辑", exact: true });
  const close = page.getByRole("button", { name: "关闭 AI 编辑", exact: true });
  const views = page.getByRole("navigation", { name: "编排编辑视图" });
  const editor = page.locator(".ordered-play-content");
  const ai = page.getByRole("region", { name: "编排方案 AI 编辑" });
  await page.getByRole("button", { name: "新增提示词", exact: true }).click();
  const body = page.getByRole("textbox", { name: "提示词正文", exact: true });
  await body.fill("在三个视图间切换后保留这段草稿。");
  for (const width of [1101, 1100, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ["编排", "对话", "改动"]) {
      await launch.click();
      const button = views.getByRole("button", { name: view, exact: true });
      await button.click();
      if (view === "编排") {
        await expect(editor).toBeVisible();
        expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(
          width === 390 ? 320 : 550,
        );
      }
      await expect(close).toBeVisible();
      await close.press("Enter");
      await expect(ai).toHaveCount(0);
      await expect(editor).toBeVisible();
      await expect(launch).toBeFocused();
      await expect(body).toHaveValue("在三个视图间切换后保留这段草稿。");
    }
  }

  await page.setViewportSize({ width: 1360, height: 844 });
  await launch.click();
  await expect(ai).toBeVisible();
  await expect(views).toBeHidden();
  expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(550);
  const workspace = page.getByRole("region", { name: "编排方案编辑器" });
  await workspace.evaluate((element) => {
    element.style.maxWidth = "1000px";
  });
  await views.getByRole("button", { name: "编排", exact: true }).click();
  await expect(ai).toBeHidden();
  expect((await body.boundingBox())!.width).toBeGreaterThanOrEqual(550);
});

test("retained resources open in the file editor and keep draft and export semantics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const library = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const base = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  )!;
  const path = "assets/unbound.css";
  const otherPath = "assets/notes.txt";
  const initial = "body { color: green; }\n";
  const edited = "body { color: navy; }\n";
  const { preset } = await runtime<{ preset: { id: string } }>(page, {
    type: "play.import",
    name: "未绑定资源复核",
    files: Object.entries({
      ...base.files,
      [path]: initial,
      [otherPath]: "notes\n",
    }).map(([path, contents]) => ({ path, contents })),
  });
  await page.goto(`/#/orchestrations/${preset.id}`);
  const actions = page
    .locator("summary")
    .filter({ hasText: /^编排方案操作$/u });
  await actions.press("Enter");
  await page
    .getByRole("button", { name: "保留的资源", exact: true })
    .press("Enter");
  const files = page.getByRole("tabpanel", { name: "完整编排方案文件" });
  await expect(page.locator(".play-preset-operations")).toHaveJSProperty(
    "open",
    false,
  );
  await expect(
    files.getByRole("heading", { name: "完整编排方案文件" }),
  ).toBeFocused();
  const selector = files.getByRole("combobox", { name: "编排方案文件" });
  await selector.selectOption(path);
  const source = files.getByRole("textbox", {
    name: `编辑编排方案文件 ${path}`,
  });
  await expect(source).toHaveValue(initial);
  expect((await source.boundingBox())!.width).toBeGreaterThanOrEqual(340);
  await source.fill(edited);
  await selector.selectOption(otherPath);
  await selector.selectOption(path);
  await expect(source).toHaveValue(edited);
  await page.setViewportSize({ width: 1440, height: 844 });
  await files
    .getByRole("button", { name: `打开编排方案文件 ${otherPath}` })
    .click();
  await files.getByRole("button", { name: `打开编排方案文件 ${path}` }).click();
  await expect(source).toHaveValue(edited);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("编排方案已保存。", { exact: true }),
  ).toBeVisible();

  const saved = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  expect(saved.currentPresetId).toBe(library.currentPresetId);
  expect(
    saved.presets.find(({ id }) => id === preset.id)?.draft?.files[path],
  ).toBe(edited);
  await actions.click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出已保存草稿", exact: true })
    .click();
  expect(await readFile(await (await downloaded).path(), "utf8")).toContain(
    "body { color: navy; }",
  );
});

test("orchestration management opens within the viewport and restores keyboard focus", async ({
  page,
}) => {
  // Set up the route and locale before the browser reads the workspace.
  await runtime(page, { type: "preferences.save", locale: "en" });
  const name =
    "Fogbell Harbor tabletop orchestration for the lighthouse, guild records, and coastal investigations";
  const { preset } = await runtime<{ preset: { id: string } }>(page, {
    type: "play.create",
    name,
  });
  await page.goto(`/#/orchestrations/${preset.id}`);
  const opener = page.getByText("Manage orchestrations", {
    exact: true,
  });
  const menu = page.getByRole("region", {
    name: "Create and import orchestrations",
  });
  for (const width of [390, 800, 801, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole("combobox", { name: "Switch orchestration" }),
    ).toHaveValue(preset.id);
    await opener.press("Enter");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await page.keyboard.press("Tab");
    await expect(menu.getByLabel("New orchestration name")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(opener).toBeFocused();
  }
});

test("A 工作台真实保存、独立三产物、正则、JS、导入及下一轮生产呈现", async ({
  page,
}) => {
  test.setTimeout(90000);
  let calls = 0;
  let names: string[] = [];
  const bodies: string[] = [];
  const provider = createServer((req, res) => {
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
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
    await openWorkspaceCreationTool(page);
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
    await page
      .getByLabel("发送角色", { exact: true })
      .selectOption("assistant");
    await page.getByLabel("合并相邻同角色消息", { exact: true }).check();
    await page.screenshot({
      path: test.info().outputPath("A-main.png"),
      fullPage: true,
    });
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
    await page.getByRole("button", { name: "移除此产物", exact: true }).click();
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
    await page.getByLabel("产物显示位置").selectOption("overlay");
    await page.getByText("游玩效果预览 · 就地展开", { exact: true }).click();
    const overlayPreview = page.locator(
      ".preset-preview-position.position-overlay",
    );
    await expect(
      overlayPreview.getByRole("heading", { name: "浮层" }),
    ).toBeVisible();
    await expect(overlayPreview.locator("iframe")).toHaveCount(0);
    await overlayPreview
      .getByRole("button", { name: "浮层", exact: true })
      .click();
    const overlayDialog = overlayPreview.getByRole("dialog", { name: "浮层" });
    await expect(
      overlayDialog
        .frameLocator("iframe")
        .getByRole("heading", { name: "SECOND TEMPLATE" }),
    ).toBeVisible();
    await overlayDialog
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await expect(overlayDialog).toHaveCount(0);
    await page.getByText("游玩效果预览 · 就地展开", { exact: true }).click();
    await page.getByLabel("产物显示位置").selectOption("sidebar");
    await page.getByLabel("运行方式", { exact: true }).selectOption("app");
    await page.getByLabel("显示方式", { exact: true }).selectOption("");
    await expect(page.getByLabel("运行方式", { exact: true })).toHaveValue(
      "document",
    );
    await page
      .getByRole("button", { name: "新建 HTML 模板", exact: true })
      .click();
    await page
      .getByLabel("HTML", { exact: true })
      .fill("<h2>SECOND TEMPLATE</h2><!-- narraeon:content -->");
    await page.getByLabel("资源名称", { exact: true }).fill("样式 - 雾港");
    await page
      .getByRole("button", { name: "新建命名资源", exact: true })
      .click();
    await page
      .locator("summary")
      .filter({ hasText: /^样式 - 雾港.css$/u })
      .click();
    await page
      .getByLabel("样式 - 雾港.css", { exact: true })
      .fill("body { color: #223344; }");
    await page
      .getByText("JavaScript 示例 · 新建独立产物", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "新建行动按钮示例", exact: true })
      .click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "应用为当前编排方案", exact: true })
      .click();
    const library = await runtime<FileNativePlayPresetLibrary>(page, {
      type: "play.read",
    });
    const saved = library.presets.find((p) => p.id === created.preset.id)!;
    expect(saved.validation).toEqual({ status: "valid" });
    expect(saved.draft).toBeUndefined();
    expect(saved.structure!.mergeConsecutiveMessages).toBe(true);
    expect(saved.structure!.playPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "雾港 · 叙事风格",
          messageRole: "assistant",
        }),
      ]),
    );
    const followup = saved.structure!.followups[0]!;
    names = followup.artifacts.map((a) => a.name);
    expect(names).toHaveLength(3);
    expect(followup.artifacts[0]!.displayName).toBe("场景回顾");
    expect(followup.artifacts[0]!.renderer).not.toBe(
      followup.artifacts[1]!.renderer,
    );
    await page.reload();
    await openWorkspaceCreationTool(page);
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
    await page.screenshot({
      path: test.info().outputPath("A-script.png"),
      fullPage: true,
    });
    await page
      .locator(".preset-object-detail")
      .evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: test.info().outputPath("A-outputs.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 800, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("A-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Clone a complete request closure and keep its switch independent.
    await page
      .getByRole("button", { name: "克隆后置请求", exact: true })
      .click();
    await page.getByLabel("启用 A45 多产物 副本", { exact: true }).uncheck();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page
      .getByRole("button", { name: "应用为当前编排方案", exact: true })
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
    await page.getByText("编排方案操作", { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出编排方案", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.orchestration\.json$/u);
    const portable = await readFile(await download.path());
    expect(JSON.parse(portable.toString("utf8"))).toContainEqual({
      path: "orchestration.yaml",
      contents: expect.stringContaining("format: narraeon.orchestration/v1"),
    });
    await page.getByText("编排方案操作", { exact: true }).click();
    await page.getByText("编排方案管理", { exact: true }).click();
    await page.getByLabel("选择要导入的编排方案").setInputFiles({
      name: "A45-import.orchestration.json",
      mimeType: "application/json",
      buffer: portable,
    });
    await expect(page.getByText(/编排方案已导入为独立副本/)).toBeVisible();
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
      baseTreeRevision: (
        await runtime<{ treeRevision: string }>(page, {
          type: "content.read",
          packageId: content.localId,
        })
      ).treeRevision,
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
    // Narrative commits before followups finish. The composer is enabled only
    // once the complete invocation, including its artifact generation, settles.
    await expect(page.getByLabel("你的行动")).toBeEnabled({ timeout: 30000 });
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
    const choices = page.locator('[data-extension-mount="composer_above"]');
    await choices.locator(".artifact-extension-group-toggle").click();
    await choices
      .frameLocator(`iframe[title="${names[2]}"]`)
      .getByRole("button", { name: "Choose A45" })
      .click();
    await expect(page.getByLabel("你的行动")).toHaveValue("Draft A45 only");
    expect(calls).toBe(2);
    expect(bodies[1]).toContain("回顾本轮已发生变化");
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("用克制而有画面感的文字描写雾港"),
        }),
      ]),
    });
    await page.screenshot({
      path: test.info().outputPath("A-production-play.png"),
      fullPage: true,
    });
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
test("旧便携文件后缀导入后创建独立的编排方案", async ({ page }) => {
  const fixture = JSON.parse(
    gunzipSync(
      await readFile(
        new URL(
          "../fixtures/orchestrations-v090-preview3.json.gz",
          import.meta.url,
        ),
      ),
    ).toString("utf8"),
  ) as { current: { files: Record<string, string> } };
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const before = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  await page.goto("/#/orchestrations");
  await page.getByText("编排方案管理", { exact: true }).click();
  await page.getByLabel("选择要导入的编排方案").setInputFiles({
    name: "旧方案.play-preset.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify(
        Object.entries(fixture.current.files).map(([path, contents]) => ({
          path,
          contents,
        })),
      ),
    ),
  });
  await expect(page.getByText(/编排方案已导入为独立副本/u)).toBeVisible();
  const after = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  expect(after.currentPresetId).toBe(before.currentPresetId);
  const copy = after.presets.find(({ name }) => name === "旧方案");
  expect(copy?.files["orchestration.yaml"]).toContain(
    "narraeon.orchestration/v1",
  );
  expect(copy?.files["assets/v3-extra.txt"]).toBe(
    fixture.current.files["assets/v3-extra.txt"],
  );
  expect(copy?.scriptsEnabled).toBe(false);
});

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error: unknown };
  if (!response.ok()) throw new Error(JSON.stringify(body.error));
  return body.result;
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

test("repairing imported orchestration source exposes a named panel with real label references", async ({
  page,
}) => {
  await page.goto("/");
  await runtime(page, { type: "preferences.save", locale: "zh-CN" });
  const library = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const fixture = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  )!;
  await page.goto(`/#/orchestrations/${fixture.id}`);
  await page.getByText("编排方案管理", { exact: true }).click();
  await page.getByLabel("选择要导入的编排方案").setInputFiles({
    name: "待修复.orchestration.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify(
        Object.entries(fixture.files).map(([path, contents]) => ({
          path,
          contents,
        })),
      ),
    ),
  });
  await expect(page.getByText(/编排方案已导入为独立副本/u)).toBeVisible();
  const imported = (
    await runtime<FileNativePlayPresetLibrary>(page, {
      type: "play.read",
    })
  ).presets.find(({ name }) => name === "待修复")!;

  // The current importer validates new uploads. Persist an invalid draft on
  // the imported copy to exercise the existing recovery path.
  const brokenManifest = "format: [\n";
  await runtime(page, {
    type: "play.save",
    presetId: imported.id,
    name: imported.name,
    files: { ...imported.files, "orchestration.yaml": brokenManifest },
  });
  await page.reload();
  await page.getByRole("button", { name: "修复导入原文", exact: true }).click();
  const filesPanel = page.locator("#play-preset-panel-files");
  await expect(filesPanel).toBeVisible();
  const unresolvedLabels = await filesPanel.evaluate((element) =>
    (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/u)
      .filter((id) => !document.getElementById(id)),
  );
  expect(unresolvedLabels).toEqual([]);
  await expect(filesPanel).toHaveAccessibleName("完整编排方案文件");
  await expect(
    page.getByRole("tabpanel", { name: "完整编排方案文件" }),
  ).toBeVisible();
  const source = filesPanel.getByRole("textbox", {
    name: "编辑编排方案文件 orchestration.yaml",
  });
  await expect(source).toHaveValue(brokenManifest);
  await source.fill(imported.files["orchestration.yaml"]!);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("编排方案检查通过", { exact: true }),
  ).toBeVisible();

  for (const name of ["游玩", "设定完善"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    const tabId = await tab.getAttribute("id");
    const panelId = await tab.getAttribute("aria-controls");
    const panel = page.getByRole("tabpanel", { name, exact: true });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("id", panelId!);
    await expect(panel).toHaveAttribute("aria-labelledby", tabId!);
  }
});

const reviewResource = "assets/review.css";
const reviewName =
  "Fogbell Harbor tabletop orchestration for the lighthouse, guild records, and coastal investigations";

async function openReviewOrchestration(page: Page, locale: "en" | "zh-CN") {
  await runtime(page, { type: "preferences.save", locale });
  const library = await runtime<FileNativePlayPresetLibrary>(page, {
    type: "play.read",
  });
  const base = library.presets.find(
    ({ id }) => id === library.currentPresetId,
  )!;
  const files = {
    ...base.files,
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `assets/fixture-${index}.css`,
        "",
      ]),
    ),
    [reviewResource]: "body { color: green; }",
    "assets/review-notes.txt": "Review notes",
  };
  const { preset } = await runtime<{ preset: { id: string } }>(page, {
    type: "play.import",
    name: reviewName,
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      contents,
    })),
  });
  await page.goto(`/#/orchestrations/${preset.id}`);
}

for (const locale of ["en", "zh-CN"] as const) {
  const cn = locale === "zh-CN";
  const actionsLabel = cn ? "编排方案操作" : "Orchestration actions";
  const filesLabel = cn ? "完整编排方案文件" : "Complete orchestration files";
  const retainedLabel = cn ? "保留的资源" : "Retained assets";
  const danger = "rgb(161, 62, 53)";
  const dangerFill = "rgb(251, 237, 235)";

  test(`#453 orchestration distinguishes destructive actions and errors (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 844 });
    await openReviewOrchestration(page, locale);
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    const checkDanger = async (control: ReturnType<typeof button>) => {
      await expect(control).toBeEnabled();
      expect
        .soft(
          await control.evaluate((element) => {
            const style = getComputedStyle(element);
            return [
              style.color,
              style.backgroundColor,
              style.borderColor,
              style.borderWidth,
            ];
          }),
        )
        .toEqual([danger, dangerFill, danger, "1px"]);
    };
    const actions = page.getByText(actionsLabel, { exact: true });
    await actions.press("Enter");
    const disable = button(cn ? "停用编排方案" : "Disable orchestration");
    await expect(disable).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const deletePreset = button(cn ? "删除编排方案" : "Delete orchestration");
    await deletePreset.click();
    const dialog = page.getByRole("dialog", {
      name: cn ? /删除编排方案/ : /Delete orchestration/,
    });
    const message = dialog.getByText(reviewName, { exact: false });
    const cancel = dialog.getByRole("button", {
      name: cn ? "取消" : "Cancel",
      exact: true,
    });
    const confirm = dialog.getByRole("button", {
      name: cn ? "删除" : "Delete",
      exact: true,
    });
    await expect(cancel).toBeFocused();
    await expect(cancel).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await checkDanger(confirm);
    expect
      .soft(
        await message.evaluate((element) => {
          const text = getComputedStyle(element);
          const dialog = getComputedStyle(element.closest("dialog")!);
          return [
            text.fontSize === dialog.fontSize,
            text.lineHeight === dialog.lineHeight,
            text.color === dialog.color,
          ];
        }),
      )
      .toEqual([true, true, true]);
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(deletePreset).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    expect(
      await page.evaluate(() =>
        (
          window as Window & {
            narraeonAndroidBack?: () => boolean;
          }
        ).narraeonAndroidBack?.(),
      ),
    ).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(deletePreset).toBeFocused();

    await button(retainedLabel).click();
    const files = page.getByRole("tabpanel", { name: filesLabel });
    await expect(
      files.getByRole("heading", { name: filesLabel }),
    ).toBeFocused();
    const asset = files.getByRole("button", {
      name: cn
        ? `打开编排方案文件 ${reviewResource}`
        : `Open orchestration file ${reviewResource}`,
    });
    await asset.click();
    const deleteResource = button(
      cn ? "删除未引用资源" : "Delete unused resource",
    );
    await checkDanger(deleteResource);
    await deleteResource.hover();
    await checkDanger(deleteResource);

    await files
      .getByText(cn ? "新增修复文件" : "Add a repair file", { exact: true })
      .click();
    const path = files.getByRole("textbox", {
      name: cn ? "新增编排方案文件路径" : "New play-file path",
    });
    const addFile = button(cn ? "加入文件草稿" : "Add file to draft");
    await path.fill(reviewResource);
    await addFile.click();
    const error = page.getByRole("alert").filter({
      hasText: cn
        ? "该编排方案文件路径已经存在。"
        : "That play-file path already exists.",
    });
    await expect(error).toBeVisible();
    expect
      .soft(
        await error.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.backgroundColor,
            style.borderInlineStartColor,
            style.borderInlineStartStyle,
            style.borderInlineStartWidth,
          ];
        }),
      )
      .toEqual([dangerFill, danger, "solid", "3px"]);
    await path.fill("assets/repair.css");
    await addFile.click();
    await expect(error).toBeHidden();
    const status = page
      .locator(".play-preset-feedback")
      .and(page.getByRole("status"));
    await expect(status).toBeVisible();
    await expect(status).not.toHaveCSS("background-color", dangerFill);
    await expect(status).toHaveCSS("border-inline-start-width", "0px");

    await page
      .getByRole("tab", { name: cn ? "游玩" : "Play", exact: true })
      .click();
    await button(cn ? "新增纯界面" : "Add interface panel").click();
    await checkDanger(button(cn ? "删除面板" : "Delete panel"));
    await button(cn ? "新增后置请求" : "Add follow-up request").click();
    await button(cn ? "界面产物" : "Outputs").click();
    await checkDanger(button(cn ? "移除此产物" : "Remove output"));
    await expect(button(cn ? "保存修改" : "Save changes")).toHaveCSS(
      "background-color",
      "rgb(52, 56, 50)",
    );
  });

  test(`#454 orchestration actions leave the toolbar and editor in place (${locale})`, async ({
    page,
  }) => {
    await openReviewOrchestration(page, locale);
    const actions = page.getByText(actionsLabel, { exact: true });
    const options = page.locator(".play-preset-operations-content");
    const name = options.getByRole("textbox", {
      name: cn ? "编排方案名称" : "Orchestration name",
    });
    const verticalBounds = () =>
      Promise.all(
        [
          actions,
          page.locator(".play-preset-toolbar"),
          page.locator(".play-preset-editor-header"),
        ].map(async (element) => {
          const { y, height } = (await element.boundingBox())!;
          return { y, height };
        }),
      );

    for (const width of [390, 800, 801, 1440]) {
      await test.step(`viewport ${width}px`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await expect(actions).toBeVisible();
        const before = await verticalBounds();
        await actions.press("Enter");
        await expect(options).toBeVisible();
        expect.soft(await verticalBounds()).toEqual(before);
        const menu = (await options.boundingBox())!;
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width);
        expect(menu.y + menu.height).toBeLessThanOrEqual(844);
        await page.keyboard.press("Tab");
        await expect(name).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(options).toBeHidden();
        await expect(actions).toBeFocused();
        expect(await verticalBounds()).toEqual(before);
      });
    }
  });

  test(`#455 orchestration editor and file navigation fit the available width (${locale})`, async ({
    page,
  }) => {
    await openReviewOrchestration(page, locale);
    const column = page.locator(".orchestration-editor-column");
    const orderedList = column.locator(".ordered-play-editor > aside");
    const editor = column.locator(".ordered-play-content");
    const widthCases = [
      { viewport: 390 },
      { viewport: 600 },
      { viewport: 601 },
      { viewport: 620 },
      { viewport: 640 },
      { viewport: 641 },
      { viewport: 700 },
      { viewport: 768 },
      { viewport: 850 },
      { viewport: 1440 },
      { viewport: 1440, available: 645 },
      { viewport: 1440, available: 644 },
      { viewport: 1440, available: 620 },
    ];
    const resize = async (viewport: number, available?: number) => {
      await page.setViewportSize({ width: viewport, height: 844 });
      await column.evaluate((element, available) => {
        element.style.maxWidth =
          available === undefined ? "" : `${available}px`;
      }, available);
      expect((await column.boundingBox())!.width).toBe(available ?? viewport);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport);
    };
    await expect(editor).toBeVisible();
    for (const { viewport, available } of widthCases) {
      await test.step(`prompt editor at ${viewport}px, column ${available ?? viewport}px`, async () => {
        await resize(viewport, available);
        const list = (await orderedList.boundingBox())!;
        const detail = (await editor.boundingBox())!;
        if ((available ?? viewport) <= 640) {
          expect.soft(detail.x).toBe(list.x);
          expect.soft(detail.y).toBeCloseTo(list.y + list.height, 0);
          expect.soft(detail.width).toBe(list.width);
          expect.soft(list.height).toBeLessThanOrEqual(144);
        } else {
          expect(detail.y).toBe(list.y);
          expect(detail.x).toBeCloseTo(list.x + list.width, 0);
          expect(detail.height).toBe(list.height);
        }
        expect
          .soft(
            await orderedList.evaluate(
              (element) =>
                getComputedStyle(element).overflowY === "auto" &&
                element.scrollHeight > element.clientHeight,
            ),
          )
          .toBe(true);
      });
    }
    await orderedList.hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => orderedList.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page
      .getByRole("button", {
        name: cn ? "新增提示词" : "Add prompt",
        exact: true,
      })
      .click();
    const prompt = editor.getByRole("textbox", {
      name: cn ? "提示词正文" : "Prompt text",
    });
    await prompt.click();
    await expect(prompt).toBeFocused();
    await page.keyboard.type("Prompt draft");
    await expect(prompt).toHaveValue("Prompt draft");

    await page.getByText(actionsLabel, { exact: true }).press("Enter");
    await page
      .getByRole("button", { name: retainedLabel, exact: true })
      .press("Enter");
    const files = page.getByRole("tabpanel", { name: filesLabel });
    await expect(
      files.getByRole("heading", { name: filesLabel }),
    ).toBeFocused();
    const jump = files.getByRole("combobox", {
      name: cn ? "编排方案文件" : "Orchestration files",
    });
    const list = files.locator(".play-preset-file-browser > aside");
    const pane = files.locator(".play-preset-file-editor-pane");
    for (const { viewport, available } of widthCases) {
      await test.step(`file editor at ${viewport}px, column ${available ?? viewport}px`, async () => {
        await resize(viewport, available);
        const compact = (available ?? viewport) <= 644;
        const side = await list.boundingBox();
        expect.soft(await jump.isVisible()).toBe(compact);
        expect.soft(side === null).toBe(compact);
        const file = (await pane.boundingBox())!;
        if (side !== null && !compact) {
          expect.soft(file.y).toBe(side.y);
          expect.soft(file.x).toBeCloseTo(side.x + side.width, 0);
          expect(
            await list.evaluate(
              (element) => getComputedStyle(element).overflowY,
            ),
          ).toBe("auto");
        }
        expect
          .soft(
            await pane.evaluate((element) =>
              parseFloat(getComputedStyle(element).paddingInlineStart),
            ),
          )
          .toBeCloseTo(compact ? 9.1 : 14);
        expect
          .soft(file.x + file.width)
          .toBeLessThanOrEqual((available ?? viewport) + 0.1);
      });
    }
    const source = files.getByRole("textbox", {
      name: cn
        ? `编辑编排方案文件 ${reviewResource}`
        : `Edit orchestration file ${reviewResource}`,
    });
    await jump.selectOption(reviewResource);
    await jump.press("Tab");
    await expect(source).toBeFocused();
    await expect(source).toHaveValue("body { color: green; }");
    await resize(1440);
    await list.hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const notes = "assets/review-notes.txt";
    const otherFile = list.getByRole("button", {
      name: cn
        ? `打开编排方案文件 ${notes}`
        : `Open orchestration file ${notes}`,
    });
    await otherFile.click();
    await expect(otherFile).toHaveAttribute("aria-pressed", "true");
    await expect(
      files.getByRole("textbox", {
        name: cn
          ? `编辑编排方案文件 ${notes}`
          : `Edit orchestration file ${notes}`,
      }),
    ).toHaveValue("Review notes");
  });
}
