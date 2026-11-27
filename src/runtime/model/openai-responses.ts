import {
  bootstrapPrefixEnd,
  renderPromptDeltaMessage,
  responsesCacheBreakpointIndex,
  type PromptCompilation,
} from "../prompt/FileNativePromptCompiler.ts";
import type { RuntimeToolDefinitionStrategy } from "../prompt/FileNativeToolRegistry.ts";
import { prefillMessage } from "./AssistantPrefill.ts";
import {
  chatGptPlanAccessToken,
  chatGptPlanHttpFailure,
  chatGptPlanInterrupted,
  chatGptPlanStreamFailure,
  invalidateRejectedToken,
  sendChatGptPlanRequest,
} from "./ChatGptPlanInference.ts";
import {
  modelCacheStrategy,
  type ResolvedFileNativeModelConnection,
} from "./FileNativeModelConnection.ts";
import {
  assertModelOutputComplete,
  modelHostInputText,
  ModelHostFailureError,
  type ModelHostAppendItem,
  type ModelHostExchange,
  type ModelHostExchangeObserver,
  type ModelHostResponse,
  type ModelHostToolCall,
  type ModelHostUsage,
  type ModelHostWireRequest,
} from "./ModelHost.ts";
import { aggregateResponsesModelStream } from "./ModelHostStream.ts";
import { ModelResponseFormatError } from "./ModelResponseCorrection.ts";
import {
  appendWithSuffixBreakpoint,
  checkedCacheBreakpoints,
  isRequestSuffix,
  markLastMessage,
  promptCacheKey,
} from "./ProviderCache.ts";
import {
  captureDelta,
  capturedProviderOperation,
  modelDiagnosticContext,
  providerCapture,
} from "./ProviderDiagnostics.ts";
import {
  continuationError,
  continuationInput,
  hasFrozenToolPolicy,
  initialWorldContext,
  isProperToolSubset,
  promptDeltaProviderMessages,
  providerAllowedTools,
  providerToolDefinitions,
  providerToolStrategy,
} from "./ProviderRequest.ts";
import {
  bearerProviderHeaders,
  cancelledModelRequest,
  dispatchProviderRequest,
  isProviderEventStream,
  providerError,
  providerJson,
  providerRequestPreview,
  providerStreamResult,
  providerUrl,
  unknownProviderResponse,
  type ProviderDispatch,
} from "./ProviderTransport.ts";
import {
  cloneProviderValue,
  isRecord,
  parseArguments,
  providerNumber,
  subtractCachedInput,
  usageRecord,
} from "./ProviderValues.ts";

const chatGptPlanToolNamespace = "narraeon";

interface ResponsesRequestBodyInput {
  connection: ResolvedFileNativeModelConnection;
  instructions?: string;
  input: unknown[];
  tools: { name: string; description: string; parameters: object }[];
  allowedTools?: string[];
  toolStrategy?: RuntimeToolDefinitionStrategy;
  hasFrozenToolPolicy?: boolean;
  maxOutputTokens: number;
  promptCacheKey?: string;
}

function responsesRequestInput(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): ResponsesRequestBodyInput {
  const { instructions, items } = responsesAppend(connection, request);
  return {
    ...(instructions.length === 0 ? {} : { instructions }),
    connection,
    input: [
      ...responsesBootstrapMessages(connection, request),
      ...items,
      ...prefillMessage(request),
    ],
    tools: providerToolDefinitions(request).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
    allowedTools: providerAllowedTools(request),
    toolStrategy: providerToolStrategy(request, connection.provider),
    hasFrozenToolPolicy: hasFrozenToolPolicy(request),
    maxOutputTokens: request.maxOutputTokens,
    promptCacheKey: promptCacheKey(connection, request),
  };
}

function responsesRequestBody(
  input: ResponsesRequestBodyInput,
): Record<string, unknown> {
  const allowedTools =
    input.allowedTools ?? input.tools.map((tool) => tool.name);

  if (input.connection.chatgptPlan !== undefined) {
    const allowed = new Set(allowedTools);
    const tools = input.tools.filter(({ name }) => allowed.has(name));
    return {
      model: input.connection.modelId,
      ...responsesReasoningRequest(input.connection),
      ...(input.instructions === undefined
        ? {}
        : { instructions: input.instructions }),
      input: input.input,
      ...(tools.length === 0
        ? {}
        : {
            tools: [
              {
                type: "namespace",
                name: chatGptPlanToolNamespace,
                description: "Tools executed by the Narraeon Runtime.",
                tools: tools.map(responsesFunctionTool),
              },
            ],
          }),
      store: false,
      include: ["reasoning.encrypted_content"],
      stream: true,
    };
  }

  const toolChoice =
    input.hasFrozenToolPolicy === true && allowedTools.length === 0
      ? "none"
      : input.hasFrozenToolPolicy === true &&
          input.toolStrategy === "native_allowed_subset" &&
          input.connection.supportsAllowedTools &&
          isProperToolSubset(allowedTools, input.tools)
        ? {
            type: "allowed_tools",
            mode: "auto",
            tools: allowedTools.map((name) => ({ type: "function", name })),
          }
        : "auto";
  return checkedCacheBreakpoints({
    model: input.connection.modelId,
    ...responsesReasoningRequest(input.connection),
    ...(input.instructions === undefined
      ? {}
      : { instructions: input.instructions }),
    input: input.input,
    ...(input.tools.length === 0
      ? input.hasFrozenToolPolicy === true && allowedTools.length === 0
        ? { tool_choice: "none" }
        : {}
      : {
          tools: input.tools.map(responsesFunctionTool),
          tool_choice: toolChoice,
        }),
    max_output_tokens: input.maxOutputTokens,
    ...(input.promptCacheKey === undefined
      ? {}
      : { prompt_cache_key: input.promptCacheKey }),
    store: false,
    include: ["reasoning.encrypted_content"],
    stream: true,
  });
}

function responsesFunctionTool(
  tool: ResponsesRequestBodyInput["tools"][number],
) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // Runtime schemas distinguish absent options from supplied values.
    // Responses otherwise normalizes compatible schemas to strict mode.
    strict: false,
  };
}

function encodeInitialWorldContext(
  request: ModelHostExchange,
  chatgptPlan: boolean,
): unknown[] {
  const preload = initialWorldContext(request);
  if (preload === undefined) return [];
  const { callId, markdown, name, notice } = preload;
  const call = {
    type: "function_call" as const,
    call_id: callId,
    name,
    ...(chatgptPlan ? { namespace: chatGptPlanToolNamespace } : {}),
    arguments: "{}",
  };
  return [
    notice,
    call,
    responsesToolOutput(chatgptPlan ? call : undefined, callId, markdown),
  ];
}

function responsesBootstrapMessages(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): unknown[] {
  const explicitCache =
    modelCacheStrategy(connection) === "explicit_cliproxyapi_message";
  const messages: unknown[] = request.bootstrap.provider.messages.map(
    (message) =>
      responsesBootstrapMessage(
        message,
        explicitCache,
        connection.responsesTurnInstructions !== undefined,
      ),
  );
  const prefixEnd = bootstrapPrefixEnd(request.bootstrap);
  const cacheMessageIndex = responsesCacheBreakpointIndex(request.bootstrap);
  const prefix = messages.map((message, index) =>
    explicitCache && index === cacheMessageIndex && isRecord(message)
      ? { ...message, cache_control: { type: "ephemeral" } }
      : message,
  );
  prefix.splice(
    prefixEnd,
    0,
    ...encodeInitialWorldContext(request, connection.chatgptPlan !== undefined),
  );
  return prefix;
}

function responsesAppend(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): { instructions: string; items: unknown[] } {
  if (connection.responsesTurnInstructions === undefined)
    return {
      instructions: "",
      items: appendWithSuffixBreakpoint(
        connection,
        request,
        (items) => responsesItems(items, false),
        markLastMessage,
      ),
    };

  // Only dispatch-local items may move out of the conversation. A correction can
  // follow a guide after a malformed output, and a followup carries its own task.
  const index =
    request.appended.findLastIndex(
      (item) =>
        !(
          isRequestSuffix(item) ||
          (item.kind === "prompt_delta" && item.requestScoped === true) ||
          (item.kind === "runtime_notice" &&
            item.notice === "response_correction")
        ),
    ) + 1;
  const chatgptPlanCalls =
    connection.chatgptPlan === undefined
      ? undefined
      : new Map<string, ResponsesToolCall>();
  const transcript = responsesItems(
    request.appended.slice(0, index),
    true,
    chatgptPlanCalls,
  );
  const suffix = request.appended.slice(index);
  const instructions: string[] = [];
  const items =
    transcript.length > 0 &&
    suffix.length > 0 &&
    connection.cacheSuffixBreakpoint &&
    modelCacheStrategy(connection) === "explicit_cliproxyapi_message"
      ? markLastMessage(transcript)
      : transcript;
  for (const item of suffix) {
    if (item.kind === "runtime_notice" && item.notice === "turn_guide") {
      if (
        connection.responsesTurnInstructions &&
        item.responsesInstructions !== undefined
      ) {
        if (item.text) instructions.push(item.text);
      } else {
        const fixed = item.responsesInstructions?.fixed;
        if (fixed) instructions.push(fixed);
        // Unsplittable guide text retains its original user role.
        const player = item.responsesInstructions?.player ?? item.text;
        if (player) items.push({ role: "user", content: player });
      }
    } else if (
      item.kind === "prompt_delta" &&
      connection.responsesTurnInstructions
    ) {
      for (const message of item.logicalMessages) {
        const projected = responsesDeltaMessage(message);
        if (
          message.role === "author_instruction" &&
          projected.role === "developer"
        )
          instructions.push(projected.content);
        else items.push(projected);
      }
    } else {
      items.push(...responsesItems([item], true, chatgptPlanCalls));
    }
  }
  return { instructions: instructions.join("\n\n"), items };
}

function responsesItems(
  items: readonly ModelHostAppendItem[],
  projectRoles: boolean,
  chatgptPlanCalls?: Map<string, ResponsesToolCall>,
): unknown[] {
  return items.flatMap((item): unknown[] => {
    if (
      item.kind === "player" ||
      item.kind === "user" ||
      item.kind === "runtime_notice"
    )
      return [{ role: "user", content: modelHostInputText(item) }];
    if (item.kind === "prompt_delta") {
      if (!projectRoles)
        return promptDeltaProviderMessages(item.logicalMessages);
      return item.logicalMessages.map(responsesDeltaMessage);
    }
    if (item.kind === "tool") {
      const call = chatgptPlanCalls?.get(item.toolCallId);
      if (chatgptPlanCalls !== undefined && call === undefined)
        throw continuationError("ChatGPT plan tool result");
      return [
        responsesToolOutput(call, item.toolCallId, item.markdown, item.isError),
      ];
    }
    if (
      item.providerState?.protocol === "openai_responses" &&
      validResponsesOutput(item.providerState.output)
    ) {
      if (chatgptPlanCalls !== undefined) {
        for (const output of item.providerState.output) {
          const call = nativeResponsesToolCall(output);
          if (call !== undefined) chatgptPlanCalls.set(call.call_id, call);
        }
      }
      return [
        ...continuationInput(item),
        ...cloneResponseOutput(item.providerState.output),
      ];
    }
    throw continuationError("OpenAI Responses");
  });
}

interface ResponsesToolCall {
  type: "function_call" | "custom_tool_call";
  call_id: string;
  name: string;
  namespace?: string;
}

function nativeResponsesToolCall(
  value: unknown,
): ResponsesToolCall | undefined {
  if (
    !isRecord(value) ||
    (value.type !== "function_call" && value.type !== "custom_tool_call") ||
    typeof value.call_id !== "string" ||
    typeof value.name !== "string"
  )
    return undefined;
  return {
    type: value.type,
    call_id: value.call_id,
    name: value.name,
    ...(typeof value.namespace === "string"
      ? { namespace: value.namespace }
      : {}),
  };
}

function responsesToolOutput(
  call: ResponsesToolCall | undefined,
  callId: string,
  markdown: string,
  isError?: boolean,
) {
  return {
    type:
      call?.type === "custom_tool_call"
        ? "custom_tool_call_output"
        : "function_call_output",
    call_id: callId,
    ...(call === undefined
      ? {}
      : {
          name: call.name,
          ...(call.namespace === undefined
            ? {}
            : { namespace: call.namespace }),
        }),
    output:
      call === undefined
        ? markdown
        : JSON.stringify({ content: markdown, success: isError !== true }),
  };
}

function responsesDeltaMessage(
  message: PromptCompilation["logicalMessages"][number],
) {
  return {
    role:
      message.messageRole === "user" || message.messageRole === "assistant"
        ? message.messageRole
        : "developer",
    content:
      message.role === "runtime_system"
        ? message.markdown
        : renderPromptDeltaMessage(message.role, message.markdown),
  };
}

function responsesReasoningRequest(
  connection: ResolvedFileNativeModelConnection,
): Record<string, unknown> {
  const reasoning = {
    ...(connection.reasoningEffort === "provider_default"
      ? {}
      : { effort: connection.reasoningEffort }),
    ...(connection.reasoningSummary === "provider_default" ||
    (connection.reasoningSummary === "none" &&
      connection.dialect === "standard")
      ? {}
      : {
          summary:
            connection.reasoningSummary === "none"
              ? null
              : connection.reasoningSummary,
        }),
  };
  return Object.keys(reasoning).length === 0 ? {} : { reasoning };
}

function responsesBootstrapMessage(
  message: PromptCompilation["provider"]["messages"][number],
  preserveCacheControl: boolean,
  projectRoles: boolean,
) {
  return {
    role:
      projectRoles && message.role === "system" ? "developer" : message.role,
    content:
      preserveCacheControl && Array.isArray(message.content)
        ? message.content.flatMap((item) => {
            if (!isRecord(item) || typeof item.text !== "string") return [];
            return [
              {
                type:
                  message.role === "assistant" ? "output_text" : "input_text",
                text: item.text,
                ...(isRecord(item.cache_control)
                  ? { cache_control: cloneProviderValue(item.cache_control) }
                  : {}),
              },
            ];
          })
        : providerText(message.content),
  };
}

function providerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const items: unknown[] = content;
    return items
      .flatMap((item) =>
        isRecord(item) && typeof item.text === "string" ? [item.text] : [],
      )
      .join("\n\n");
  }
  return JSON.stringify(content) ?? "";
}

export function validResponsesOutput(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item) || typeof item.type !== "string") return false;
      if (item.type === "message") return Array.isArray(item.content);
      if (item.type === "function_call")
        return (
          typeof item.call_id === "string" &&
          typeof item.name === "string" &&
          typeof item.arguments === "string"
        );
      if (item.type === "custom_tool_call")
        return (
          typeof item.call_id === "string" &&
          typeof item.name === "string" &&
          typeof item.input === "string"
        );
      if (item.type === "reasoning")
        return (
          (item.summary === undefined || Array.isArray(item.summary)) &&
          (item.content === undefined ||
            item.content === null ||
            Array.isArray(item.content)) &&
          (item.encrypted_content === undefined ||
            item.encrypted_content === null ||
            typeof item.encrypted_content === "string")
        );
      return true;
    })
  );
}

export async function exchangeResponses(
  { connection, fetchImplementation, failureLog, trace }: ProviderDispatch,
  request: ModelHostExchange,
  observer?: ModelHostExchangeObserver,
): Promise<ModelHostResponse> {
  const signal = observer?.signal;
  const body = responsesRequestBody(responsesRequestInput(connection, request));
  if (connection.chatgptPlan !== undefined) {
    const plan = connection.chatgptPlan;
    const locale = request.bootstrap.locale ?? "en";
    const token = await chatGptPlanAccessToken(plan, locale, signal);
    const response = await sendChatGptPlanRequest({
      fetchImplementation,
      url: providerUrl(connection),
      token,
      body: JSON.stringify(body),
      signal,
      locale,
    });
    if (!response.ok)
      throw await chatGptPlanHttpFailure(response, plan, token, locale);
    if (!isProviderEventStream(response) || response.body === null) {
      void response.body?.cancel().catch(() => undefined);
      throw chatGptPlanInterrupted(locale);
    }
    let payload: Record<string, unknown>;
    try {
      payload = await aggregateResponsesModelStream(
        response.body,
        observer?.onDelta,
        (terminal) =>
          chatGptPlanStreamFailure(
            terminal,
            token,
            locale,
            response.headers.get("x-request-id"),
          ),
      );
    } catch (error: unknown) {
      if (signal?.aborted) throw cancelledModelRequest();
      if (error instanceof ModelHostFailureError) {
        const evidence = error.details;
        if (isRecord(evidence))
          await invalidateRejectedToken(plan, token, evidence.providerCode);
        throw error;
      }
      throw chatGptPlanInterrupted(locale);
    }
    if (signal?.aborted) throw cancelledModelRequest();
    if (!validResponsesOutput(payload.output))
      throw chatGptPlanInterrupted(locale);
    return projectResponsesPayload(payload, true);
  }
  await trace?.("responses_request", body);
  const bodyJson = JSON.stringify(body);
  const url = providerUrl(connection);
  const capture = providerCapture(
    failureLog,
    connection.provider,
    url,
    modelDiagnosticContext(request),
    bodyJson,
  );
  const diagnosticDelta = captureDelta(capture, observer?.onDelta);
  return capturedProviderOperation(failureLog, capture, async (observe) => {
    const received = await dispatchProviderRequest(
      fetchImplementation,
      url,
      {
        method: "POST",
        headers: bearerProviderHeaders(connection.apiKey),
        body: bodyJson,
        ...(signal === undefined ? {} : { signal }),
      },
      "OpenAI Responses",
    );
    if (!received.ok)
      throw await providerError(received, connection.apiKey, capture, trace);
    const response = observe(received);
    const payload = isProviderEventStream(response)
      ? await providerStreamResult(
          response,
          "Responses API",
          (body) => aggregateResponsesModelStream(body, diagnosticDelta),
          signal,
        )
      : await providerJson(response, "Responses API");
    await trace?.("responses_response", payload);
    if (!isRecord(payload) || !Array.isArray(payload.output))
      throw unknownProviderResponse("Responses API");
    if (
      !isProviderEventStream(response) &&
      responsesStopReason(payload) === "incomplete:max_output_tokens" &&
      validResponsesOutput(payload.output)
    ) {
      for (const item of payload.output) {
        if (
          isRecord(item) &&
          item.type === "message" &&
          Array.isArray(item.content)
        ) {
          for (const part of item.content) {
            if (
              isRecord(part) &&
              part.type === "output_text" &&
              typeof part.text === "string"
            )
              diagnosticDelta?.({ kind: "text", text: part.text });
            else diagnosticDelta?.({ kind: "reasoning", text: "" });
          }
        } else
          diagnosticDelta?.({
            kind:
              isRecord(item) && item.type === "function_call"
                ? "tool"
                : "reasoning",
            text: "",
          });
      }
    }
    assertModelOutputComplete(responsesStopReason(payload));
    return projectResponsesPayload(payload);
  });
}

function projectResponsesPayload(
  payload: Record<string, unknown>,
  chatgptPlan = false,
): ModelHostResponse {
  const output = cloneResponseOutput(payload.output);
  if (!validResponsesOutput(output))
    throw new ModelResponseFormatError(
      "Return a valid Responses API assistant response with well-formed messages and tool calls.",
      "请返回有效的 Responses API assistant 响应，确保消息和工具调用格式正确。",
    );
  const text = output
    .flatMap((item) => {
      if (
        !isRecord(item) ||
        item.type !== "message" ||
        !Array.isArray(item.content)
      )
        return [];
      return item.content.flatMap((part) =>
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
          ? [part.text]
          : [],
      );
    })
    .join("");
  const reasoningContent = responsesReturnedReasoning(output);
  const toolCalls = output.flatMap((item): ModelHostToolCall[] => {
    if (!isRecord(item)) return [];
    const call = nativeResponsesToolCall(item);
    if (
      call === undefined ||
      (!chatgptPlan && call.type === "custom_tool_call")
    )
      return [];
    if (
      chatgptPlan &&
      ((call.namespace !== undefined &&
        call.namespace !== chatGptPlanToolNamespace) ||
        (isRecord(item.caller) && item.caller.type === "program"))
    )
      throw new ModelResponseFormatError(
        "The response contains a tool call outside the Narraeon namespace.",
        "本次回复包含 Narraeon 工具命名空间以外的调用。",
      );
    const input = call.type === "function_call" ? item.arguments : item.input;
    if (typeof input !== "string") return [];
    return [
      {
        id: call.call_id,
        name: call.name,
        arguments: parseArguments(input),
      },
    ];
  });
  const stopReason = responsesStopReason(payload);
  return {
    ...(text.length === 0 ? {} : { text }),
    ...(reasoningContent.length === 0 ? {} : { reasoningContent }),
    providerState: {
      protocol: "openai_responses" as const,
      output,
      ...(typeof payload.id === "string" ? { responseId: payload.id } : {}),
    },
    usage: normalizeResponsesUsage(payload.usage),
    ...(stopReason === undefined ? {} : { stopReason }),
    toolCalls,
  };
}

function responsesStopReason(
  payload: Record<string, unknown>,
): string | undefined {
  const status =
    typeof payload.status === "string" && payload.status !== ""
      ? payload.status
      : undefined;
  const details = isRecord(payload.incomplete_details)
    ? payload.incomplete_details
    : undefined;
  const reason =
    details !== undefined &&
    typeof details.reason === "string" &&
    details.reason !== ""
      ? details.reason
      : undefined;
  if (status !== undefined && reason !== undefined)
    return `${status}:${reason}`;
  return reason ?? status;
}

function responsesReturnedReasoning(output: readonly unknown[]): string {
  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "reasoning") return [];
      const summary = Array.isArray(item.summary)
        ? item.summary.flatMap((part) =>
            isRecord(part) &&
            part.type === "summary_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
        : [];
      if (summary.length > 0) return summary;
      return Array.isArray(item.content)
        ? item.content.flatMap((part) =>
            isRecord(part) &&
            part.type === "reasoning_text" &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
        : [];
    })
    .join("");
}

function cloneResponseOutput(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Responses output must be an array");
  const source = JSON.stringify(value);
  return JSON.parse(source) as unknown[];
}

function normalizeResponsesUsage(value: unknown): ModelHostUsage {
  const usage = isRecord(value) ? value : {};
  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : {};
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : {};
  const inputTokens = providerNumber(usage.input_tokens);
  const cacheReadTokens = providerNumber(inputDetails.cached_tokens);
  const cacheWriteTokens =
    providerNumber(inputDetails.cache_write_tokens) ??
    providerNumber(inputDetails.cached_creation_tokens);
  return usageRecord(
    {
      inputTokens,
      uncachedInputTokens: subtractCachedInput(
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: providerNumber(outputDetails.reasoning_tokens),
      outputTokens: providerNumber(usage.output_tokens),
      totalTokens: providerNumber(usage.total_tokens),
    },
    ["uncachedInputTokens"],
  );
}

export function previewResponses(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): ModelHostWireRequest {
  return providerRequestPreview(
    connection,
    bearerProviderHeaders(connection.apiKey),
    responsesRequestBody(responsesRequestInput(connection, request)),
  );
}
