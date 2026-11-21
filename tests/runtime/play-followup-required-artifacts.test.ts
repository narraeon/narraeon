import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
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
import { firstPartyActionChoicesPresetFiles } from "../../src/shared/first-party-action-choices.ts";

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
