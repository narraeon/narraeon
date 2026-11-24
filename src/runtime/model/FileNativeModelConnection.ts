import {
  modelReasoningPolicyIssue,
  responsesConnectionCapabilities,
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

export interface FileNativeModelConnection extends ResponsesConnectionCapabilities {
  provider: FileNativePromptInput["modelBinding"]["provider"];
  dialect?: ModelProviderDialect;
  baseUrl: string;
  apiKey: string;
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
    responsesTurnInstructions,
    responsesCacheControl,
    ...connection
  }: Omit<FileNativeModelConnection, "modelPrompt">,
  legacyResponses = false,
): ResolvedFileNativeModelConnection {
  const resolved = structuredClone({
    ...connection,
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
  const issue = modelReasoningPolicyIssue({
    provider: resolved.provider,
    dialect: resolved.dialect,
    modelId: resolved.modelId,
    effort: resolved.reasoningEffort,
    summary: resolved.reasoningSummary,
    thinking: resolved.thinkingMode,
    thinkingBudgetTokens: resolved.thinkingBudgetTokens,
    maxOutputTokens: resolved.maxOutputTokens,
  });
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
