import { once } from "node:events";
import { createServer } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

const modelId = "fixture-listed";
const apiKey = "fixture-key";

test.use({ runtimeScope: "model-protocol-options" });

test.afterEach(async ({ page }) => {
  const { connections, activeConnectionId } =
    await runtime<ModelConnectionLibraryView>(page, { type: "model.read" });
  for (const { id } of connections) {
    if (id !== activeConnectionId)
      await runtime(page, { type: "model.delete", connectionId: id });
  }
  if (activeConnectionId !== null)
    await runtime(page, {
      type: "model.delete",
      connectionId: activeConnectionId,
    });
});

for (const locale of ["zh-CN", "en"] as const) {
  const google = locale === "zh-CN";
  const t = (zh: string, en: string) => (google ? zh : en);
  const provider = google ? "google_interactions" : "openai_responses";

  test.describe(locale, () => {
    test("saves basic fields collapsed and recovers invalid advanced drafts on an existing connection", async ({
      page,
    }) => {
      const providerServer = createServer((request, response) => {
        const path = request.url?.split("?")[0];
        const authorized = google
          ? request.headers["x-goog-api-key"] === apiKey
          : request.headers.authorization === `Bearer ${apiKey}`;
        if (
          request.method !== "GET" ||
          !path?.endsWith("/models") ||
          !authorized
        ) {
          response.writeHead(404).end();
          return;
        }
        const ids = [modelId, "fixture-alternate"];
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify(
              google
                ? { models: ids.map((id) => ({ name: `models/${id}` })) }
                : { data: ids.map((id) => ({ id })) },
            ),
          );
      });
      providerServer.listen(0, "127.0.0.1");
      try {
        await once(providerServer, "listening");
        const addr = providerServer.address();
        if (addr === null || typeof addr === "string")
          throw new Error("Mock model endpoint has no port");
        await checkConnectionForm(page, `http://127.0.0.1:${addr.port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          providerServer.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        });
      }
    });
  });

  async function checkConnectionForm(page: Page, service: string) {
    const baseUrl = `${service}/${google ? "v1beta" : "v1"}`;
    const basicName = t("普通配置", "Basic configuration");
    const oldName = t("已有连接", "Existing connection");
    const editedName = t("修改后的连接", "Edited connection");
    await runtime(page, { type: "preferences.save", locale });
    await page.goto("/#/models");

    const form = page.locator("form.config-form");
    const label = (zh: string, en: string) =>
      form.getByLabel(t(zh, en), { exact: true });
    const combo = (zh: string, en: string) =>
      form.getByRole("combobox", { name: t(zh, en), exact: true });
    const summary = form.getByText(
      t("高级协议选项", "Advanced protocol options"),
      { exact: true },
    );
    const adapter = label("协议适配器", "Protocol adapter");
    const base = label("Base URL", "Base URL");
    const key = label("API Key", "API Key");
    const name = label("配置名称", "Configuration name");
    const model = label("模型 ID", "Model ID");
    const fetched = label("已拉取的模型", "Fetched models");
    const effort = combo("Effort（推理强度）", "Effort (reasoning intensity)");
    const thinking = combo("Thinking 返回内容", "Returned thinking content");
    const save = form.getByRole("button", {
      name: t("保存模型连接并启用", "Save and enable model connection"),
      exact: true,
    });
    const fetchModels = form.getByRole("button", {
      name: t("从端点拉取模型", "Fetch models from endpoint"),
      exact: true,
    });
    const active = page.locator(".model-active-summary strong");

    await expect(
      form.getByRole("heading", { name: t("新建配置", "New configuration") }),
    ).toBeVisible();
    await expect(summary).toBeVisible();
    await expect(adapter).toBeHidden();
    await label("提供商", "Provider").selectOption(
      google ? "google-interactions" : "openai",
    );
    await expect(base).toHaveValue(
      google
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://api.openai.com/v1",
    );
    await name.fill(basicName);
    await base.fill(baseUrl);
    await expect(key).toHaveAttribute("required", "");
    await key.fill(apiKey);
    await fetchModels.click();
    await expect(fetched.locator("option")).toHaveCount(3);
    await fetched.selectOption(modelId);
    await expect(model).toHaveValue(modelId);
    await label("模型提示词（可选）", "Model prompt (optional)").fill(
      "Fixture prompt",
    );
    await label("真实 context window", "Actual context window").fill("64000");
    await label("最大输出 tokens", "Maximum output tokens").fill("8192");
    await expect(adapter).toBeHidden();
    await save.click();
    await expect(active).toHaveText(basicName);
    const {
      connections: [basic],
    } = await runtime<ModelConnectionLibraryView>(page, { type: "model.read" });
    if (basic === undefined) throw new Error("Missing saved basic connection");
    expect(basic).toMatchObject({
      provider,
      dialect: "standard",
      modelId,
      modelPrompt: "Fixture prompt",
      reasoningEffort: "provider_default",
      thinkingMode: "provider_default",
      supportsAllowedTools: true,
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_192,
    });

    await runtime(page, {
      type: "model.save",
      connection: {
        name: oldName,
        presetId: "custom",
        provider,
        dialect: google ? "standard" : "cliproxyapi",
        baseUrl,
        apiKey,
        modelId,
        reasoningSummary: google ? "auto" : "concise",
        ...(google
          ? { thinkingMode: "enabled", thinkingBudgetTokens: 2_048 }
          : { supportsAllowedTools: false, responsesCacheControl: true }),
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      },
    });
    await runtime(page, { type: "model.select", connectionId: basic.id });
    await page.reload();

    const oldCard = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: oldName, exact: true }),
    });
    await oldCard
      .getByRole("button", { name: t("编辑", "Edit"), exact: true })
      .click();
    await expect(name).toHaveValue(oldName);
    await expect(adapter).toBeHidden();
    await expect(key).toHaveValue("");
    await fetchModels.click();
    await fetched.selectOption("fixture-alternate");
    await base.fill(`${baseUrl}/alternate`);
    await expect(fetched).toHaveCount(0);
    await expect(key).not.toHaveAttribute("required", "");
    await fetchModels.click();
    await fetched.selectOption(modelId);

    const toggleKey = google ? "Enter" : "Space";
    await summary.press(toggleKey);
    await expect(adapter).toHaveValue(provider);
    await page.keyboard.press("Tab");
    await expect(adapter).toBeFocused();
    await expect(thinking).toHaveValue(google ? "auto" : "concise");
    const budget = label("Thinking budget tokens", "Thinking budget tokens");
    const cache = label(
      "CLIProxyAPI 转 Claude 的显式缓存标记",
      "Explicit cache markers for Claude via CLIProxyAPI",
    );
    const tools = label(
      "支持工具子集选择（allowed_tools）",
      "Supports tool subset selection (allowed_tools)",
    );
    const prefill = label(
      "中断回复的续写方式",
      "Interrupted response continuation",
    );
    if (google) {
      await expect(budget).toHaveValue("2048");
      await expect(prefill).toHaveCount(0);
      await budget.fill("-1");
    } else {
      await expect(label("端点方言", "Endpoint dialect")).toHaveValue(
        "cliproxyapi",
      );
      await expect(
        form.getByText(/CLIProxyAPI dialect enables only/u),
      ).toBeVisible();
      await expect(cache).toHaveValue("true");
      await expect(tools).toHaveValue("false");
      await prefill.selectOption("partial");
      await effort.selectOption("high");
      await model.fill(`${modelId}(high)`);
    }

    await name.fill(editedName);
    await summary.press(toggleKey);
    await expect(adapter).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: t("返回工作区", "Back to workspace"),
        exact: true,
      }),
    ).toBeDisabled();
    await oldCard
      .getByRole("button", {
        name: t("切换到此配置", "Switch to this configuration"),
        exact: true,
      })
      .click();
    await expect(active).toHaveText(oldName);
    await expect(name).toHaveValue(editedName);
    await expect(adapter).toBeHidden();

    await save.click();
    await expect(adapter).toBeVisible();
    if (google) {
      await expect(budget).toBeFocused();
      await expect(budget).toHaveValue("-1");
      await budget.fill("3072");
    } else {
      await expect(summary).toBeFocused();
      await expect(
        page.getByText(/model thinking suffixes override request effort/u),
      ).toBeVisible();
      await expect(prefill).toHaveValue("partial");
      await model.fill(modelId);
    }
    await expect(active).toHaveText(oldName);
    await summary.press(toggleKey);
    await expect(adapter).toBeHidden();
    await save.click();
    await expect(active).toHaveText(editedName);
    await page.reload();
    await expect(name).toHaveValue(editedName);
    await expect(adapter).toBeHidden();
    await summary.press(toggleKey);
    await expect(adapter).toHaveValue(provider);
    await expect(thinking).toHaveValue(google ? "auto" : "concise");
    if (google) {
      await expect(budget).toHaveValue("3072");
    } else {
      await expect(cache).toHaveValue("true");
      await expect(tools).toHaveValue("false");
      await expect(prefill).toHaveValue("partial");
      await expect(effort).toHaveValue("high");
    }
  }
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
