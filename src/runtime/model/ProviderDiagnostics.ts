import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AiExchangeCapture,
  errorDescription,
  type AiExchangeDiagnostics,
  type AiFailureDescription,
  type AiFailureRecorder,
} from "./AiFailureLog.ts";
import type { FileNativeModelConnection } from "./FileNativeModelConnection.ts";
import {
  ModelHostCancelledError,
  ModelHostFailureError,
  type ModelHostExchange,
} from "./ModelHost.ts";
import type { ModelHostDeltaSink } from "./ModelHostStream.ts";
import { ModelResponseFormatError } from "./ModelResponseCorrection.ts";

export function modelHostTrace(request: ModelHostExchange) {
  return {
    requestId: request.requestId,
    operationId: request.operationId,
    requestAttempt: request.requestAttempt,
    exchange: request.exchange,
    bootstrap: structuredClone(request.bootstrap),
    appended: request.appended.map((item) =>
      item.kind !== "assistant"
        ? structuredClone(item)
        : {
            kind: item.kind,
            text: item.text,
            toolCalls: structuredClone(item.toolCalls),
            reasoningContentAvailable: item.reasoningContent !== undefined,
            providerStateAvailable: item.providerState !== undefined,
          },
    ),
    tools: request.tools.map(({ name }) => name),
    toolUniverse: request.toolUniverse?.map(({ name }) => name),
    allowedTools: structuredClone(request.allowedTools),
    toolStrategy: structuredClone(request.toolStrategy),
    maxOutputTokens: request.maxOutputTokens,
  };
}

export function modelDiagnosticContext(
  request: ModelHostExchange,
): AiExchangeDiagnostics["context"] {
  return {
    scope:
      request.requestId === "play_call_chain"
        ? "play_call_chain"
        : request.operationId?.startsWith("setting-") === true
          ? "setting_improvement"
          : request.operationId?.includes(":followup:") === true
            ? "play_followup"
            : "model_host",
    ...(request.requestId === undefined
      ? {}
      : { requestId: request.requestId }),
    ...(request.operationId === undefined
      ? {}
      : { operationId: request.operationId }),
    ...(request.requestAttempt === undefined
      ? {}
      : { requestAttempt: request.requestAttempt }),
    ...(request.exchange === undefined ? {} : { exchange: request.exchange }),
  };
}

export function providerCapture(
  failureLog: AiFailureRecorder | undefined,
  provider: FileNativeModelConnection["provider"],
  endpoint: URL,
  context: AiExchangeDiagnostics["context"],
  requestBody: string,
  endpointLabel?: string,
): AiExchangeCapture | undefined {
  return failureLog === undefined
    ? undefined
    : new AiExchangeCapture({
        provider,
        endpoint,
        context,
        requestBody,
        ...(endpointLabel === undefined ? {} : { endpointLabel }),
      });
}

export function captureDelta(
  capture: AiExchangeCapture | undefined,
  downstream: ModelHostDeltaSink | undefined,
): ModelHostDeltaSink | undefined {
  if (capture === undefined) return downstream;
  return (delta) => {
    if (delta.kind === "reasoning") capture.observeReasoning(delta.text);
    downstream?.(delta);
  };
}

export async function capturedProviderOperation<Value extends object>(
  failureLog: AiFailureRecorder | undefined,
  capture: AiExchangeCapture | undefined,
  operation: (
    observeResponse: (response: Response) => Response,
  ) => Promise<Value>,
  sanitizeError?: (error: unknown) => unknown,
): Promise<Value & { diagnostics?: AiExchangeDiagnostics }> {
  const observeResponse = (response: Response): Response =>
    capture?.captureResponse(response) ?? response;
  try {
    const value = await operation(observeResponse);
    if (capture === undefined) return value;
    return { ...value, diagnostics: capture.snapshot() };
  } catch (error: unknown) {
    if (error instanceof ModelHostCancelledError) throw error;
    const reportedError =
      sanitizeError === undefined ? error : sanitizeError(error);
    if (capture !== undefined && failureLog !== undefined) {
      const exchange = capture.snapshot();
      const failure: AiFailureDescription = {
        kind:
          exchange.response === undefined
            ? "provider_transport"
            : reportedError instanceof ModelHostFailureError &&
                !(reportedError instanceof ModelResponseFormatError)
              ? "provider_rejection"
              : "provider_response_format",
        message:
          reportedError instanceof Error
            ? reportedError.message
            : "Provider request processing failed.",
        ...(reportedError instanceof ModelHostFailureError &&
        reportedError.details !== undefined
          ? { details: reportedError.details }
          : {}),
        error: errorDescription(reportedError),
      };
      await failureLog.recordFailure({ exchange, failures: [failure] });
    }
    throw reportedError;
  }
}

export async function trace(kind: string, value: unknown): Promise<void> {
  const path = process.env.NARRAEON_PROVIDER_TRACE_PATH;
  if (path === undefined) return;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const size = await stat(path).then(
      ({ size }) => size,
      () => 0,
    );
    if (size > 0) await chmod(path, 0o600);
    const line = `${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`;
    if (Buffer.byteLength(line, "utf8") > 8 * 1024 * 1024 - size) return;
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Explicit acceptance diagnostics must never change provider semantics.
  }
}
