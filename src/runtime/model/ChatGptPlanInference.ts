import type { AppLocale } from "../../protocol/appPreferences.ts";
import type { ChatGptPlanConnection } from "./FileNativeModelConnection.ts";
import {
  ModelHostFailureError,
  ModelHostOutcomeUnknownError,
} from "./ModelHost.ts";
import type { ResponsesStreamParseError } from "./ModelHostStream.ts";
import type { ProviderStreamFramingError } from "./ProviderStream.ts";
import { readProviderRejectionBody } from "./ProviderRejection.ts";
import {
  bearerProviderHeaders,
  cancelledModelRequest,
} from "./ProviderTransport.ts";
import { isRecord } from "./ProviderValues.ts";

type FailureAction =
  | "quota"
  | "authentication"
  | "unavailable"
  | "parameters"
  | "incomplete"
  | "failed";

export type ChatGptPlanMedia =
  | "event_stream"
  | "json"
  | "html"
  | "octet_stream"
  | "plain_text"
  | "other"
  | "missing";
type TransportFailure =
  | "connect_timeout"
  | "dns"
  | "request_length"
  | "response_length"
  | "socket"
  | "tls"
  | "other";

type ChatGptPlanInterruption =
  | { stage: "transport"; transport: TransportFailure }
  | {
      stage:
        | "response_media"
        | "response_body"
        | "sse_read"
        | ProviderStreamFramingError["stage"]
        | ResponsesStreamParseError["stage"];
      httpStatus: number;
      media: ChatGptPlanMedia;
    }
  | {
      stage: "sse_completed_output";
      httpStatus: number;
      media: ChatGptPlanMedia;
      output: "missing" | "invalid";
    };

export async function chatGptPlanAccessToken(
  plan: ChatGptPlanConnection,
  locale: AppLocale,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) throw cancelledModelRequest();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(cancelledModelRequest());
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const token = await Promise.race([plan.accessToken(signal), aborted]);
    if (!/^[A-Za-z0-9_.~+/=-]+$/u.test(token))
      throw new Error("Invalid ChatGPT bearer token");
    return token;
  } catch (error: unknown) {
    if (signal?.aborted) throw cancelledModelRequest();
    const action =
      isRecord(error) &&
      (error.code === "service_unavailable" ||
        error.code === "invalid_response")
        ? "unavailable"
        : "authentication";
    throw planFailure(locale, action);
  } finally {
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

export async function sendChatGptPlanRequest(input: {
  fetchImplementation: typeof fetch;
  url: URL;
  token: string;
  body: string;
  signal: AbortSignal | undefined;
  locale: AppLocale;
}): Promise<Response> {
  // An unreplayable request body also prevents Node fetch from resending a POST
  // after HTTP 421. Manual redirects keep the bearer tied to POST /v1/responses.
  const payload = new TextEncoder().encode(input.body);
  const options: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      ...bearerProviderHeaders(input.token),
      "Content-Length": String(payload.byteLength),
    },
    body: new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(payload);
        stream.close();
      },
    }),
    duplex: "half",
    redirect: "manual",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  if (input.signal?.aborted) throw cancelledModelRequest();
  try {
    return await input.fetchImplementation(input.url, options);
  } catch (error: unknown) {
    if (input.signal?.aborted) throw cancelledModelRequest();
    throw new ChatGptPlanInterruptedError(input.locale, {
      stage: "transport",
      transport: chatGptPlanTransportFailure(error),
    });
  }
}

export async function chatGptPlanHttpFailure(
  response: Response,
  plan: ChatGptPlanConnection,
  token: string,
  locale: AppLocale,
): Promise<ModelHostFailureError> {
  const body = await readProviderRejectionBody(response);
  const payload = recordFromJson(body);
  const upstream = isRecord(payload.error) ? payload.error : {};
  const code = safeIdentifier(upstream.code, token);
  const confirmedInvalidToken =
    /\bBearer\b[^\r\n]*\berror\s*=\s*"invalid_token"/iu.test(
      response.headers.get("www-authenticate") ?? "",
    );
  await invalidateRejectedToken(plan, token, code, confirmedInvalidToken);
  return planFailure(locale, failureAction(code, response.status), {
    stage: "http_rejection",
    httpStatus: response.status,
    media: chatGptPlanMedia(response),
    bodyShape: isRecord(payload.error)
      ? "structured_error"
      : typeof payload.detail === "string"
        ? "direct_admission"
        : "other",
    ...safeIdentifiers(token, {
      providerCode: code,
      param: upstream.param,
      requestId: response.headers.get("x-request-id") ?? upstream.request_id,
    }),
  });
}

export function chatGptPlanStreamFailure(
  payload: Record<string, unknown>,
  token: string,
  locale: AppLocale,
  requestId: string | null,
): ModelHostFailureError {
  const response = isRecord(payload.response) ? payload.response : {};
  const incomplete = isRecord(response.incomplete_details)
    ? response.incomplete_details
    : {};
  const upstream = isRecord(response.error)
    ? response.error
    : isRecord(payload.error)
      ? payload.error
      : payload;
  const code = safeIdentifier(upstream.code, token);
  return planFailure(
    locale,
    payload.type === "response.incomplete" ? "incomplete" : failureAction(code),
    {
      stage: "sse_terminal_failure",
      ...safeIdentifiers(token, {
        providerCode: code,
        eventType: payload.type,
        status: response.status,
        reason: incomplete.reason,
        param: upstream.param,
        requestId: requestId ?? payload.request_id ?? response.request_id,
      }),
    },
  );
}

export async function invalidateRejectedToken(
  plan: ChatGptPlanConnection,
  token: string,
  code: unknown,
  confirmedInvalidToken = false,
): Promise<void> {
  if (
    confirmedInvalidToken ||
    code === "invalid_token" ||
    code === "token_expired" ||
    code === "token_revoked"
  ) {
    await plan.invalidate?.(token).catch(() => undefined);
  }
}

export class ChatGptPlanInterruptedError extends ModelHostOutcomeUnknownError {
  readonly details: ChatGptPlanInterruption;

  constructor(locale: AppLocale, details: ChatGptPlanInterruption) {
    super(
      locale === "zh-CN"
        ? "ChatGPT 套餐请求未完整结束。请先检查网络，再手动重试。"
        : "The ChatGPT plan request ended before completion. Check your connection before retrying.",
    );
    this.details = details;
  }
}

export function chatGptPlanMedia(response: Response): ChatGptPlanMedia {
  const media = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!media) return "missing";
  if (media === "text/event-stream") return "event_stream";
  if (media === "application/json" || media.endsWith("+json")) return "json";
  if (media === "text/html" || media === "application/xhtml+xml") return "html";
  if (media === "application/octet-stream") return "octet_stream";
  if (media === "text/plain") return "plain_text";
  return "other";
}

function chatGptPlanTransportFailure(error: unknown): TransportFailure {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : error;
  const code =
    isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
  switch (code) {
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
      return "connect_timeout";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "dns";
    case "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH":
      return "request_length";
    case "UND_ERR_RES_CONTENT_LENGTH_MISMATCH":
      return "response_length";
    case "UND_ERR_SOCKET":
    case "ECONNRESET":
    case "ECONNREFUSED":
    case "EPIPE":
      return "socket";
    case undefined:
      return "other";
    default:
      return /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/u.test(
        code,
      )
        ? "tls"
        : "other";
  }
}

function failureAction(code?: string, status?: number): FailureAction {
  switch (code) {
    case undefined:
      break;
    case "subscription_sharing_usage_limit_exceeded":
      return "quota";
    case "invalid_token":
    case "token_expired":
    case "token_revoked":
    case "subscription_sharing_invalid_user":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "authentication";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
    case "subscription_sharing_user_not_eligible":
    case "subscription_sharing_route_not_supported":
      return "unavailable";
    case "subscription_sharing_unsupported_capability":
      return "parameters";
  }
  if (status === 401 || status === 403) return "authentication";
  if (status === 402 || status === 429) return "quota";
  if (status !== undefined && status >= 500) return "unavailable";
  return "failed";
}

function planFailure(
  locale: AppLocale,
  action: FailureAction,
  evidence: Record<string, unknown> = {},
): ModelHostFailureError {
  const messages = {
    quota: {
      "zh-CN":
        "此请求触及 ChatGPT 套餐使用限制。请在 ChatGPT 设置的「使用量」中查看详情，再决定何时重试。",
      en: "This request reached a ChatGPT plan usage limit. Check Usage in ChatGPT settings before retrying.",
    },
    authentication: {
      "zh-CN":
        "ChatGPT 套餐授权不可用。请到模型连接核对账号并重新授权使用套餐。",
      en: "ChatGPT plan authorization is unavailable. Check the account in Model connections and authorize plan usage again.",
    },
    unavailable: {
      "zh-CN": "此账号暂时无法使用 ChatGPT 套餐。请检查账号资格或稍后再试。",
      en: "ChatGPT plan usage is unavailable for this account. Check eligibility or try again later.",
    },
    parameters: {
      "zh-CN": "ChatGPT 套餐不支持此请求。请在模型连接核对所选模型和设置。",
      en: "The ChatGPT plan does not support this request. Check the selected model and its settings in Model connections.",
    },
    incomplete: {
      "zh-CN": "ChatGPT 套餐未完成回复。请调整本次输入或开启新对话后再试。",
      en: "ChatGPT did not complete the plan response. Try revising the input or starting a fresh context.",
    },
    failed: {
      "zh-CN": "ChatGPT 套餐请求失败。请检查模型连接后手动重试。",
      en: "The ChatGPT plan request failed. Check Model connections before retrying.",
    },
  } satisfies Record<FailureAction, Record<AppLocale, string>>;
  return new ModelHostFailureError(messages[action][locale], {
    details: { chatgptPlanFailure: action, ...evidence },
  });
}

function recordFromJson(body: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body ?? "");
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function safeIdentifier(value: unknown, token: string): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_.:[\]-]{1,128}$/u.test(value) &&
    !value.includes(token)
    ? value
    : undefined;
}

function safeIdentifiers(token: string, evidence: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(evidence).flatMap(([key, value]) => {
      const safe = safeIdentifier(value, token);
      return safe === undefined ? [] : [[key, safe]];
    }),
  );
}
