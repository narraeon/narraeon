import { expect, type Page } from "@playwright/test";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  appLocales,
  defaultAppReadingPreferences,
} from "../../src/protocol/appPreferences.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { firstPartyGenericPanelsPresetFilesForLocale } from "../../src/shared/first-party-generic-panels.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "artifact-debugger-template" });

for (const locale of appLocales) {
  test(`debug template files and world diagnostics (${locale})`, async ({
    page,
  }) => {
    const zh = locale === "zh-CN";
    const label = (chinese: string, english: string) =>
      zh ? chinese : english;
    const library = () =>
      runtime<FileNativePlayPresetLibrary>(page, { type: "play.read" });
    const readPreset = async (id: string) =>
      (await library()).presets.find((item) => item.id === id)!;
    const oldFiles = firstPartyGenericPanelsPresetFilesForLocale(locale);
    const oldCopy = await runtime<{ preset: { id: string } }>(page, {
      type: "play.create",
      name: label(
        "产物调试器（可编辑副本）",
        "Artifact debugger (editable copy)",
      ),
      files: oldFiles,
    });
    const historical = await readPreset(oldCopy.preset.id);

    await runtime(page, {
      type: "preferences.save",
      locale,
      reading: defaultAppReadingPreferences,
    });
    await page.goto("/#/orchestrations");
    const manage = page.getByText(
      label("编排方案管理", "Manage orchestrations"),
      {
        exact: true,
      },
    );
    await manage.click();
    const copyPrefix = label("复制推荐", "Copy recommended orchestration");
    await expect(
      page.getByRole("button", {
        name: new RegExp(`${copyPrefix}.*Markdown / HTML`),
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: new RegExp(
          `${copyPrefix}.*${label("产物调试器示例", "Artifact debugger example")}`,
        ),
      })
      .click();
    await expect(page).toHaveURL(/#\/orchestrations\/[^/]+$/u);
    const id = decodeURIComponent(page.url().split("/").at(-1)!);
    const original = await readPreset(id);
    expect(original.validation).toEqual({ status: "valid" });
    expect(Object.keys(original.files).sort()).toEqual([
      "call-chain.yaml",
      "frame.yaml",
      "orchestration.yaml",
      "prompts/debug-example.md",
    ]);
    expect(original.files["orchestration.yaml"]).toContain(
      "name: artifact-debugger",
    );
    expect(original.structure!.followups).toHaveLength(1);
    expect(original.structure!.followups[0]!.artifacts).toEqual([
      expect.objectContaining({
        name: "debug_example",
        channel: "artifact-debugger.example",
      }),
    ]);

    await page
      .getByRole("button", {
        name: new RegExp(label("^发送调试示例", "^Emit debug example")),
      })
      .click();
    const prompt = page.getByLabel(
      label("这次额外请求要做什么", "What should this follow-up do?"),
    );
    await expect(prompt).toHaveValue(
      new RegExp(
        label(
          "世界页自带通用产物调试器",
          "world page has a built-in artifact debugger",
        ),
      ),
    );
    await prompt.fill(
      `${await prompt.inputValue()}\n# Browser edit ${locale}\n`,
    );
    await page
      .getByRole("button", {
        name: label("保存修改", "Save changes"),
        exact: true,
      })
      .click();
    await expect(
      page.getByText(label("编排方案已保存。", "Orchestration saved."), {
        exact: true,
      }),
    ).toBeVisible();

    await page
      .getByRole("button", {
        name: label("应用为当前编排方案", "Use as current orchestration"),
        exact: true,
      })
      .click();
    await expect
      .poll(async () => (await library()).currentPresetId)
      .toEqual(id);

    await page
      .getByText(label("编排方案操作", "Orchestration actions"), {
        exact: true,
      })
      .click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("button", {
          name: label("导出编排方案", "Export orchestration"),
          exact: true,
        })
        .click(),
    ]);
    const portable = await readFile(await download.path());
    await download.saveAs(
      test.info().outputPath(`debug-${locale}.orchestration.json`),
    );
    expect(JSON.parse(portable.toString("utf8"))).toContainEqual({
      path: "prompts/debug-example.md",
      contents: expect.stringContaining(`# Browser edit ${locale}`),
    });
    await manage.click();
    await page
      .getByLabel(
        label("选择要导入的编排方案", "Choose an orchestration to import"),
      )
      .setInputFiles({
        name: `debug-${locale}.orchestration.json`,
        mimeType: "application/json",
        buffer: portable,
      });
    await expect(
      page.getByText(
        new RegExp(
          label(
            "编排方案已导入为独立副本",
            "Orchestration imported as an independent copy",
          ),
        ),
      ),
    ).toBeVisible();
    const imported = (await library()).presets.find(
      (item) => item.name === `debug-${locale}`,
    )!;
    expect(imported.validation).toEqual({ status: "valid" });
    expect(imported.id).not.toEqual(id);
    expect(imported.files).toEqual((await readPreset(id)).files);
    const surviving = await readPreset(historical.id);
    expect(surviving).toEqual(historical);
    expect(
      surviving.structure!.followups[0]!.artifacts.map(({ name }) => name),
    ).toEqual(["markdown_panel", "html_panel", "debug_panel"]);

    const bodies: string[] = [];
    const payload = "DEBUG: The lantern was lit.";
    const provider = createServer((request, response) => {
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        bodies.push(body);
        const delta = body.includes(`# Browser edit ${locale}`)
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "debug-call",
                  type: "function",
                  function: {
                    name: "artifact_emit",
                    arguments: JSON.stringify({
                      output: "debug_example",
                      payload,
                    }),
                  },
                },
              ],
            }
          : { content: "The lantern was lit." };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    }).listen(0, "127.0.0.1");
    await once(provider, "listening");
    try {
      const address = provider.address();
      if (address === null || typeof address === "string")
        throw new Error("No provider port");
      const model = {
        provider: "chat_completions",
        modelId: "debug-fixture",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
      } as const;
      await runtime(page, { type: "play.select", presetId: imported.id });
      await runtime(page, {
        type: "model.save",
        connection: {
          ...model,
          name: "Debug fixture",
          presetId: "custom",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
        },
      });
      const content = await runtime<{ localId: string }>(page, {
        type: "content.create",
      });
      const { world } = await runtime<{ world: { worldId: string } }>(page, {
        type: "world.create",
        operationId: crypto.randomUUID(),
        packageId: content.localId,
        model,
      });
      await page.goto(`/#/world/${world.worldId}`);
      const debuggerRegion = page.getByRole("region", {
        name: label("产物调试器", "Artifact debugger"),
      });
      const technicalInfo = page.getByRole("checkbox", {
        name: label("显示技术信息", "Show technical information"),
      });
      const setDetailedMode = async (show: boolean) => {
        await page
          .getByRole("button", {
            name: label("阅读设置", "Reading settings"),
            exact: true,
          })
          .click();
        await technicalInfo.setChecked(show);
        await page
          .getByLabel(label("阅读设置", "Reading settings"))
          .getByRole("button", {
            name: label("关闭", "Close"),
            exact: true,
          })
          .click();
      };
      await setDetailedMode(true);
      await expect(page.locator(".is-detailed-mode")).toBeVisible();
      await expect(debuggerRegion).toHaveCount(0);
      await setDetailedMode(false);
      const action = page.getByLabel(label("你的行动", "Your action"));
      await action.fill("Light the lantern.");
      await page
        .getByRole("button", {
          name: label(
            "从全新上下文发送行动",
            "Send action from a fresh context",
          ),
        })
        .click();
      await expect(
        page.getByText("The lantern was lit.", { exact: true }),
      ).toBeVisible();
      await setDetailedMode(true);
      await expect(page.locator(".is-detailed-mode")).toBeVisible();
      await expect(
        debuggerRegion.locator('[data-extension-status="completed"]'),
      ).toContainText("emit_debug_example");
      const record = debuggerRegion.getByText(
        "debug_example · superseded · artifact-debugger.example",
        { exact: true },
      );
      await record.click();
      await expect(
        debuggerRegion.getByText(payload, { exact: true }).first(),
      ).toBeVisible();
      expect(
        await page
          .getByText(payload, { exact: true })
          .evaluateAll((nodes) =>
            nodes.every((node) => node.closest("[data-artifact-debugger]")),
          ),
      ).toBe(true);
      await page.reload();
      await expect(page.locator(".is-detailed-mode")).toBeVisible();
      await expect(record).toBeVisible();
      await setDetailedMode(false);
      await expect(page.locator(".is-story-mode")).toBeVisible();
      await expect(debuggerRegion).toHaveCount(0);
      await expect(page.getByText(payload, { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-extension-mount="debug"]')).toHaveCount(
        0,
      );
      await page.reload();
      await expect(page.locator(".is-story-mode")).toBeVisible();
      await expect(debuggerRegion).toHaveCount(0);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain("debug_example");
      await test.info().attach("local-provider-requests", {
        body: bodies.join("\n"),
        contentType: "application/x-ndjson",
      });
    } finally {
      provider.closeAllConnections();
      const closed = once(provider, "close");
      provider.close();
      await closed;
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
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { result: T }).result;
}
