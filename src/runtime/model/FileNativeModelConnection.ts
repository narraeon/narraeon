import {
  anthropicConnectionCacheSettings,
  modelReasoningPolicyIssue,
  responsesConnectionCapabilities,
  supportsUnauthenticatedModelConnection,
  type AnthropicConnectionCacheSettings,
  type ModelAssistantPrefillMode,
  type ModelProviderDialect,
  type ModelReasoningEffort,
  type ModelReasoningSummary,
  type ModelThinkingMode,
  type ResponsesConnectionCapabilities,
} from "../../protocol/modelConnections.ts";
import type { FileNativePromptInput } from "../prompt/FileNativePromptCompiler.ts";
import type {
  ModelConnectionPrompt,
  ModelHostCacheStrategy,
} from "./ModelHost.ts";

export const chatGptPlanBaseUrl = "https://api.openai.com/v1";

/** Live, workspace-local credential access. Keep out of request snapshots. */
export interface ChatGptPlanConnection {
  accountId: string;
  allowFollowups: boolean;
  accessToken(signal?: AbortSignal): Promise<string>;
  invalidate?(accessToken: string): Promise<void>;
}

export interface FileNativeModelConnection
  extends ResponsesConnectionCapabilities, AnthropicConnectionCacheSettings {
  provider: FileNativePromptInput["modelBinding"]["provider"];
  dialect?: ModelProviderDialect;
  baseUrl: string;
  authMode?: "none";
  apiKey: string;
  chatgptPlan?: ChatGptPlanConnection;
  modelId: string;
  modelPrompt?: ModelConnectionPrompt;
  reasoningEffort?: ModelReasoningEffort;
  reasoningSummary?: ModelReasoningSummary;
  thinkingMode?: ModelThinkingMode;
  thinkingBudgetTokens?: number | null;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /**
   * Places the transcript breakpoint before the request-level suffix. Live
   * connections default to on; frozen requests record their own choice.
   */
  cacheSuffixBreakpoint?: boolean;
  supportsAllowedTools?: boolean;
  assistantPrefillMode?: ModelAssistantPrefillMode;
}

export interface ResolvedFileNativeModelConnection extends Omit<
  FileNativeModelConnection,
  | "modelPrompt"
  | "dialect"
  | "reasoningEffort"
  | "reasoningSummary"
  | "thinkingMode"
  | "thinkingBudgetTokens"
  | "cacheSuffixBreakpoint"
  | "supportsAllowedTools"
> {
  dialect: ModelProviderDialect;
  reasoningEffort: ModelReasoningEffort;
  reasoningSummary: ModelReasoningSummary;
  thinkingMode: ModelThinkingMode;
  thinkingBudgetTokens: number | null;
  cacheSuffixBreakpoint: boolean;
  supportsAllowedTools: boolean;
}

export function resolveConnection(
  {
    anthropicPromptCacheTtl,
    responsesTurnInstructions,
    responsesCacheControl,
    chatgptPlan,
    ...connection
  }: Omit<FileNativeModelConnection, "modelPrompt">,
  legacyResponses = false,
): ResolvedFileNativeModelConnection {
  if (
    chatgptPlan !== undefined &&
    (connection.provider !== "openai_responses" ||
      connection.baseUrl !== chatGptPlanBaseUrl ||
      connection.apiKey !== "" ||
      connection.authMode !== undefined ||
      (connection.dialect !== undefined && connection.dialect !== "standard") ||
      chatgptPlan.accountId.trim() === "" ||
      typeof chatgptPlan.accessToken !== "function")
  )
    throw new Error(
      "ChatGPT plan usage requires the public OpenAI Responses endpoint",
    );
  if (
    connection.authMode === "none" &&
    (connection.apiKey !== "" ||
      !supportsUnauthenticatedModelConnection(
        connection.provider,
        connection.baseUrl,
      ))
  )
    throw new Error(
      "Using no API key requires a loopback Chat Completions endpoint without an API key",
    );
  const resolved = structuredClone({
    ...connection,
    ...anthropicConnectionCacheSettings(
      connection.provider,
      anthropicPromptCacheTtl,
    ),
    ...(legacyResponses
      ? {}
      : responsesConnectionCapabilities(
          connection.provider,
          connection.dialect ?? "standard",
          { responsesTurnInstructions, responsesCacheControl },
        )),
    dialect: connection.dialect ?? "standard",
    reasoningEffort: connection.reasoningEffort ?? "provider_default",
    reasoningSummary: connection.reasoningSummary ?? "provider_default",
    thinkingMode: connection.thinkingMode ?? "provider_default",
    thinkingBudgetTokens: connection.thinkingBudgetTokens ?? null,
    cacheSuffixBreakpoint: connection.cacheSuffixBreakpoint ?? true,
    supportsAllowedTools: connection.supportsAllowedTools ?? true,
    assistantPrefillMode: connection.assistantPrefillMode ?? "disabled",
  });
  if (chatgptPlan !== undefined) {
    if (resolved.assistantPrefillMode !== "disabled")
      throw new Error("ChatGPT plan usage requires standard Responses input");
    Object.assign(resolved, {
      chatgptPlan: { ...chatgptPlan },
      responsesTurnInstructions: false,
    });
  }
  // Historical bindings can still be inspected. The Google encoder checks
  // the current reasoning policy before it previews or sends a request.
  const issue = modelReasoningPolicyIssue(
    {
      provider: resolved.provider,
      dialect: resolved.dialect,
      modelId: resolved.modelId,
      effort: resolved.reasoningEffort,
      summary: resolved.reasoningSummary,
      thinking: resolved.thinkingMode,
      thinkingBudgetTokens: resolved.thinkingBudgetTokens,
      maxOutputTokens: resolved.maxOutputTokens,
    },
    { allowLegacyGoogleSettings: true },
  );
  if (issue !== null) throw new Error(issue);
  return resolved;
}

export function modelCacheStrategy(
  connection: ResolvedFileNativeModelConnection,
): ModelHostCacheStrategy {
  if (connection.provider === "anthropic_messages")
    return "explicit_anthropic_blocks";
  if (
    connection.dialect === "cliproxyapi" &&
    (connection.provider === "chat_completions" ||
      (connection.provider === "openai_responses" &&
        (connection.responsesTurnInstructions === undefined ||
          connection.responsesCacheControl === true)))
  )
    return "explicit_cliproxyapi_message";
  return "provider_managed";
}
