import { expect, test } from "vitest";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { comparePromptPrefixes } from "../../src/runtime/prompt/WorldPromptDiagnostics.ts";

test("比较真实编码和材料来源，CLIProxyAPI 跨上下文缓存键仍保持隔离", () => {
  const host = new FileNativeModelHost({
    provider: "chat_completions",
    dialect: "cliproxyapi",
    baseUrl: "https://provider.invalid/v1",
    apiKey: "secret",
    modelId: "prefix-test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
  });
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "prefix-test",
    contextWindowTokens: 32000,
    maxOutputTokens: 2000,
    playerInput: "",
    playerInputPlacement: "append",
  });
  input.modelBinding = host.binding();
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(input);
  const changed = structuredClone(bootstrap);
  const world = changed.logicalMessages.find(
    ({ role }) => role === "world_context",
  )!;
  world.blocks[0]!.markdown += "\n新增目录条目";
  world.markdown = world.blocks.map(({ markdown }) => markdown).join("\n\n");
  const encode = (operationId: string) =>
    host.previewRequest({
      bootstrap,
      tools: bootstrap.tools,
      appended: [{ kind: "player", text: "继续" }],
      operationId,
      maxOutputTokens: 2000,
    });
  const before = encode("first");
  const after = encode("second");
  const report = comparePromptPrefixes(
    { bootstrap, encoding: before },
    { bootstrap: changed, encoding: after },
  );
  expect(report.logical?.commonPrefixBytes).toBeGreaterThan(0);
  expect(report.logical?.changedSources).toContainEqual(
    expect.objectContaining({
      source: world.blocks[0]!.source,
      change: "changed",
    }),
  );
  expect(report.encoding.cacheKey).toBe("different");
  expect(report.encoding.firstChangedPath).toBe("prompt_cache_key");
  expect(report.encoding.commonJsonPrefixBytes).toBeGreaterThan(0);
  expect(report.encoding.current?.cacheBreakpoints.length).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain("secret");
  expect(report.cacheBenefit).toBe("not_measured");
});

test("没有历史样本时不虚构缓存命中或变更频率", () => {
  const bootstrap = new FileNativePromptCompiler().compileBootstrap(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
      playerInput: "",
      playerInputPlacement: "append",
    }),
  );
  const report = comparePromptPrefixes(null, { bootstrap });
  expect(report.logical).toBeNull();
  expect(report.encoding.commonJsonPrefixBytes).toBeNull();
  expect(report.encoding.cacheKey).toBe("unavailable");
  expect(report.suggestions).toEqual([]);
});
