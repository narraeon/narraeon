import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { ModelConnectionStore } from "../../src/runtime/model/ModelConnectionStore.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("保存多份模型配置、显式切换并且不向浏览器返回 API Key", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const first = await store.save({
    name: "OpenAI 主配置",
    presetId: "openai",
    provider: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "openai-secret",
    modelId: "gpt-test",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
  });
  const firstId = first.activeConnectionId!;
  expect(first).toMatchObject({
    configured: true,
    activeConnectionId: firstId,
  });
  expect(first.connections[0]).not.toHaveProperty("apiKey");
  expect(first.connections[0]).toMatchObject({
    id: firstId,
    name: "OpenAI 主配置",
    dialect: "standard",
    reasoningEffort: "provider_default",
    reasoningSummary: "provider_default",
    hasApiKey: true,
  });

  const second = await store.save({
    name: "本地兼容端点",
    presetId: "custom",
    provider: "chat_completions",
    baseUrl: "http://127.0.0.1:4317/v1/",
    apiKey: "local-secret",
    modelId: "local-model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
  });
  const secondId = second.activeConnectionId!;
  expect(secondId).not.toBe(firstId);
  expect(second.connections).toHaveLength(2);

  const selected = await store.select(firstId);
  expect(selected.activeConnectionId).toBe(firstId);
  await expect(store.delete(firstId)).rejects.toThrow(
    "Switch to another model configuration before deleting the current one",
  );
  await expect(store.bind()).resolves.toMatchObject({
    provider: "openai_responses",
    apiKey: "openai-secret",
  });

  const updated = await store.save({
    connectionId: firstId,
    name: "OpenAI 更新",
    presetId: "openai",
    provider: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-new",
    contextWindowTokens: 256_000,
    maxOutputTokens: 32_000,
  });
  expect(updated.activeConnectionId).toBe(firstId);
  await expect(store.bind()).resolves.toMatchObject({
    apiKey: "openai-secret",
    modelId: "gpt-new",
  });

  await store.delete(secondId);
  expect((await store.view()).connections).toHaveLength(1);
  const path = join(root, "model-connections-v1.json");
  expect((await stat(path)).mode & 0o077).toBe(0);
  const persisted = JSON.parse(await readFile(path, "utf8")) as {
    connections: { apiKey: string }[];
  };
  expect(persisted.connections[0]?.apiKey).toBe("openai-secret");
});

test("模型配置持久化方言与推理策略，并拒绝协议没有定义的组合", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const saved = await store.save({
    name: "CLIProxy Chat",
    presetId: "custom",
    provider: "chat_completions",
    dialect: "cliproxyapi",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "proxy-secret",
    modelId: "deepseek-reasoner",
    reasoningEffort: "high",
    reasoningSummary: "none",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
  });
  expect(saved.connections[0]).toMatchObject({
    dialect: "cliproxyapi",
    reasoningEffort: "high",
    reasoningSummary: "none",
  });
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject({
    dialect: "cliproxyapi",
    reasoningEffort: "high",
    reasoningSummary: "none",
  });

  await expect(
    store.save({
      name: "Invalid standard Chat summary",
      presetId: "custom",
      provider: "chat_completions",
      dialect: "standard",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "model",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("has no reasoning-summary parameter");
  await expect(
    store.save({
      name: "Invalid Anthropic minimal",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      reasoningEffort: "minimal",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("does not define minimal effort");
  await expect(
    store.save({
      name: "Invalid disabled Anthropic summary",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      reasoningEffort: "none",
      reasoningSummary: "auto",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("cannot return a reasoning summary");
  await expect(
    store.save({
      name: "Invalid detailed Anthropic summary",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      reasoningSummary: "detailed",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("defined only by OpenAI Responses");
  await expect(
    store.save({
      name: "Conflicting CLIProxy effort",
      presetId: "custom",
      provider: "openai_responses",
      dialect: "cliproxyapi",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "proxy-secret",
      modelId: "claude-test(high)",
      reasoningEffort: "low",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("model thinking suffixes override request effort");
});

test("模型列表使用当前端点的正确凭据且不把旧凭据带到已修改端点", async () => {
  const root = await temporaryRoot();
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          { id: "z-model" },
          { id: "a-model" },
          { id: "a-model" },
          { missing: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const store = new ModelConnectionStore(root, fetch_);
  const saved = await store.save({
    name: "兼容端点",
    presetId: "custom",
    provider: "chat_completions",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "stored-secret",
    modelId: "a-model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
  });
  await expect(
    store.listModels({
      connectionId: saved.activeConnectionId!,
      provider: "chat_completions",
      baseUrl: "https://provider.invalid/v1",
    }),
  ).resolves.toEqual({ models: ["a-model", "z-model"] });
  expect((fetch_.mock.calls[0]?.[0] as URL).toString()).toBe(
    "https://provider.invalid/v1/models",
  );
  expect(fetch_.mock.calls[0]?.[1]?.headers).toEqual({
    Authorization: "Bearer stored-secret",
  });

  await expect(
    store.listModels({
      connectionId: saved.activeConnectionId!,
      provider: "chat_completions",
      baseUrl: "https://other.invalid/v1",
    }),
  ).rejects.toThrow(
    "The endpoint or protocol changed; enter the API key again before fetching models",
  );
  expect(fetch_).toHaveBeenCalledTimes(1);
});

test("编辑配置时不会把旧端点凭据静默带到新端点", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const saved = await store.save({
    name: "旧端点",
    presetId: "custom",
    provider: "chat_completions",
    baseUrl: "https://old.invalid/v1",
    apiKey: "old-secret",
    modelId: "model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
  });
  const connectionId = saved.activeConnectionId!;
  await expect(
    store.save({
      connectionId,
      name: "新端点",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://new.invalid/v1",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("old credentials are never forwarded to a new endpoint");
  await expect(
    store.save({
      connectionId,
      name: "新端点",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://new.invalid/v1",
      apiKey: "new-secret",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).resolves.toMatchObject({ activeConnectionId: connectionId });
  await expect(store.bind()).resolves.toMatchObject({ apiKey: "new-secret" });
});

test("Anthropic 模型列表使用原生 models 接口和请求头", async () => {
  const root = await temporaryRoot();
  const fetch_ = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), {
      status: 200,
    }),
  );
  const store = new ModelConnectionStore(root, fetch_);
  await expect(
    store.listModels({
      provider: "anthropic_messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-secret",
    }),
  ).resolves.toEqual({ models: ["claude-test"] });
  expect((fetch_.mock.calls[0]?.[0] as URL).toString()).toBe(
    "https://api.anthropic.com/v1/models?limit=1000",
  );
  expect(fetch_.mock.calls[0]?.[1]?.headers).toEqual({
    "anthropic-version": "2023-06-01",
    "x-api-key": "anthropic-secret",
  });
});

test("内置提供商不能静默绑定到另一端点，自定义端点仍可保存", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  await expect(
    store.save({
      name: "伪装 OpenAI",
      presetId: "openai",
      provider: "openai_responses",
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "secret",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("select Custom endpoint for a custom configuration");
  await expect(
    store.save({
      name: "显式自定义",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://proxy.invalid/v1",
      apiKey: "secret",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).resolves.toMatchObject({ configured: true });
});

test("Prompt Preview 只采用 Runtime 当前配置，不信任浏览器提交的模型绑定", async () => {
  const root = await temporaryRoot();
  const runtime = new V1Runtime({
    dataRoot: join(root, "data"),
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  await runtime.handle({
    type: "model.save",
    connection: {
      name: "Runtime 当前",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "runtime-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 8_000,
    },
  });
  const created = await runtime.handle({ type: "content.create" });
  const packageId = (created.result as { localId: string }).localId;
  const preview = await runtime.handle({
    type: "prompt.preview",
    packageId,
    playerInput: "Check the binding.",
    model: {
      provider: "chat_completions",
      modelId: "browser-forged-model",
      contextWindowTokens: 9_999_999,
      maxOutputTokens: 999_999,
    },
  });
  expect(preview.result).toMatchObject({
    diagnosticBinding: { modelId: "runtime-model" },
    compilation: {
      provider: { protocol: "openai_responses" },
      budget: { contextWindowTokens: 64_000 },
    },
    wireRequest: {
      provider: "openai_responses",
      method: "POST",
      endpointPath: "/v1/responses",
      body: {
        model: "runtime-model",
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
      },
    },
  });
  expect(JSON.stringify(preview.result)).not.toContain("secret");
  expect(JSON.stringify(preview.result)).not.toContain("browser-forged-model");
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-model-connections-"));
  roots.push(root);
  return root;
}
