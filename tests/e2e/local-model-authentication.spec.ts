import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, type Page } from "@playwright/test";
import type { ModelConnectionLibraryView } from "../../src/protocol/modelConnections.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

const modelId = "local-fixture";
const toolCallId = "local-fixture-read";
const finalReply = "The local model read the scene and replied.";

test.use({ runtimeScope: "local-model-authentication" });

test.afterEach(async ({ page }) => {
  const library = await runtime<ModelConnectionLibraryView>(page, {
    type: "model.read",
  });
  for (const { id } of library.connections) {
    if (id !== library.activeConnectionId)
      await runtime(page, { type: "model.delete", connectionId: id });
  }
  if (library.activeConnectionId !== null)
    await runtime(page, {
      type: "model.delete",
      connectionId: library.activeConnectionId,
    });
});

for (const { locale, host, listenOn, scope } of [
  { locale: "zh-CN", host: "localhost", listenOn: "127.0.0.1", scope: "name" },
  { locale: "en", host: "127.0.0.1", listenOn: "127.0.0.1", scope: "ipv4" },
  { locale: "en", host: "[::1]", listenOn: "::1", scope: "ipv6" },
] as const) {
  test.describe(host, () => {
    test("lists, saves, reopens, clones and plays without authentication", async ({
      page,
    }) => {
      const requests: {
        method: string | undefined;
        path: string | undefined;
        headers: IncomingHttpHeaders;
        body: string;
      }[] = [];
      let completionCount = 0;
      const provider = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (body += chunk));
        request.on("end", () => {
          requests.push({
            method: request.method,
            path: request.url,
            headers: request.headers,
            body,
          });
          if (request.method === "GET" && request.url === "/v1/models") {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ data: [{ id: modelId }] }));
            return;
          }
          if (
            request.method !== "POST" ||
            request.url !== "/v1/chat/completions"
          ) {
            response.writeHead(404).end();
            return;
          }
          if (request.headers.authorization !== undefined) {
            response
              .writeHead(400)
              .end("The local endpoint accepts no Authorization header");
            return;
          }
          const delta =
            ++completionCount === 1
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCallId,
                      type: "function",
                      function: {
                        name: "context_read",
                        arguments: JSON.stringify({
                          ref: "@current-situation",
                        }),
                      },
                    },
                  ],
                }
              : { content: finalReply };
          response
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(
              `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`,
            );
        });
      });
      provider.listen(0, listenOn);
      try {
        await once(provider, "listening");
        const address = provider.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing local model fixture port");
        const baseUrl = `http://${host}:${address.port}/v1`;
        await runtime(page, { type: "preferences.save", locale });
        await page.goto("/#/models");
        const t = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
        const form = page.locator("form.config-form");
        const auth = form.getByLabel(t("鉴权方式", "Authentication"), {
          exact: true,
        });
        const key = form.getByLabel("API Key", { exact: true });
        const noKeyOption = auth.getByRole("option", {
          name: t("无需 API Key", "No API key"),
        });
        const base = form.getByLabel("Base URL", { exact: true });
        const name = form.getByLabel(t("配置名称", "Configuration name"), {
          exact: true,
        });
        const fetchModels = form.getByRole("button", {
          name: t("从端点拉取模型", "Fetch models from endpoint"),
        });
        const fetched = form.getByLabel(t("已拉取的模型", "Fetched models"));
        const save = form.getByRole("button", {
          name: t("保存模型连接并启用", "Save and enable model connection"),
        });
        const active = page.locator(".model-active-summary strong");
        const sourceName = "Local Model Fixture";
        const copyName = sourceName + t("（副本）", " (copy)");
        const card = (title: string) =>
          page.getByRole("article").filter({
            has: page.getByRole("heading", { name: title, exact: true }),
          });
        const switchTo = (title: string) =>
          card(title).getByRole("button", {
            name: t("切换到此配置", "Switch to this configuration"),
          });

        await expect(auth).toHaveValue("api_key");
        await expect(noKeyOption).toBeDisabled();
        await base.fill(baseUrl);
        await name.fill(sourceName);
        await expect(noKeyOption).toBeEnabled();
        await expect(fetchModels).toBeDisabled();
        await auth.selectOption({ label: t("无需 API Key", "No API key") });
        await expect(key).toHaveCount(0);
        await fetchModels.click();
        await fetched.selectOption(modelId);
        await save.click();
        await expect(active).toHaveText(sourceName);
        await page.reload();
        await expect(auth).toHaveValue("none");
        await expect(form.getByLabel(t("模型 ID", "Model ID"))).toHaveValue(
          modelId,
        );

        await card(sourceName)
          .getByRole("button", {
            name: t("克隆配置", "Clone configuration"),
          })
          .click();
        await expect(name).toHaveValue(copyName);
        await expect(active).toHaveText(sourceName);
        await expect(auth).toHaveValue("none");
        await switchTo(copyName).click();
        await expect(active).toHaveText(copyName);

        await auth.selectOption("api_key");
        await expect(key).toHaveAttribute("required", "");
        await key.fill("fixture-key");
        await save.click();
        await expect(key).not.toHaveAttribute("required", "");
        await fetchModels.click();
        await expect(fetched).toBeVisible();
        await auth.selectOption("none");
        await fetchModels.click();
        await expect(fetched).toBeVisible();
        await auth.selectOption("api_key");
        await expect(key).toHaveValue("");
        await expect(key).toHaveAttribute("required", "");
        await expect(fetchModels).toBeDisabled();
        await auth.selectOption("none");
        await save.click();
        await expect(
          form.getByText(
            t(
              "保存后会移除这份配置原有的 API Key。",
              "Saving removes the API key stored for this configuration.",
            ),
          ),
        ).toHaveCount(0);
        await page.reload();
        await expect(auth).toHaveValue("none");
        await base.fill("http://192.168.1.10/v1");
        await expect(auth).toHaveValue("api_key");
        await expect(noKeyOption).toBeDisabled();
        await expect(key).toHaveAttribute("required", "");
        await expect(fetchModels).toBeDisabled();
        await form
          .getByRole("button", {
            name: t("放弃修改", "Discard changes"),
            exact: true,
          })
          .click();
        await expect(auth).toHaveValue("none");
        await switchTo(sourceName).click();
        await expect(active).toHaveText(sourceName);
        await switchTo(copyName).click();
        await expect(active).toHaveText(copyName);

        const library = await runtime<ModelConnectionLibraryView>(page, {
          type: "model.read",
        });
        expect(library.connections).toHaveLength(2);
        expect(library.connections.map(({ hasApiKey }) => hasApiKey)).toEqual([
          false,
          false,
        ]);
        expect(
          library.connections.every((connection) => !("apiKey" in connection)),
        ).toBe(true);
        expect(library.activeConnectionId).toBe(
          library.connections.find(({ name }) => name === copyName)?.id,
        );

        const pack = await runtime<{ localId: string }>(page, {
          type: "content.create-sample",
          locale,
        });
        const { world } = await runtime<{ world: { worldId: string } }>(page, {
          type: "world.create",
          operationId: `local-model-auth-world-${scope}`,
          packageId: pack.localId,
          model: {
            provider: "chat_completions",
            modelId,
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_000,
          },
        });
        await page.goto(`/#/world/${world.worldId}`);
        await page
          .getByLabel(t("你的行动", "Your action"))
          .fill("Read the scene and reply.");
        await page
          .getByRole("button", {
            name: t("从全新上下文发送行动", "Send action from a fresh context"),
          })
          .click();
        await expect(page.getByText(finalReply, { exact: true })).toBeVisible();

        expect(
          requests.map(({ method, path, headers }) => [
            method,
            path,
            headers.authorization,
          ]),
        ).toEqual([
          ["GET", "/v1/models", undefined],
          ["GET", "/v1/models", "Bearer fixture-key"],
          ["GET", "/v1/models", undefined],
          ["POST", "/v1/chat/completions", undefined],
          ["POST", "/v1/chat/completions", undefined],
        ]);
        for (const { headers } of requests) {
          expect(headers).not.toHaveProperty("x-api-key");
          expect(headers).not.toHaveProperty("x-goog-api-key");
          expect(headers).not.toHaveProperty("proxy-authorization");
        }
        for (const { body } of requests.slice(-2))
          expect(JSON.parse(body)).toMatchObject({
            model: modelId,
            stream: true,
          });
        expect(JSON.parse(requests.at(-1)!.body)).toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              tool_calls: [expect.objectContaining({ id: toolCallId })],
            }),
            expect.objectContaining({
              role: "tool",
              tool_call_id: toolCallId,
              content: expect.stringContaining("current-situation"),
            }),
          ]),
        });
      } finally {
        provider.closeAllConnections();
        if (provider.listening)
          await new Promise<void>((resolve, reject) => {
            provider.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
      }
    });
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
