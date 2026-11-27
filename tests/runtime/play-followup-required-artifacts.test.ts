import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { chatGptPlanBaseUrl } from "../../src/runtime/model/FileNativeModelConnection.ts";
import {
  FileNativeAiFailureLog,
  type AiExchangeDiagnostics,
  type AiFailureDescription,
} from "../../src/runtime/model/AiFailureLog.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import {
  applyPlayPresetStructuredEditor,
  parsePlayPresetFiles,
  toPlayPresetStructuredEditor,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { runPlayFollowupRequests } from "../../src/runtime/play/PlayFollowupRequests.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  firstPartyActionChoicesPresetFiles,
  firstPartyActionChoicesPresetFilesForLocale,
} from "../../src/shared/first-party-action-choices.ts";

const emitRecap = {
  id: "emit",
  name: "artifact_emit",
  arguments: { output: "recap", payload: "The scene is ready." },
};
const clearRecap = {
  id: "clear",
  name: "artifact_clear",
  arguments: { output: "recap" },
};
const rejectRecap = {
  id: "bad-emit",
  name: "artifact_emit",
  arguments: { output: "recap", payload: 42 },
};
const rejectOther = {
  id: "bad-clear",
  name: "artifact_clear",
  arguments: { output: "undeclared" },
};

const missing = { kind: "format_validation", details: { missing: ["recap"] } };
const missingMessage =
  "Follow-up request builtin:summary did not submit required artifacts: recap";

test.each([
  {
    title: "成功 emit",
    toolCalls: [emitRecap],
    toolResults: [true],
    failure: undefined,
    failures: [],
  },
  {
    title: "仅 clear",
    toolCalls: [clearRecap],
    toolResults: [true],
    failure: missingMessage,
    failures: [missing],
  },
  {
    title: "emit 失败",
    toolCalls: [rejectRecap],
    toolResults: [false],
    failure: missingMessage,
    failures: [{ kind: "tool_execution" }, missing],
  },
  {
    title: "必填产物已提交后另一个调用失败",
    toolCalls: [emitRecap, rejectOther],
    toolResults: [true, false],
    failure: "Follow-up request builtin:summary could not save its artifacts.",
    failures: [{ kind: "tool_execution" }],
  },
])(
  "后置请求在$title 时按实际提交记录必填结果与诊断",
  async ({ toolCalls, toolResults, failure, failures }) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-required-artifacts-"));
    try {
      const logRoot = join(root, "logs");
      const failureLog = new FileNativeAiFailureLog(logRoot);
      const preview = requiredRecapPreview();
      const diagnostics: AiExchangeDiagnostics = {
        captureId: "followup-exchange",
        provider: "chat_completions",
        endpoint: "https://provider.invalid/v1/chat/completions",
        context: {
          scope: "play_followup",
          requestId: "builtin:summary",
          operationId: "run",
        },
        request: {
          method: "POST",
          contentType: "application/json",
          body: "{}",
        },
        response: {
          status: 200,
          statusText: "OK",
          contentType: "application/json",
          body: JSON.stringify({ toolCalls }),
          bodyComplete: true,
        },
      };
      await failureLog.recordFailure({
        exchange: { ...diagnostics, captureId: "prior-exchange" },
        failures: [
          { kind: "provider_rejection", message: "Previous rejection" },
        ],
      });
      const artifacts = new FileNativeArtifactStore(root);
      const run = await runPlayFollowupRequests({
        artifacts,
        modelHost: new ScriptedModelHost({
          binding: {
            provider: "chat_completions",
            endpointFingerprint: "fixture",
            modelId: "fixture",
            contextWindowTokens: 32_000,
            maxOutputTokens: 2_000,
            protocolConfigFingerprint: "fixture",
          },
          steps: [{ outcome: "response", toolCalls, diagnostics }],
        }),
        followups: preview.playPreset!.followups,
        bootstrap: preview.compilation,
        prefix: [],
        toolStrategy: preview.compilation.toolStrategy,
        context: {
          worldId: "world",
          parentHead: "genesis",
          operationId: "run",
          playPresetId: "preset",
          playPresetRevision: "preset-revision",
          playPresetScriptsEnabled: false,
        },
        head: "commit:1",
        maxOutputTokens: 2_000,
        failureLog,
      });

      expect(run.outcomes).toHaveLength(1);
      expect(run.outcomes[0]?.toolCalls.map(({ ok }) => ok)).toEqual(
        toolResults,
      );
      expect(run.outcomes[0]?.failure).toBe(failure);
      expect(run.extension?.status).toBe(
        failure === undefined ? "completed" : "recovery_required",
      );
      const logs = (await readdir(logRoot)).filter((name) =>
        name.endsWith(".jsonl"),
      );
      expect(logs).toHaveLength(1);
      const records = (await readFile(join(logRoot, logs[0]!), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              failures?: AiFailureDescription[];
            },
        );
      const reportedFailures = records.flatMap(
        ({ failures }) => failures ?? [],
      );
      expect(reportedFailures[0]?.kind).toBe("provider_rejection");
      expect(reportedFailures.slice(1)).toMatchObject(failures);
      expect(records.filter(({ type }) => type === "resolved")).toHaveLength(
        failure === undefined ? 1 : 0,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  { locale: "zh-CN", instructions: false },
  { locale: "en", instructions: true },
] as const)(
  "$locale Responses 后置请求派发完整的选项结构，并按同一契约接收产物",
  async ({ locale, instructions }) => {
    const root = await mkdtemp(join(tmpdir(), "narraeon-options-contract-"));
    try {
      const files = firstPartyActionChoicesPresetFilesForLocale(locale);
      const parsed = parsePlayPresetFiles(files);
      if (parsed.kind !== "valid") throw parsed.error;
      const compiled = new FileNativePromptCompiler({
        locale,
      }).compilePlayCallChain(
        createMinimalFileNativePreviewInput({
          provider: "openai_responses",
          modelId: "fixture",
          contextWindowTokens: 32_000,
          maxOutputTokens: 2_000,
          playerInput: "Continue.",
          playerInputPlacement: "append",
          locale,
        }),
        {
          id: "preset",
          name: "Preset",
          revision: "preset-revision",
          files,
          definition: parsed.definition,
          scriptsEnabled: false,
        },
      );
      expect(compiled.followups.map(({ id }) => id)).toEqual([
        "player_options",
      ]);
      const options = [
        { id: "a", label: "A", prompt: "Choose A." },
        {
          id: "b",
          label: "B",
          description: "Some detail",
          prompt: "Choose B.",
        },
        { id: "c", label: "C", prompt: "Choose C." },
        { id: "d", label: "D", prompt: "Choose D." },
      ];
      const artifacts = new FileNativeArtifactStore(root);
      const requests: Record<string, unknown>[] = [];
      const modelHost = new FileNativeModelHost(
        {
          provider: "openai_responses",
          baseUrl: instructions
            ? "https://provider.invalid/v1"
            : chatGptPlanBaseUrl,
          apiKey: instructions ? "synthetic" : "",
          modelId: "fixture",
          contextWindowTokens: 32_000,
          maxOutputTokens: 2_000,
          responsesTurnInstructions: instructions,
          ...(instructions
            ? {}
            : {
                chatgptPlan: {
                  accountId: "fixture",
                  accessToken: () => Promise.resolve("synthetic"),
                },
              }),
        },
        async (_url, init) => {
          requests.push(
            (await new Response(init?.body).json()) as Record<string, unknown>,
          );
          const payload =
            requests.length === 1
              ? options
              : options.map(({ id, prompt }) => ({ id, text: prompt }));
          return new Response(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    namespace: "narraeon",
                    name: "artifact_emit",
                    call_id: "emit-options",
                    arguments: JSON.stringify({
                      output: "player_options",
                      payload,
                    }),
                  },
                ],
              },
            })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      );

      for (const worldId of ["valid", "invalid"]) {
        const run = await runPlayFollowupRequests({
          artifacts,
          modelHost,
          followups: compiled.followups,
          bootstrap: compiled.bootstrap,
          prefix: [{ kind: "player", text: "Continue." }],
          toolStrategy: compiled.toolStrategy,
          context: {
            worldId,
            parentHead: "genesis",
            operationId: "run",
            playPresetId: "preset",
            playPresetRevision: "preset-revision",
            playPresetScriptsEnabled: false,
          },
          head: "commit:1",
          maxOutputTokens: 2_000,
        });
        const toolCall = run.outcomes[0]?.toolCalls[0];
        expect(toolCall?.ok).toBe(worldId === "valid");
        const projection = await artifacts.readActiveProjection(worldId);
        if (worldId === "valid")
          expect(projection).toMatchObject([{ payload: options }]);
        else {
          expect(toolCall?.markdown).toContain("$[0].label is required");
          expect(projection).toEqual([]);
        }
      }

      expect(requests).toHaveLength(2);
      const wire = requests[0]!;
      const prompt = instructions
        ? String(wire.instructions)
        : (wire.input as { role?: string; content?: string }[]).at(-1)?.content;
      expect(prompt).toContain(
        locale === "zh-CN"
          ? "未列入的已声明字段可省略"
          : "other declared fields are optional",
      );
      const schema = prompt?.match(/^ {2}payloadContract=(.+)$/mu)?.[1];
      expect(schema).toBeDefined();
      const wireContract: unknown = JSON.parse(schema!);
      expect(wireContract).toEqual(
        compiled.followups[0]?.artifacts[0]?.payloadContract,
      );
      expect(wireContract).toEqual({
        type: "array",
        minItems: 4,
        maxItems: 4,
        uniqueBy: "id",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "prompt"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            label: { type: "string", minLength: 1, maxLength: 80 },
            description: { type: "string", maxLength: 240 },
            prompt: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

function requiredRecapPreview() {
  const original = parsePlayPresetFiles(firstPartyActionChoicesPresetFiles);
  if (original.kind !== "valid") throw original.error;
  const structure = toPlayPresetStructuredEditor(original.definition);
  structure.followupItems!.forEach((item) => {
    item.enabled = item.id === "builtin:summary";
  });
  const files = applyPlayPresetStructuredEditor(
    firstPartyActionChoicesPresetFiles,
    structure,
  );
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return new FileNativePromptCompiler().previewPlayPreset(
    createMinimalFileNativePreviewInput({
      provider: "chat_completions",
      modelId: "fixture",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
      playerInput: "Continue.",
      playerInputPlacement: "append",
    }),
    {
      id: "preset",
      name: "Preset",
      revision: "preset-revision",
      files,
      definition: parsed.definition,
      scriptsEnabled: false,
    },
  );
}
