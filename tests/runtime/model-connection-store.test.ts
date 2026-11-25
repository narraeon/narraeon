import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { ModelConnectionStore } from "../../src/runtime/model/ModelConnectionStore.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

const roots: string[] = [];

test("预填充能力须显式开启，保存、复制和重载保持选择，旧连接默认关闭", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Compatible",
    presetId: "custom" as const,
    provider: "chat_completions" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "model",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  };
  const initial = await store.save(input);
  expect(initial.connections[0]?.assistantPrefillMode).toBe("disabled");
  const id = initial.activeConnectionId!;
  for (const mode of [
    "assistant",
    "prefix",
    "mistral_prefix",
    "partial",
  ] as const) {
    await store.save({
      ...input,
      connectionId: id,
      assistantPrefillMode: mode,
    });
    const reopened = new ModelConnectionStore(root);
    expect((await reopened.view()).connections[0]?.assistantPrefillMode).toBe(
      mode,
    );
    expect(await reopened.bind()).toMatchObject({ assistantPrefillMode: mode });
  }
  const copied = await store.copy(id, "Copy");
  expect(
    copied.library.connections.find(
      ({ id }) => id === copied.copiedConnectionId,
    ),
  ).toMatchObject({ assistantPrefillMode: "partial" });
  // Omitting the optional field on edit retains the saved explicit choice.
  await store.save({ ...input, connectionId: id });
  expect((await store.view()).connections[0]?.assistantPrefillMode).toBe(
    "partial",
  );
  const path = join(root, "model-connections-v1.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as {
    connections: { assistantPrefillMode?: string; modelPrompt?: string }[];
  };
  delete legacy.connections[0]!.assistantPrefillMode;
  delete legacy.connections[0]!.modelPrompt;
  await writeFile(path, JSON.stringify(legacy));
  expect(
    (await new ModelConnectionStore(root).view()).connections[0],
  ).toMatchObject({ assistantPrefillMode: "disabled", modelPrompt: "" });
});

test("预填充能力拒绝不匹配的协议和未知模式，损坏配置不静默启用", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Custom",
    presetId: "custom" as const,
    provider: "chat_completions" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "model",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  };
  await expect(
    store.save({
      ...input,
      provider: "google_interactions",
      assistantPrefillMode: "assistant",
    }),
  ).rejects.toThrow("does not support assistant prefill");
  for (const mode of ["assistant", "partial"] as const) {
    const saved = await store.save({
      ...input,
      provider: "openai_responses",
      assistantPrefillMode: mode,
    });
    expect(saved.connections.at(-1)?.assistantPrefillMode).toBe(mode);
  }
  await expect(
    store.save({
      ...input,
      provider: "openai_responses",
      assistantPrefillMode: "prefix",
    }),
  ).rejects.toThrow("only plain assistant or partial prefill");
  await expect(
    store.save({
      ...input,
      provider: "anthropic_messages",
      assistantPrefillMode: "partial",
    }),
  ).rejects.toThrow("only plain assistant prefill");
  await store.save({ ...input, assistantPrefillMode: "prefix" });
  const path = join(root, "model-connections-v1.json");
  const malformed = JSON.parse(await readFile(path, "utf8")) as {
    connections: { assistantPrefillMode: string }[];
  };
  malformed.connections[0]!.assistantPrefillMode = "automatic";
  await writeFile(path, JSON.stringify(malformed));
  await expect(new ModelConnectionStore(root).view()).rejects.toThrow(
    "Assistant prefill mode is invalid",
  );
});

test("Responses 两种能力独立保存，复制和绑定保留选择，旧连接默认关闭", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Proxy route",
    presetId: "custom" as const,
    provider: "openai_responses" as const,
    dialect: "cliproxyapi" as const,
    baseUrl: "https://proxy.invalid/v1",
    apiKey: "secret",
    modelId: "alias",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  };
  const initial = await store.save(input);
  const connectionId = initial.activeConnectionId!;
  const defaults = {
    responsesTurnInstructions: false,
    responsesCacheControl: false,
  };
  expect(initial.connections[0]).toMatchObject(defaults);
  for (const flags of [
    { responsesTurnInstructions: true, responsesCacheControl: false },
    { responsesTurnInstructions: false, responsesCacheControl: true },
  ]) {
    await store.save({ ...input, connectionId, ...flags });
    const reopened = new ModelConnectionStore(root);
    expect((await reopened.view()).connections[0]).toMatchObject(flags);
    expect(await reopened.bind()).toMatchObject(flags);
  }
  const enabled = {
    responsesTurnInstructions: true,
    responsesCacheControl: true,
  };
  await store.save({ ...input, connectionId, responsesTurnInstructions: true });
  const copied = await store.copy(connectionId, "Copy");
  expect(
    copied.library.connections.find(
      ({ id }) => id === copied.copiedConnectionId,
    ),
  ).toMatchObject(enabled);
  await store.save({ ...input, connectionId, dialect: "standard" });
  expect(await store.bind()).toMatchObject({ responsesTurnInstructions: true });
  expect(await store.bind()).not.toHaveProperty("responsesCacheControl");
  await store.save({ ...input, connectionId, provider: "chat_completions" });
  expect(await store.bind()).not.toHaveProperty("responsesTurnInstructions");
  const switchedBack = await store.save({ ...input, connectionId });
  expect(switchedBack.connections[0]).toMatchObject(defaults);

  const path = join(root, "model-connections-v1.json");
  const document = JSON.parse(await readFile(path, "utf8")) as {
    connections: {
      responsesTurnInstructions?: boolean;
      responsesCacheControl?: boolean;
    }[];
  };
  delete document.connections[0]!.responsesTurnInstructions;
  delete document.connections[0]!.responsesCacheControl;
  await writeFile(path, JSON.stringify(document));
  expect(await new ModelConnectionStore(root).bind()).toMatchObject(defaults);
});

test("Anthropic 缓存时长按连接持久化，旧连接默认 5 分钟，切换协议后清除", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Anthropic",
    presetId: "custom" as const,
    provider: "anthropic_messages" as const,
    baseUrl: "https://proxy.invalid/v1",
    apiKey: "secret",
    modelId: "alias",
    contextWindowTokens: 32_000,
    maxOutputTokens: 2_000,
  };
  const first = await store.save(input);
  const connectionId = first.activeConnectionId!;
  expect(first.connections[0]?.anthropicPromptCacheTtl).toBe("5m");
  await store.save({ ...input, connectionId, anthropicPromptCacheTtl: "1h" });
  await store.save({ ...input, connectionId });
  const second = await store.save({ ...input, name: "Other Anthropic" });
  const otherId = second.activeConnectionId!;
  expect(second.connections[1]?.anthropicPromptCacheTtl).toBe("5m");
  const path = join(root, "model-connections-v1.json");
  const document = JSON.parse(await readFile(path, "utf8")) as {
    connections: { anthropicPromptCacheTtl?: string }[];
  };
  expect(document.connections[0]?.anthropicPromptCacheTtl).toBe("1h");
  delete document.connections[1]!.anthropicPromptCacheTtl;
  await writeFile(path, JSON.stringify(document));

  const reopened = new ModelConnectionStore(root);
  expect(
    (await reopened.view()).connections.map(
      (item) => item.anthropicPromptCacheTtl,
    ),
  ).toEqual(["1h", "5m"]);
  expect((await reopened.bind()).anthropicPromptCacheTtl).toBe("5m");
  await reopened.select(connectionId);
  expect((await reopened.bind()).anthropicPromptCacheTtl).toBe("1h");
  const copy = await reopened.copy(connectionId, "Copy");
  expect(
    copy.library.connections.find(({ id }) => id === copy.copiedConnectionId)
      ?.anthropicPromptCacheTtl,
  ).toBe("1h");

  for (const provider of [
    "chat_completions",
    "openai_responses",
    "google_interactions",
  ] as const) {
    await expect(
      reopened.save({
        ...input,
        connectionId,
        provider,
        anthropicPromptCacheTtl: "1h",
      }),
    ).rejects.toThrow("requires the Anthropic Messages protocol");
    const switched = await reopened.save({ ...input, connectionId, provider });
    expect(switched.connections[0]).not.toHaveProperty(
      "anthropicPromptCacheTtl",
    );
    expect(await reopened.bind()).not.toHaveProperty("anthropicPromptCacheTtl");
    expect(
      switched.connections.find(({ id }) => id === otherId)
        ?.anthropicPromptCacheTtl,
    ).toBe("5m");
  }
  const restored = await reopened.save({ ...input, connectionId });
  expect(restored.connections[0]?.anthropicPromptCacheTtl).toBe("5m");
  await expect(
    reopened.save({
      ...input,
      connectionId,
      anthropicPromptCacheTtl: "24h" as "1h",
    }),
  ).rejects.toThrow("must be 5m or 1h");
});

test("Responses 拒绝与协议或方言不匹配的能力及损坏的能力配置", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Responses",
    presetId: "custom" as const,
    provider: "openai_responses" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "alias",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  };
  await expect(
    store.save({ ...input, responsesCacheControl: true }),
  ).rejects.toThrow("CLIProxyAPI");
  await expect(
    store.save({
      ...input,
      provider: "anthropic_messages",
      responsesTurnInstructions: true,
    }),
  ).rejects.toThrow("Responses protocol");
  await store.save(input);
  const path = join(root, "model-connections-v1.json");
  const document = JSON.parse(await readFile(path, "utf8")) as {
    connections: { responsesTurnInstructions: unknown }[];
  };
  document.connections[0]!.responsesTurnInstructions = "false";
  await writeFile(path, JSON.stringify(document));
  await expect(new ModelConnectionStore(root).view()).rejects.toThrow(
    "must be booleans",
  );
});

test("Responses 工具子集能力按连接保存，旧连接默认开启", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const input = {
    name: "Responses",
    presetId: "openai" as const,
    provider: "openai_responses" as const,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    modelId: "model",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  };
  const initial = await store.save(input);
  expect(initial.connections[0]?.supportsAllowedTools).toBe(true);
  const id = initial.activeConnectionId!;
  await store.save({ ...input, connectionId: id, supportsAllowedTools: false });
  const reopened = new ModelConnectionStore(root);
  expect((await reopened.view()).connections[0]?.supportsAllowedTools).toBe(
    false,
  );
  expect((await reopened.bind()).supportsAllowedTools).toBe(false);
  const path = join(root, "model-connections-v1.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as {
    connections: { supportsAllowedTools?: boolean }[];
  };
  delete legacy.connections[0]!.supportsAllowedTools;
  await writeFile(path, JSON.stringify(legacy));
  expect(
    (await new ModelConnectionStore(root).view()).connections[0]
      ?.supportsAllowedTools,
  ).toBe(true);
});

test("Google Interactions 保存手动模型 ID 并在重载后保留 Provider 默认配置", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const saved = await store.save({
    name: "Gemini",
    presetId: "google-interactions",
    provider: "google_interactions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "synthetic-secret",
    modelId: "manual-model-id",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
  });
  expect(saved.connections[0]).toMatchObject({
    provider: "google_interactions",
    modelId: "manual-model-id",
    reasoningEffort: "provider_default",
    reasoningSummary: "provider_default",
  });
  expect(saved.connections[0]).not.toHaveProperty("apiKey");
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject({
    provider: "google_interactions",
    modelId: "manual-model-id",
    apiKey: "synthetic-secret",
  });
});

test("Google 自定义模型可保存推理设置并从磁盘重载", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const settings = {
    dialect: "cliproxyapi",
    reasoningEffort: "high",
    reasoningSummary: "auto",
  } as const;
  await store.save({
    name: "Gemini",
    presetId: "custom",
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/v1beta",
    apiKey: "synthetic-secret",
    modelId: "unknown-model",
    ...settings,
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
  });
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject(
    settings,
  );
});

test("Google 标准配置保留旧预算供编辑，新保存需要明确改用可用设置", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const connection = {
    name: "Gemini",
    presetId: "custom",
    provider: "google_interactions",
    baseUrl: "https://provider.invalid/v1beta",
    modelId: "gemini-4-hydrogen",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
  } as const;
  const budget = { thinkingMode: "enabled", thinkingBudgetTokens: 64 } as const;
  const proxy = await store.save({
    ...connection,
    ...budget,
    dialect: "cliproxyapi",
    apiKey: "fixture",
  });
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject({
    ...budget,
    dialect: "cliproxyapi",
  });
  const path = join(root, "model-connections-v1.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as {
    connections: { dialect: string }[];
  };
  legacy.connections[0]!.dialect = "standard";
  const legacyJson = JSON.stringify(legacy);
  await writeFile(path, legacyJson);

  const reopened = new ModelConnectionStore(root);
  const connectionId = proxy.activeConnectionId!;
  expect((await reopened.view()).connections[0]).toMatchObject({
    id: connectionId,
    dialect: "standard",
    ...budget,
  });
  await expect(reopened.save({ ...connection, connectionId })).rejects.toThrow(
    /does not support thinking budgets.*Provider default/u,
  );
  await expect(
    reopened.save({
      ...connection,
      dialect: "standard",
      apiKey: "fixture",
      thinkingMode: "disabled",
    }),
  ).rejects.toThrow("does not support thinking budgets");
  expect(await readFile(path, "utf8")).toBe(legacyJson);

  const updated = {
    ...connection,
    connectionId,
    reasoningEffort: "xhigh",
    reasoningSummary: "auto",
    thinkingMode: "provider_default",
  } as const;
  await expect(
    reopened.save({ ...updated, modelId: "gemini-4-carbon" }),
  ).rejects.toThrow(
    "xhigh is available for Gemini 4 Neon and Gemini 4 Hydrogen",
  );
  await reopened.save(updated);
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject({
    dialect: "standard",
    modelId: "gemini-4-hydrogen",
    reasoningEffort: "xhigh",
    reasoningSummary: "auto",
    thinkingMode: "provider_default",
    thinkingBudgetTokens: null,
  });
});

test("Google Gemini 4 Neon 的旧 minimal 保留供纠正，标准连接不能保存该等级", async () => {
  const root = await temporaryRoot();
  const store = new ModelConnectionStore(root);
  const connection = {
    name: "Gemini",
    presetId: "google-interactions",
    provider: "google_interactions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-4-neon",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
  } as const;
  const reason = /minimal is unavailable.*choose Provider default/u;
  await expect(
    store.save({
      ...connection,
      apiKey: "fixture",
      reasoningEffort: "minimal",
    }),
  ).rejects.toThrow(reason);
  const { activeConnectionId } = await store.save({
    ...connection,
    apiKey: "fixture",
  });
  const connectionId = activeConnectionId!;
  const path = join(root, "model-connections-v1.json");
  const legacy = JSON.parse(await readFile(path, "utf8")) as {
    connections: { reasoningEffort: string }[];
  };
  legacy.connections[0]!.reasoningEffort = "minimal";
  await writeFile(path, JSON.stringify(legacy));

  const reopened = new ModelConnectionStore(root);
  expect((await reopened.view()).connections[0]).toMatchObject({
    id: connectionId,
    reasoningEffort: "minimal",
  });
  await expect(reopened.save({ ...connection, connectionId })).rejects.toThrow(
    reason,
  );
  await reopened.save({ ...connection, connectionId, reasoningEffort: "low" });
  await expect(new ModelConnectionStore(root).bind()).resolves.toMatchObject({
    dialect: "standard",
    modelId: "gemini-4-neon",
    reasoningEffort: "low",
  });
});

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

test("模型列表仅在同一来源复用已有配置的本机凭据", async () => {
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

  const changedAddress = {
    connectionId: saved.activeConnectionId!,
    provider: "anthropic_messages" as const,
    baseUrl: "https://other.invalid/v1",
  };
  await expect(store.listModels(changedAddress)).rejects.toThrow(
    "Changing the model service origin requires an API key",
  );
  expect(fetch_).toHaveBeenCalledTimes(1);

  await expect(
    store.listModels({ ...changedAddress, apiKey: "new-secret" }),
  ).resolves.toEqual({ models: ["a-model", "z-model"] });
  expect((fetch_.mock.calls[1]?.[0] as URL).toString()).toBe(
    "https://other.invalid/v1/models?limit=1000",
  );
  expect(fetch_.mock.calls[1]?.[1]?.headers).toEqual({
    "anthropic-version": "2023-06-01",
    "x-api-key": "new-secret",
  });
  expect(fetch_).toHaveBeenCalledTimes(2);
});

test("Google 模型列表使用已存凭据逐页读取原生资源名", async () => {
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        nextPageToken: "next+/=",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        models: [
          { name: "models/gemini-a" },
          { name: "models/gemini-b" },
          { name: "models/" },
        ],
      }),
    );
  const store = new ModelConnectionStore(await temporaryRoot(), fetch_);
  const saved = await store.save({
    provider: "google_interactions",
    presetId: "google-interactions",
    name: "Google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "stored-secret",
    modelId: "manual-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
  });
  await expect(
    store.listModels({
      provider: "google_interactions",
      baseUrl: "https://generativelanguage.googleapis.com:443/v1beta/",
      connectionId: saved.activeConnectionId!,
    }),
  ).resolves.toEqual({ models: ["gemini-a", "gemini-b"] });
  const urls = fetch_.mock.calls.map(([url]) => url as URL);
  expect(urls.map((url) => url.pathname)).toEqual([
    "/v1beta/models",
    "/v1beta/models",
  ]);
  expect(urls.map((url) => url.searchParams.get("pageToken"))).toEqual([
    null,
    "next+/=",
  ]);
  for (const [, options] of fetch_.mock.calls) {
    expect(options?.headers).toEqual({ "x-goog-api-key": "stored-secret" });
    expect(options?.redirect).toBe("error");
  }
});

test.each([
  [() => Response.json({ models: [] }), "no usable model IDs"],
  [
    () => Response.json({ models: [], nextPageToken: "repeat" }),
    "repeated page token",
  ],
  [() => new Response("key rejected", { status: 403 }), "403 key rejected"],
])("Google 列表失败时报告端点错误", async (response, message) => {
  const store = new ModelConnectionStore(await temporaryRoot(), () =>
    Promise.resolve(response()),
  );
  await expect(
    store.listModels({
      provider: "google_interactions",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "test-key",
    }),
  ).rejects.toThrow(message);
});

test("模型列表错误保留普通文本说明并遮蔽已知凭据和敏感字段", async () => {
  const store = new ModelConnectionStore(await temporaryRoot(), () =>
    Promise.resolve(
      new Response(
        "Model list denied for list-key\nAuthorization: Bearer mock-token",
        { status: 403 },
      ),
    ),
  );
  await expect(
    store.listModels({
      provider: "anthropic_messages",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "list-key",
    }),
  ).rejects.toThrow(
    "Failed to fetch model list: 403 Model list denied for [redacted]\nAuthorization: [redacted]",
  );
});

test("编辑已有配置时仅在同一来源复用本机凭据", async () => {
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
  for (const baseUrl of [
    "https://new.invalid/v1",
    "https://old.invalid:8443/v1",
    "http://old.invalid/v1",
  ]) {
    await expect(
      store.save({
        connectionId,
        name: "新端点",
        presetId: "custom",
        provider: "openai_responses",
        baseUrl,
        modelId: "model",
        contextWindowTokens: 32_000,
        maxOutputTokens: 2_000,
      }),
    ).rejects.toThrow("Changing the model service origin requires an API key");
  }
  await expect(store.bind()).resolves.toMatchObject({
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
      apiKey: "new-secret",
      modelId: "model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    }),
  ).resolves.toMatchObject({ activeConnectionId: connectionId });
  await expect(store.bind()).resolves.toMatchObject({ apiKey: "new-secret" });
});

test("Anthropic 模型列表仅跟随同源重定向", async () => {
  const fetch_ = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.redirect("https://provider.invalid/api/models"),
    )
    .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-test" }] }))
    .mockResolvedValueOnce(Response.redirect("https://other.invalid/models"));
  const store = new ModelConnectionStore(await temporaryRoot(), fetch_);
  const input = {
    provider: "anthropic_messages" as const,
    baseUrl: "https://provider.invalid/v1",
    apiKey: "synthetic-key",
  };
  await expect(store.listModels(input)).resolves.toEqual({
    models: ["claude-test"],
  });
  const [target, options] = fetch_.mock.calls[1]!;
  expect(target).toEqual(new URL("https://provider.invalid/api/models"));
  expect(options).toMatchObject({
    redirect: "manual",
    headers: { "x-api-key": "synthetic-key" },
  });
  await expect(store.listModels(input)).rejects.toThrow("redirect");
  expect(fetch_).toHaveBeenCalledTimes(3);
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

test.each([false, true])(
  "Prompt Preview 使用已保存的 Responses 本轮提示开关 %s，忽略浏览器提供的绑定",
  async (responsesTurnInstructions) => {
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
        responsesTurnInstructions,
        baseUrl: "https://provider.invalid/v1",
        apiKey: "provider-credential-not-in-preview-9f49",
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
      turnNote: "Keep this scene brief.",
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
    const { body } = (
      preview.result as {
        wireRequest: {
          body: {
            instructions: string;
            input: { role?: string; content?: string }[];
          };
        };
      }
    ).wireRequest;
    expect(body.input[0]?.role).toBe("developer");
    expect(body.instructions).toContain("[Runtime turn guide]");
    const note = "Player's request for this turn: Keep this scene brief.";
    if (responsesTurnInstructions) {
      expect(body.instructions).toContain(note);
      expect(JSON.stringify(body.input)).not.toContain(note);
    } else {
      expect(body.instructions).not.toContain(note);
      expect(body.input.at(-1)).toEqual({ role: "user", content: note });
    }
    expect(JSON.stringify(preview.result)).not.toContain(
      "provider-credential-not-in-preview-9f49",
    );
    expect(JSON.stringify(preview.result)).not.toContain(
      "browser-forged-model",
    );
  },
);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narraeon-model-connections-"));
  roots.push(root);
  return root;
}
