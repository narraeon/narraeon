import type {
  ArtifactExtensionSummary,
  ArtifactOperationContext,
  ArtifactStore,
} from "../artifact/FileNativeArtifactStore.ts";
import type {
  ModelHost,
  ModelHostAppendItem,
  ModelHostToolCall,
} from "../model/ModelHost.ts";
import {
  errorDescription,
  type AiExchangeDiagnostics,
  type AiFailureRecorder,
} from "../model/AiFailureLog.ts";
import type {
  PlayFollowupCompilation,
  PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";

/** One completed followup request, projected for the player-visible trace. */
export interface PlayFollowupOutcome {
  id: string;
  displayName: string;
  text: string;
  reasoning?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  toolCalls: {
    callId: string;
    name: string;
    arguments: unknown;
    ok: boolean;
    markdown: string;
  }[];
  failure?: string;
}

export interface PlayFollowupRun {
  outcomes: PlayFollowupOutcome[];
  extension?: ArtifactExtensionSummary;
}

export interface PlayFollowupObserver {
  onOutcome?: (outcome: PlayFollowupOutcome) => void;
}

export interface PlayFollowupInput {
  artifacts: ArtifactStore;
  modelHost: ModelHost;
  followups: readonly PlayFollowupCompilation[];
  /**
   * The frozen main-chain prefix every request is dispatched against. It is
   * captured once, before the first request, so no request can observe another
   * one's prompt or output.
   */
  bootstrap: PromptCompilation;
  prefix: readonly ModelHostAppendItem[];
  toolStrategy: PromptCompilation["toolStrategy"];
  context: ArtifactOperationContext;
  /** Authority endpoint the main model exchange settled on. */
  head: string;
  maxOutputTokens: number;
  failureLog?: AiFailureRecorder;
  observer?: PlayFollowupObserver;
  signal?: AbortSignal;
}

/**
 * Run every follow-up declared by the frozen play preset exactly once after the
 * main model exchange has fully settled.
 *
 * Each request is `prefix + its own prompt` — the prompt replaces rather than
 * appends, so all requests share one identical stable prefix (the main chain
 * itself) and stay invisible to each other. Results only reach the artifact
 * store; nothing here is written back into the chain transcript, so the next
 * player message follows the narrative directly.
 *
 * Follow-ups run strictly after Authority has accepted the exchange. A failure
 * here cannot damage committed world state: it is recorded, the remaining
 * requests still run, and the chain returns to the player either way.
 */
export async function runPlayFollowupRequests(
  input: PlayFollowupInput,
): Promise<PlayFollowupRun> {
  if (input.followups.length === 0) return { outcomes: [] };

  await input.artifacts.beginOperation(input.context);
  await input.artifacts.markCoreCommitted(input.context, input.head);
  await input.artifacts.beginExtension(input.context);

  const prefix = structuredClone(input.prefix) as ModelHostAppendItem[];
  const outcomes: PlayFollowupOutcome[] = [];
  const completed: string[] = [];
  let failure: string | undefined;

  for (const followup of input.followups) {
    if (input.signal?.aborted === true) {
      failure ??= "后置请求已取消。";
      break;
    }
    const outcome = await runOne(input, followup, prefix);
    outcomes.push(outcome);
    input.observer?.onOutcome?.(outcome);
    if (outcome.failure === undefined) completed.push(followup.id);
    else failure ??= outcome.failure;
  }

  const extension =
    failure === undefined
      ? await input.artifacts.completeExtension(
          input.context.operationId,
          completed,
        )
      : await input.artifacts.failExtension(
          input.context.operationId,
          "recovery_required",
          failure,
          completed,
        );
  return { outcomes, extension };
}

async function runOne(
  input: PlayFollowupInput,
  followup: PlayFollowupCompilation,
  prefix: ModelHostAppendItem[],
): Promise<PlayFollowupOutcome> {
  const outcome: PlayFollowupOutcome = {
    id: followup.id,
    displayName: followup.displayName,
    text: "",
    toolCalls: [],
  };
  const requestContext = {
    ...input.context,
    requestId: followup.id,
    requestAttempt: 1,
    maxArtifactBytes: followup.maxArtifactBytes,
    declarations: structuredClone(followup.artifacts),
  };
  let responseDiagnostics: AiExchangeDiagnostics | undefined;
  try {
    await input.artifacts.beginRequestAttempt(requestContext);
    const response = await input.modelHost.exchange({
      bootstrap: structuredClone(input.bootstrap),
      tools: structuredClone(followup.tools),
      toolUniverse: structuredClone(followup.tools),
      allowedTools: [...followup.allowedTools],
      toolStrategy: input.toolStrategy,
      // The prompt replaces the previous followup's prompt instead of being
      // appended after it: every request sees exactly the main-chain prefix.
      appended: [
        ...structuredClone(prefix),
        {
          kind: "prompt_delta",
          logicalMessages: structuredClone(followup.logicalMessages),
        },
      ],
      requestId: followup.id,
      operationId: input.context.operationId,
      requestAttempt: 1,
      exchange: 1,
      maxOutputTokens: input.maxOutputTokens,
    });
    responseDiagnostics = response.diagnostics;
    if (response.diagnostics !== undefined)
      await input.failureLog?.recordExchangeIfActive(response.diagnostics);
    outcome.text = response.text ?? "";
    if (response.reasoningContent !== undefined)
      outcome.reasoning = response.reasoningContent;
    if (response.usage !== undefined)
      outcome.usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      };
    // One request, one pass: tool results are recorded for the trace but never
    // fed back for another exchange.
    for (const call of response.toolCalls ?? []) {
      const result = await executeArtifactCall(input, requestContext, call);
      outcome.toolCalls.push({
        callId: call.id,
        name: call.name,
        arguments: structuredClone(call.arguments),
        ok: result.ok,
        markdown: result.markdown,
      });
    }
    const failedTools = outcome.toolCalls.filter(({ ok }) => !ok);
    if (failedTools.length > 0 && response.diagnostics !== undefined)
      await input.failureLog?.recordFailure({
        exchange: response.diagnostics,
        failures: [
          {
            kind: "tool_execution",
            message: `后置请求 ${followup.id} 的产物工具未被接受。`,
            details: { calls: structuredClone(failedTools) },
          },
        ],
      });
    const missing = followup.artifacts
      .filter(({ required }) => required)
      .filter(
        ({ name }) =>
          !outcome.toolCalls.some(
            ({ ok, arguments: args }) =>
              ok && (args as { output?: unknown })?.output === name,
          ),
      )
      .map(({ name }) => name);
    if (missing.length > 0)
      outcome.failure = `后置请求 ${followup.id} 未提交必需产物：${missing.join("、")}`;
    if (outcome.failure !== undefined && response.diagnostics !== undefined)
      await input.failureLog?.recordFailure({
        exchange: response.diagnostics,
        failures: [
          {
            kind: "format_validation",
            message: outcome.failure,
            details: { missing },
          },
        ],
      });
    else if (failedTools.length === 0 && response.diagnostics !== undefined)
      await input.failureLog?.resolve({
        exchange: response.diagnostics,
        message: `后置请求 ${followup.id} 已在后续模型交换中恢复。`,
      });
  } catch (error: unknown) {
    outcome.failure =
      error instanceof Error
        ? error.message
        : `后置请求 ${followup.id} 执行失败。`;
    if (responseDiagnostics !== undefined)
      await input.failureLog?.recordFailure({
        exchange: responseDiagnostics,
        failures: [
          {
            kind: "runtime_post_processing",
            message: outcome.failure,
            error: errorDescription(error),
          },
        ],
      });
  }
  return outcome;
}

async function executeArtifactCall(
  input: PlayFollowupInput,
  context: {
    requestId: string;
    requestAttempt: number;
    maxArtifactBytes: number;
    declarations: PlayFollowupCompilation["artifacts"];
  } & ArtifactOperationContext,
  call: ModelHostToolCall,
): Promise<{ ok: boolean; markdown: string }> {
  if (call.name !== "artifact_emit" && call.name !== "artifact_clear")
    return {
      ok: false,
      markdown: `# Runtime 工具拒绝\n\n后置请求没有提供 ${call.name}。`,
    };
  const args = call.arguments;
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    typeof (args as { output?: unknown }).output !== "string"
  )
    return {
      ok: false,
      markdown: "# Runtime 参数错误\n\nartifact 工具需要 output name。",
    };
  const output = (args as { output: string }).output;
  return call.name === "artifact_emit"
    ? input.artifacts.emit({
        context,
        output,
        payload: (args as { payload?: unknown }).payload,
        toolCallId: call.id,
      })
    : input.artifacts.clear({ context, output, toolCallId: call.id });
}
