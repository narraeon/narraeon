import type { AiExchangeCapture, AiFailureRecorder } from "./AiFailureLog.ts";
import {
  fetchModelService,
  ModelServiceRedirectError,
} from "./fetchModelService.ts";
import type {
  FileNativeModelConnection,
  ResolvedFileNativeModelConnection,
} from "./FileNativeModelConnection.ts";
import {
  isModelHostTokenLimitFailure,
  ModelHostCancelledError,
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
  type ModelHostWireRequest,
} from "./ModelHost.ts";
import {
  hardQuotaFailure,
  provenConnectTimeout,
  RetryableModelFailure,
  retryAfterMs,
} from "./ModelRetry.ts";
import { trace } from "./ProviderDiagnostics.ts";
import {
  providerRejectionText,
  readProviderRejectionBody,
} from "./ProviderRejection.ts";
import { cloneProviderValue } from "./ProviderValues.ts";

export function providerUrl(connection: FileNativeModelConnection): URL {
  const url = new URL(connection.baseUrl);
  const suffix =
    connection.provider === "chat_completions"
      ? "/chat/completions"
      : connection.provider === "openai_responses"
        ? "/responses"
        : connection.provider === "google_interactions"
          ? "/interactions"
          : "/messages";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

export async function providerError(
  response: Response,
  apiKey: string,
  capture: AiExchangeCapture | undefined,
): Promise<Error> {
  const body = await readProviderRejectionBody(response);
  const contentType = response.headers.get("content-type");
  const diagnostic = providerRejectionText(body ?? "", apiKey, contentType);
  const statusText = providerRejectionText(response.statusText, apiKey, null);
  await trace("provider_error", {
    status: response.status,
    statusText,
    body: diagnostic,
  });
  capture?.captureRejection({
    status: response.status,
    statusText,
    contentType:
      contentType === null
        ? null
        : providerRejectionText(contentType, apiKey, null),
    body: diagnostic,
    bodyComplete: body !== null,
  });
  // Classify the rejection without persisting the upstream's raw evidence.
  const evidence = body?.slice(0, 4096) ?? "";
  if (response.status === 429 && hardQuotaFailure(evidence))
    return new ModelHostFailureError(
      "Provider hard quota or balance exhausted",
      { details: { code: "hard_quota_exhausted", httpStatus: 429 } },
    );
  const message = ["Provider request failed:", response.status, diagnostic]
    .filter(Boolean)
    .join(" ");
  if (
    response.status === 429 &&
    !isModelHostTokenLimitFailure(new ModelHostFailureError(evidence))
  )
    return new RetryableModelFailure(
      "rate_limit",
      retryAfterMs(response.headers.get("retry-after")),
      diagnostic === "" ? undefined : message,
    );
  return new ModelHostFailureError(message, {
    details: { httpStatus: response.status },
  });
}

async function parseProviderJson(
  response: Response,
  label: string,
): Promise<unknown> {
  const source = await response.text();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

export async function providerJson(
  response: Response,
  label: string,
): Promise<unknown> {
  try {
    return await parseProviderJson(response, label);
  } catch (error: unknown) {
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its response could not be confirmed`,
      {
        cause: error,
      },
    );
  }
}

export function isProviderEventStream(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") === true
  );
}

export async function providerStreamResult<Value>(
  response: Response,
  label: string,
  read: (body: ReadableStream<Uint8Array>) => Promise<Value>,
  signal?: AbortSignal,
): Promise<Value> {
  if (response.body === null)
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its streaming response has no body`,
    );
  try {
    return await read(response.body);
  } catch (error: unknown) {
    if (signal?.aborted === true) throw cancelledModelRequest(error);
    if (
      error instanceof ModelHostFailureError ||
      error instanceof ModelHostOutcomeUnknownError
    )
      throw error;
    throw new ModelHostOutcomeUnknownError(
      `${label} was dispatched but its streaming response could not be confirmed`,
      { cause: error },
    );
  }
}

export async function dispatchProviderRequest(
  fetchImplementation: typeof fetch,
  url: URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await (init.redirect === "error"
      ? fetchImplementation(url, init)
      : fetchModelService(fetchImplementation, url, init));
  } catch (error: unknown) {
    if (init.signal?.aborted === true) throw cancelledModelRequest(error);
    if (error instanceof ModelServiceRedirectError)
      throw new ModelHostFailureError(error.message, {
        details: { httpStatus: error.httpStatus },
      });
    if (provenConnectTimeout(error))
      throw new RetryableModelFailure("connect_timeout");
    throw new ModelHostOutcomeUnknownError(
      `${label} request was dispatched but its outcome is unknown`,
      {
        cause: error,
      },
    );
  }
}

export function cancelledModelRequest(
  cause?: unknown,
): ModelHostCancelledError {
  return new ModelHostCancelledError(
    "The player cancelled the dispatched model request; its partial response was not committed and cannot be replayed.",
    cause === undefined ? undefined : { cause },
  );
}

export function signalWasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function unknownProviderResponse(
  label: string,
): ModelHostOutcomeUnknownError {
  return new ModelHostOutcomeUnknownError(
    `${label} was dispatched but its response shape could not be confirmed`,
  );
}

export interface ProviderDispatch {
  connection: ResolvedFileNativeModelConnection;
  fetchImplementation: typeof fetch;
  failureLog: AiFailureRecorder | undefined;
}

export function bearerProviderHeaders(apiKey: string) {
  return {
    Accept: "text/event-stream",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function providerRequestPreview(
  connection: FileNativeModelConnection,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  endpointPath = providerUrl(connection).pathname,
): ModelHostWireRequest {
  return {
    provider: connection.provider,
    method: "POST",
    endpointPath,
    headerNames: Object.keys(headers),
    body: cloneProviderValue(body),
  };
}
