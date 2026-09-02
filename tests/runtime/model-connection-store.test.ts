import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
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
  await expect(
    store.save({
      name: "缺少凭据的新配置",
      presetId: "openai",
      provider: "openai_responses",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_000,
    }),
  ).rejects.toThrow("A new model configuration requires an API key");
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
    thinkingMode: "provider_default",
    thinkingBudgetTokens: null,
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

test("历史对话按冻结 binding 找回已保存模型，且不切换当前配置", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  await store.save({
    name: "历史对话模型",
    presetId: "openai",
    provider: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "historical-secret",
    modelId: "gpt-historical",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
  });
  const frozenBinding = new FileNativeModelHost(await store.bind()).binding();
  const current = await store.save({
    name: "当前模型",
    presetId: "custom",
    provider: "chat_completions",
    baseUrl: "http://127.0.0.1:4317/v1",
    apiKey: "current-secret",
    modelId: "current-model",
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
  });

  await expect(store.bindMatching(frozenBinding)).resolves.toMatchObject({
    apiKey: "historical-secret",
    modelId: "gpt-historical",
  });
  await expect(store.bind()).resolves.toMatchObject({
    apiKey: "current-secret",
    modelId: "current-model",
  });
  expect((await store.view()).activeConnectionId).toBe(
    current.activeConnectionId,
  );
  await expect(
    store.bindMatching({ ...frozenBinding, modelId: "missing-frozen-model" }),
  ).rejects.toThrow("No saved model connection matches");
});

test("克隆模型配置会复制本机凭据但保持当前配置不变", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const saved = await store.save({
    name: "Claude 主配置",
    presetId: "custom",
    provider: "anthropic_messages",
    dialect: "cliproxyapi",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "clone-secret",
    modelId: "claude-sonnet",
    reasoningEffort: "high",
    reasoningSummary: "auto",
    thinkingMode: "adaptive",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
  });
  const sourceId = saved.activeConnectionId!;

  const copied = await store.copy(sourceId, "Claude 主配置（副本）");

  expect(copied.copiedConnectionId).not.toBe(sourceId);
  expect(copied.library.activeConnectionId).toBe(sourceId);
  expect(copied.library.connections).toHaveLength(2);
  expect(copied.library.connections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: copied.copiedConnectionId,
        name: "Claude 主配置（副本）",
        provider: "anthropic_messages",
        dialect: "cliproxyapi",
        baseUrl: "http://127.0.0.1:8317/v1",
        modelId: "claude-sonnet",
        reasoningEffort: "high",
        reasoningSummary: "auto",
        thinkingMode: "adaptive",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        hasApiKey: true,
      }),
    ]),
  );
  expect(copied.library.connections[1]).not.toHaveProperty("apiKey");

  const path = join(root, "model-connections-v1.json");
  const persisted = JSON.parse(await readFile(path, "utf8")) as {
    activeConnectionId: string;
    connections: { id: string; apiKey: string }[];
  };
  expect(persisted.activeConnectionId).toBe(sourceId);
  expect(
    persisted.connections.find(({ id }) => id === copied.copiedConnectionId)
      ?.apiKey,
  ).toBe("clone-secret");
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

  const anthropic = await store.save({
    name: "Claude manual thinking",
    presetId: "custom",
    provider: "anthropic_messages",
    dialect: "cliproxyapi",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "proxy-secret",
    modelId: "claude-sonnet",
    reasoningEffort: "high",
    reasoningSummary: "none",
    thinkingMode: "enabled",
    thinkingBudgetTokens: 4_096,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
  });
  expect(
    anthropic.connections.find(({ name }) => name === "Claude manual thinking"),
  ).toMatchObject({
    reasoningEffort: "high",
    reasoningSummary: "none",
    thinkingMode: "enabled",
    thinkingBudgetTokens: 4_096,
  });

  const anthropicId = anthropic.connections.find(
    ({ name }) => name === "Claude manual thinking",
  )!.id;
  const disabled = await store.save({
    connectionId: anthropicId,
    name: "Claude thinking disabled",
    presetId: "custom",
    provider: "anthropic_messages",
    dialect: "cliproxyapi",
    baseUrl: "http://127.0.0.1:8317/v1",
    modelId: "claude-sonnet",
    reasoningEffort: "high",
    reasoningSummary: "provider_default",
    thinkingMode: "disabled",
    thinkingBudgetTokens: null,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
  });
  expect(
    disabled.connections.find(({ id }) => id === anthropicId),
  ).toMatchObject({
    id: anthropicId,
    thinkingMode: "disabled",
    thinkingBudgetTokens: null,
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
  ).rejects.toThrow("effort supports low, medium, high, xhigh, and max");
  await expect(
    store.save({
      name: "Invalid disabled Anthropic summary",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      thinkingMode: "disabled",
      reasoningSummary: "auto",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("can be configured only when Thinking is adaptive");

  await expect(
    store.save({
      name: "Invalid manual thinking budget",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      thinkingMode: "enabled",
      thinkingBudgetTokens: 2_000,
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).rejects.toThrow("must be lower than maximum output tokens");
  await expect(
    store.save({
      name: "Invalid detailed Anthropic summary",
      presetId: "custom",
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "secret",
      modelId: "claude",
      thinkingMode: "adaptive",
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

test("旧 Anthropic 配置无损迁移为独立 Thinking 模式", async () => {
  const root = await temporaryRoot();
  await writeFile(
    join(root, "model-connections-v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      activeConnectionId: "legacy-disabled",
      connections: [
        {
          id: "legacy-disabled",
          name: "Legacy disabled",
          presetId: "custom",
          provider: "anthropic_messages",
          dialect: "standard",
          baseUrl: "https://provider.invalid/v1",
          apiKey: "secret-disabled",
          modelId: "claude-disabled",
          reasoningEffort: "none",
          reasoningSummary: "provider_default",
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
        },
        {
          id: "legacy-adaptive",
          name: "Legacy adaptive",
          presetId: "custom",
          provider: "anthropic_messages",
          dialect: "standard",
          baseUrl: "https://provider.invalid/v1",
          apiKey: "secret-adaptive",
          modelId: "claude-adaptive",
          reasoningEffort: "high",
          reasoningSummary: "auto",
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
        },
        {
          id: "legacy-suffix-summary",
          name: "Legacy suffix summary",
          presetId: "custom",
          provider: "anthropic_messages",
          dialect: "cliproxyapi",
          baseUrl: "http://127.0.0.1:8317/v1",
          apiKey: "secret-suffix",
          modelId: "claude-sonnet(high)",
          reasoningEffort: "provider_default",
          reasoningSummary: "auto",
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );

  const view = await new ModelConnectionStore(root).view();

  expect(view.connections).toEqual([
    expect.objectContaining({
      id: "legacy-disabled",
      reasoningEffort: "provider_default",
      reasoningSummary: "provider_default",
      thinkingMode: "disabled",
      thinkingBudgetTokens: null,
    }),
    expect.objectContaining({
      id: "legacy-adaptive",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      thinkingMode: "adaptive",
      thinkingBudgetTokens: null,
    }),
    expect.objectContaining({
      id: "legacy-suffix-summary",
      reasoningEffort: "provider_default",
      reasoningSummary: "auto",
      thinkingMode: "provider_default",
      thinkingBudgetTokens: null,
    }),
  ]);
});

test("模型列表在协议和端点改变后仍复用已有配置的本机凭据", async () => {
  const root = await temporaryRoot();
  const fetch_ = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
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
      provider: "anthropic_messages",
      baseUrl: "https://other.invalid/v1",
    }),
  ).resolves.toEqual({ models: ["a-model", "z-model"] });
  expect((fetch_.mock.calls[1]?.[0] as URL).toString()).toBe(
    "https://other.invalid/v1/models?limit=1000",
  );
  expect(fetch_.mock.calls[1]?.[1]?.headers).toEqual({
    "anthropic-version": "2023-06-01",
    "x-api-key": "stored-secret",
  });
  expect(fetch_).toHaveBeenCalledTimes(2);
});

test("编辑已有配置时协议或端点变化均复用本机凭据", async () => {
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
      name: "新协议",
      presetId: "custom",
      provider: "openai_responses",
      baseUrl: "https://old.invalid/v1",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).resolves.toMatchObject({ activeConnectionId: connectionId });
  await expect(store.bind()).resolves.toMatchObject({
    provider: "openai_responses",
    baseUrl: "https://old.invalid/v1",
    apiKey: "old-secret",
  });
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
  ).resolves.toMatchObject({ activeConnectionId: connectionId });
  await expect(store.bind()).resolves.toMatchObject({
    provider: "openai_responses",
    baseUrl: "https://new.invalid/v1",
    apiKey: "old-secret",
  });
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
