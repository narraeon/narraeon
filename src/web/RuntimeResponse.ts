import { uiText } from "./i18n.ts";
import {
  runtimeErrorText,
  runtimeUnreadableResponseText,
} from "./RuntimeErrorText.ts";

type RuntimeFailureKind =
  "connection" | "unreadable_response" | "protocol" | "http" | "runtime";

/** The kind describes what the browser received, independently of what Runtime committed. */
export class RuntimeRequestError extends Error {
  readonly kind: RuntimeFailureKind;
  readonly status: number | undefined;
  readonly protocolCode: string | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      kind?: RuntimeFailureKind;
      status?: number;
      protocolCode?: string | undefined;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RuntimeRequestError";
    this.kind =
      options.kind ?? (options.protocolCode === undefined ? "http" : "runtime");
    this.status = options.status;
    this.protocolCode = options.protocolCode;
    this.details = options.details;
  }
}

export function isResponseRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unreadableResponse(
  status: number,
  cause?: unknown,
): RuntimeRequestError {
  return new RuntimeRequestError(runtimeUnreadableResponseText(status), {
    kind: "unreadable_response",
    status,
    cause,
  });
}

/** Both archive and RPC endpoints return structured Runtime errors; Fastify also has a plain HTTP error shape. */
export function httpResponseError(
  status: number,
  payload: unknown,
  options: { runtimeEnvelope: boolean; fallback?: string },
): RuntimeRequestError {
  const body = isResponseRecord(payload) ? payload : {};
  const failure = isResponseRecord(body.error) ? body.error : {};
  const message =
    typeof failure.message === "string"
      ? runtimeErrorText(failure.message)
      : (options.fallback ??
        (typeof body.message === "string"
          ? runtimeErrorText(body.message)
          : uiText("Narraeon 服务请求失败（HTTP {status}）。", { status })));
  return new RuntimeRequestError(message, {
    status,
    protocolCode:
      options.runtimeEnvelope && typeof failure.code === "string"
        ? failure.code
        : undefined,
    details: failure.details,
  });
}
