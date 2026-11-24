// Run from the repo root after npm run build:web and npx playwright install chromium.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { startWebServer } from "../src/server/startWebServer.ts";

const expect = playwrightExpect.configure({ timeout: 15000 });
const evidence = resolve(process.argv[2] ?? ".test-data/verify-273");
const scratch = await mkdtemp(join(tmpdir(), "narraeon-273-"));
const narrative = [
  "273 narrative fixture.",
  ...Array.from(
    { length: 18 },
    (_, index) => `The path passes milestone ${index + 1}.`,
  ),
].join("\n\n");
const outputs = {
  markdown_panel: "**273 Markdown fixture**",
  html_panel: "<p>273 HTML fixture</p>",
  debug_panel: "273 debug fixture",
  recap: "273 built-in recap fixture",
};
const finalContents = {
  markdown_panel: "<p><strong>273 Markdown fixture</strong></p>",
  html_panel: outputs.html_panel,
  debug_panel: "<p>273 debug fixture</p>",
};
const calls = [];
const debuggerFailures = [];
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const { messages } = JSON.parse(body);
  const context = JSON.stringify(messages);
  const panelPrompt =
    /The core narrative has already been committed\. Generate a panel|核心叙事已经提交。只有面板/u;
  const recapPrompt =
    /The main narrative has settled\. Emit a brief scene recap|主叙事已完成。仅根据已向玩家呈现/u;
  const selected = panelPrompt.test(context)
    ? ["markdown_panel", "html_panel", "debug_panel"]
    : recapPrompt.test(context)
      ? ["recap"]
      : [];
  calls.push(selected);
  const delta =
    selected.length === 0
      ? { content: narrative }
      : {
          tool_calls: selected.map((output, index) => ({
            index,
            id: `emit-${calls.length}-${index}`,
            type: "function",
            function: {
              name: "artifact_emit",
              arguments: JSON.stringify({ output, payload: outputs[output] }),
            },
          })),
        };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
  );
});

const locales = [
  {
    id: "en",
    orchestration: "Orchestrations",
    manage: "Manage orchestrations",
    copy: "Copy recommended orchestration",
    copied: (label) =>
      `Copied the recommended ${label} for independent editing.`,
    operations: "Orchestration actions",
    export: "Export orchestration",
    editingPrompt: "What should this follow-up do?",
    outputs: "Outputs",
    outputPosition: "Output position",
    submitHelp: "How AI submits these outputs",
    switch: "Switch orchestration",
    use: "Use as current orchestration",
    action: "Your action",
    send: "Send action from a fresh context",
    debugger: "Artifact debugger",
    diagnostics: "Extension diagnostics",
    reading: "Reading settings",
    technical: "Show technical information",
    close: "Close",
    now: "Now",
    followup: "Publish generic panels",
    templates: [
      [
        "generic-panels",
        "Markdown / HTML panels",
        "Generic panels (editable copy)",
      ],
      [
        "artifact-debugger",
        "Artifact debugger",
        "Artifact debugger (editable copy)",
      ],
    ],
  },
  {
    id: "zh-CN",
    orchestration: "编排方案",
    manage: "编排方案管理",
    copy: "复制推荐",
    copied: (label) => `已复制推荐${label}，可独立编辑。`,
    operations: "编排方案操作",
    export: "导出编排方案",
    editingPrompt: "这次额外请求要做什么",
    outputs: "界面产物",
    outputPosition: "产物显示位置",
    submitHelp: "AI 如何提交这些产物",
    switch: "切换编排方案",
    use: "应用为当前编排方案",
    action: "你的行动",
    send: "从全新上下文发送行动",
    debugger: "产物调试器",
    diagnostics: "扩展诊断",
    reading: "阅读设置",
    technical: "显示技术信息",
    close: "关闭",
    now: "此刻",
    followup: "发布通用面板",
    templates: [
      ["generic-panels", "Markdown / HTML 面板", "通用面板（可编辑副本）"],
      ["artifact-debugger", "产物调试器", "产物调试器（可编辑副本）"],
    ],
  },
];

let runtime;
let browser;
let page;
try {
  const providerPort = await listen(provider);
  const reservation = createServer();
  const runtimePort = await listen(reservation);
  await close(reservation);
  runtime = await startWebServer({
    paths: {
      configRoot: join(scratch, "config"),
      dataRoot: join(scratch, "data"),
      logRoot: join(scratch, "log"),
    },
    staticRoot: resolve("dist/web"),
    host: "127.0.0.1",
    port: runtimePort,
    logger: false,
  });
  const url = `http://127.0.0.1:${runtimePort}`;
  browser = await chromium.launch();
  page = await browser.newPage({
    baseURL: url,
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30000);
  await page.goto(url);
  const model = {
    provider: "chat_completions",
    modelId: "fixture-273",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
  };
  await command(page, {
    type: "model.save",
    connection: {
      ...model,
      name: "Fixture 273",
      presetId: "custom",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      apiKey: "fixture",
    },
  });
  const content = await command(page, { type: "content.create" });

  for (const ui of locales) {
    const localeEvidence = join(evidence, ui.id);
    await mkdir(localeEvidence, { recursive: true });
    await page.goto(url);
    const initialLocale = (await command(page, { type: "preferences.read" }))
      .locale;
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", initialLocale);
    const localePicker = page.locator(".workspace-locale-picker select");
    await expect(localePicker).toHaveValue(initialLocale);
    await localePicker.selectOption(ui.id);
    await expect
      .poll(
        async () => (await command(page, { type: "preferences.read" })).locale,
      )
      .toBe(ui.id);
    await expect(html).toHaveAttribute("lang", ui.id);

    const seed = (await command(page, { type: "play.read" })).currentPresetId;
    let firstExport;
    for (const [templateId, label, name] of ui.templates) {
      const folder = join(localeEvidence, templateId);
      await mkdir(folder, { recursive: true });
      await page.goto(url);
      await button(page, ui.orchestration).click();
      await page.getByText(ui.manage, { exact: true }).click();
      const menu = page.locator(".play-preset-library-actions");
      await expect(
        button(menu, new RegExp(label.replaceAll("/", "\\/"), "u")),
      ).toContainText(ui.copy);
      await menu.screenshot({
        path: join(localeEvidence, "template-picker.png"),
      });
      await button(menu, new RegExp(label.replaceAll("/", "\\/"), "u")).click();
      await expect(
        page.getByText(ui.copied(label), { exact: true }),
      ).toBeVisible();
      const switcher = page.getByRole("combobox", { name: ui.switch });
      await expect(switcher.locator("option:checked")).toHaveText(name);
      await page.screenshot({ path: join(folder, "copied.png") });

      const library = await command(page, { type: "play.read" });
      const preset = library.presets.find((entry) => entry.name === name);
      assert.ok(preset);
      assert.equal(library.currentPresetId, seed);
      assert.deepEqual(preset.validation, { status: "valid" });
      assert.equal(preset.scriptsEnabled, true);
      assert.deepEqual(preset.structure.playerViewPanels, []);
      assert.equal(preset.structure.followups[0].displayName, ui.followup);

      await page.getByText(ui.operations, { exact: true }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        button(page, ui.export).click(),
      ]);
      const portable = await readFile(await download.path());
      assert.equal(download.suggestedFilename(), `${name}.orchestration.json`);
      const files = JSON.parse(portable);
      if (firstExport) {
        assert.notEqual(preset.id, firstExport.id);
        assert.deepEqual(portable, firstExport.portable);
      } else {
        firstExport = { id: preset.id, portable };
      }
      assert.deepEqual(
        files.map(({ path }) => path),
        [
          "assets/generic-html.css",
          "call-chain.yaml",
          "frame.yaml",
          "orchestration.yaml",
          "prompts/panels.md",
          "renderers/generic-html.html",
          "scripts/generic-html.js",
        ],
      );
      await writeFile(join(folder, "export.orchestration.json"), portable);
      await json(join(folder, "workbench.json"), preset);

      await page.getByText(ui.operations, { exact: true }).click();
      await button(page, new RegExp(`^${ui.followup} `, "u")).click();
      const prompt = page.getByRole("textbox", { name: ui.editingPrompt });
      await expect(prompt).toBeEditable();
      await expect(prompt).toHaveValue(preset.files["prompts/panels.md"]);
      await page.screenshot({
        path: join(folder, "editable-prompt.png"),
      });

      await button(page, ui.outputs).click();
      await page.getByText(ui.submitHelp, { exact: true }).click();
      const bindings = {
        markdown_panel: "story",
        html_panel: "sidebar",
        debug_panel: "debug",
      };
      for (const [output, mount] of Object.entries(bindings)) {
        await button(
          page.locator(".preset-output-cards"),
          new RegExp(`^${output} `, "u"),
        ).click();
        await expect(
          page.getByLabel(ui.outputPosition, { exact: true }),
        ).toHaveValue(mount);
      }
      await page
        .locator(".preset-object-detail")
        .screenshot({ path: join(folder, "channel-bindings.png") });
    }

    for (const [templateId, , name] of ui.templates) {
      await page.goto(url);
      await button(page, ui.orchestration).click();
      const folder = join(localeEvidence, templateId);
      const switcher = page.getByRole("combobox", { name: ui.switch });
      await switcher.selectOption({ label: name });
      const presetId = await switcher.inputValue();
      await button(page, ui.use).click();
      await expect
        .poll(
          async () =>
            (await command(page, { type: "play.read" })).currentPresetId,
        )
        .toBe(presetId);
      const worldId = await createWorld(
        page,
        content.localId,
        model,
        `${ui.id}-${templateId}`,
      );
      const requestIndex = calls.length;
      await play(page, url, ui, worldId);
      const view = page.getByRole("region", { name: ui.debugger, exact: true });
      await expect(view.locator(".artifact-debugger-entry")).toHaveCount(3);
      await expect(
        view.getByText(ui.diagnostics, { exact: true }),
      ).toBeVisible();
      assert.deepEqual(calls.slice(requestIndex), [
        [],
        ["markdown_panel", "html_panel", "debug_panel"],
      ]);
      await expect(
        page
          .locator('[data-extension-mount="story"]')
          .frameLocator('iframe[title="markdown_panel"]')
          .getByText("273 Markdown fixture"),
      ).toBeVisible();
      const now = button(page, ui.now);
      if ((await now.getAttribute("aria-pressed")) !== "true")
        await now.click();
      await expect(
        page
          .locator('[data-extension-mount="sidebar"]')
          .frameLocator('iframe[title="html_panel"]')
          .getByText("273 HTML fixture"),
      ).toBeVisible();
      await page.screenshot({ path: join(folder, "world-sidebar.png") });
      await now.click();

      await page.screenshot({
        path: join(folder, "world-before-inspection.png"),
      });
      const debug = await command(page, { type: "artifacts.debug", worldId });
      const active = await command(page, { type: "artifacts.read", worldId });
      const byOutput = Object.fromEntries(
        debug.map((record) => [record.output, record]),
      );
      assert.deepEqual(active.map(({ output }) => output).sort(), [
        "html_panel",
        "markdown_panel",
      ]);
      await captureDebugger(page, ui, view, folder);
      for (const [output, status, channel, mount, save, projection] of [
        [
          "markdown_panel",
          "active",
          "generic.markdown",
          "story",
          "commit",
          "replace",
        ],
        [
          "html_panel",
          "active",
          "generic.html",
          "sidebar",
          "commit",
          "replace",
        ],
        [
          "debug_panel",
          "superseded",
          "generic.debug",
          "debug",
          "operation",
          "append",
        ],
      ]) {
        const record = byOutput[output];
        assert.equal(record.playPresetId, presetId);
        assert.equal(record.requestId, "publish_panels");
        assert.equal(record.frontend.mount, mount);
        assert.equal(record.payload, outputs[output]);
        assert.deepEqual(
          [record.status, record.channel, record.save, record.projection],
          [status, channel, save, projection],
        );
        const row = view.getByText(`${output} · ${status} · ${channel}`, {
          exact: true,
        });
        await row.press("Enter");
        const entry = row.locator("..");
        await expect(entry).toHaveAttribute("open", "");
        assert.deepEqual(await entry.locator("pre").allTextContents(), [
          outputs[output],
          finalContents[output],
          "[]",
        ]);
        await row.press("Enter");
      }
      await expect(page.locator('[data-extension-mount="debug"]')).toBeEmpty();
      await json(join(folder, "artifacts-debug.json"), debug);
      await json(join(folder, "artifacts-active.json"), active);
      console.log(
        `${ui.id} ${templateId}: matching exports, three records and two active panels`,
      );
    }

    // Run the app's own scene-recap example without using either template.
    await command(page, { type: "play.select", presetId: seed });
    const seedPreset = (
      await command(page, { type: "play.read" })
    ).presets.find(({ id }) => id === seed);
    assert.ok(
      !seedPreset.structure.followups.some(({ id }) => id === "publish_panels"),
    );
    const worldId = await createWorld(
      page,
      content.localId,
      model,
      `${ui.id}-control`,
    );
    const { items } = await command(page, {
      type: "world.extensions.read",
      worldId,
    });
    const recap = items.find(({ id }) => id === "builtin:summary");
    assert.ok(recap && recap.source === "builtin");
    const selected = await command(page, {
      type: "world.extensions.set",
      worldId,
      key: recap.key,
      value: "on",
    });
    assert.equal(
      selected.items.find(({ key }) => key === recap.key).enabled,
      true,
    );
    const requestIndex = calls.length;
    await play(page, url, ui, worldId);
    const view = page.getByRole("region", { name: ui.debugger, exact: true });
    await expect(view.locator(".artifact-debugger-entry")).toHaveCount(1);
    assert.deepEqual(calls.slice(requestIndex), [[], ["recap"]]);
    const debug = await command(page, { type: "artifacts.debug", worldId });
    assert.equal(debug.length, 1);
    assert.equal(debug[0].playPresetId, seed);
    assert.equal(debug[0].frontend.mount, "story");
    const controlFolder = join(localeEvidence, "control");
    await mkdir(controlFolder, { recursive: true });
    await captureDebugger(page, ui, view, controlFolder);
    await json(join(controlFolder, "artifacts-debug.json"), debug);
    console.log(
      `${ui.id} control: same debugger with a built-in recap on the system orchestration`,
    );
  }
  assert.deepEqual(debuggerFailures, [], "Artifact debugger pointer failures");
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  await runtime?.close();
  if (provider.listening) await close(provider);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`Evidence saved to ${evidence}`);

function button(parent, name) {
  return parent.getByRole("button", { name, exact: true });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  return new Promise((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}

async function command(page, request) {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = await response.json();
  assert.ok(response.ok() && body.error === undefined, JSON.stringify(body));
  return body.result;
}

async function createWorld(page, packageId, model, suffix) {
  const { world } = await command(page, {
    type: "world.create",
    operationId: `issue-273-${suffix}`,
    packageId,
    model,
  });
  await command(page, {
    type: "world.rename",
    worldId: world.worldId,
    name: `273 ${suffix}`,
  });
  return world.worldId;
}

async function play(page, url, ui, worldId) {
  await page.goto(url);
  await page.goto(`${url}/#/world/${worldId}`);
  const action = page.getByRole("textbox", { name: ui.action });
  const settings = button(page, ui.reading);
  await settings.click();
  const technical = page.getByRole("checkbox", { name: ui.technical });
  await expect(technical).not.toBeChecked();
  await button(page.getByLabel(ui.reading, { exact: true }), ui.close).click();
  await action.fill("Read the sign.");
  await expect(action).toHaveValue("Read the sign.");
  const send = button(page, ui.send);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText(/^273 narrative fixture\./u)).toBeVisible();
  await expect(action).toBeEnabled({ timeout: 15000 });
}

async function captureDebugger(page, ui, view, folder) {
  const coverage = { viewport: page.viewportSize() };
  const scroller = page.locator(".world-reader-scroll");
  const rows = view.locator(".artifact-debugger-entry > summary");
  const firstRow = rows.first();

  for (const mode of ["story", "detailed"]) {
    const world = page.locator(".world-reader-page");
    await expect(world).toHaveClass(new RegExp(`is-${mode}-mode`, "u"));

    const now = button(page, ui.now);
    await expect(now).toHaveAttribute("aria-pressed", "false");
    await now.click();
    await expect(now).toHaveAttribute("aria-pressed", "true");
    await now.click();
    await expect(now).toHaveAttribute("aria-pressed", "false");

    // Use a wheel over the reader margin, away from the dock and detail panes.
    const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
    await page.mouse.move(
      coverage.viewport.width - 50,
      coverage.viewport.height / 2,
    );
    await page.mouse.wheel(0, -4000);
    await expect.poll(scrollTop).toBe(0);
    await expect(page.getByText(/^273 narrative fixture\./u)).toBeInViewport();
    await page.mouse.wheel(0, 4000);
    await expect.poll(scrollTop).toBeGreaterThan(100);
    const wheelScrollTop = await scrollTop();

    const records = [];
    const rowLocators = await rows.all();
    for (const [index, row] of rowLocators.entries()) {
      const entry = row.locator("..");
      const details = entry.locator("dl");
      const isOpen = () => entry.evaluate((element) => element.open);
      await expect(entry).not.toHaveAttribute("open", "");
      const points = await row.evaluate((summary) => {
        const { x, y, width, height } = summary.getBoundingClientRect();
        return [x + 12, x + width / 2, x + width - 12].map((point) => ({
          x: point,
          y: y + height / 2,
        }));
      });
      const hits = [];
      for (const [pointIndex, { x, y }] of points.entries()) {
        const hit = await row.evaluate(
          (summary, point) => {
            const target = summary.ownerDocument.elementFromPoint(
              point.x,
              point.y,
            );
            return {
              node: target?.localName ?? null,
              className: target?.getAttribute("class") ?? null,
              storyReader: Boolean(target?.closest(".world-reader-scroll")),
              summary: summary.contains(target),
            };
          },
          { x, y },
        );
        await page.mouse.click(x, y);
        const opened = await isOpen();
        const detailsVisible = await details.isVisible();
        if (index === 0 && pointIndex === 1)
          await page.screenshot({
            path: join(folder, `world-${mode}-clicked.png`),
          });

        await page.mouse.click(x, y);
        const closed = !(await isOpen()) && !(await details.isVisible());
        if (index === 0 && pointIndex === 1)
          await page.screenshot({
            path: join(folder, `world-${mode}-closed.png`),
          });

        hits.push({ x, y, ...hit, opened, detailsVisible, closed });
        if (!hit.summary || !opened || !detailsVisible || !closed) {
          debuggerFailures.push(
            `${folder} ${mode} row ${index + 1} point ${pointIndex + 1}`,
          );
        }
      }
      records.push({ title: await row.textContent(), hits });
    }

    await firstRow.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(firstRow).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(firstRow).toBeFocused();
    await page.keyboard.press("Enter");
    const keyboardDetails = firstRow.locator("..").locator("dl");
    await expect(keyboardDetails).toBeVisible();
    await page.keyboard.press("Space");
    await expect(keyboardDetails).toBeHidden();

    const action = page.getByRole("textbox", { name: ui.action });
    await action.click();
    await expect(action).toBeFocused();
    coverage[mode] = {
      records,
      wheelScrollTop,
      keyboardToggled: true,
      nowToggled: true,
      composerFocused: true,
    };

    await button(page, ui.reading).click();
    await page
      .getByRole("checkbox", { name: ui.technical })
      .setChecked(mode === "story");
    await button(
      page.getByLabel(ui.reading, { exact: true }),
      ui.close,
    ).click();
  }
  await json(join(folder, "debugger-hit-test.json"), coverage);
}

function json(path, value) {
  return writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
