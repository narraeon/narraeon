import { mayChangeUserState } from "../protocol/requestEffect.ts";
import { observeConversation } from "./ConversationObserver.ts";
import type { V1Request } from "../protocol/v1.ts";
import { v1Protocol } from "../protocol/v1Version.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { runtimeConnectionErrorText } from "./RuntimeErrorText.ts";
import {
  RuntimeRequestError,
  httpResponseError,
  isResponseRecord,
  unreadableResponse,
} from "./RuntimeResponse.ts";

export { RuntimeRequestError } from "./RuntimeResponse.ts";

function requestFailure(
  request: V1Request,
  error: RuntimeRequestError,
): RuntimeRequestError {
  if (!mayChangeUserState(request.type) || error.kind === "runtime")
    return error;
  // A lost response (including an intermediary's HTTP error) cannot establish a rejected write.
  const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
  const reason =
    error.kind === "unreadable_response"
      ? (getWebLocale() === "en"
          ? "Unreadable service response"
          : "服务响应无法读取") + status
      : error.message;
  const message =
    getWebLocale() === "en"
      ? `Could not confirm the outcome. Check the current record before submitting again. ${reason}`
      : `尚无法确认这次操作的结果。请先核对当前记录，再决定是否重新提交。${reason}`;
  return new RuntimeRequestError(message, {
    kind: error.kind,
    ...(error.status === undefined ? {} : { status: error.status }),
    cause: error,
  });
}

export class RuntimeClient {
  readonly observeConversation = observeConversation;
  async request<T = unknown>(request: V1Request): Promise<T> {
    try {
      return (await exchange(request)) as T;
    } catch (error) {
      if (error instanceof RuntimeRequestError)
        throw requestFailure(request, error);
      throw error;
    }
  }
}

async function exchange(request: V1Request): Promise<unknown> {
  const body = JSON.stringify({ protocol: v1Protocol, request });
  let response: Response;
  try {
    response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (cause) {
    throw new RuntimeRequestError(runtimeConnectionErrorText(), {
      kind: "connection",
      cause,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw unreadableResponse(response.status, cause);
  }
  if (!response.ok)
    throw httpResponseError(response.status, payload, {
      runtimeEnvelope:
        isResponseRecord(payload) && payload.protocol === v1Protocol,
    });
  if (!isResponseRecord(payload) || typeof payload.protocol !== "string")
    throw unreadableResponse(response.status);
  if (payload.protocol !== v1Protocol)
    throw new RuntimeRequestError(
      uiText("Narraeon 服务版本与页面不匹配，请刷新页面。"),
      { kind: "protocol", status: response.status },
    );
  if (!Object.hasOwn(payload, "result") || "error" in payload)
    throw unreadableResponse(response.status);
  return payload.result;
}
