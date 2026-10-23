import { observeConversation } from "./ConversationObserver.ts";
import { v1Protocol, type V1Request, type V1Response } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";
import {
  runtimeConnectionErrorText,
  runtimeErrorText,
  runtimeUnreadableResponseText,
} from "./RuntimeErrorText.ts";

export class RuntimeRequestError extends Error {
  readonly protocolCode: string | undefined;
  readonly details: unknown;

  constructor(
    message: string,
    options: {
      protocolCode?: string | undefined;
      details?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "RuntimeRequestError";
    this.protocolCode = options.protocolCode;
    this.details = options.details;
  }
}

export class RuntimeClient {
  readonly observeConversation = observeConversation;
  async request<T = unknown>(request: V1Request): Promise<T> {
    let response: Response;
    try {
      response = await fetch("/api/runtime/v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: v1Protocol, request }),
      });
    } catch {
      throw new RuntimeRequestError(runtimeConnectionErrorText());
    }
    let payload: V1Response & {
      error?: { code?: string; message?: string; details?: unknown } | string;
      message?: string;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      // A restarting server or a reverse proxy can answer with HTML.
      throw new RuntimeRequestError(
        runtimeUnreadableResponseText(response.status),
      );
    }
    if (!response.ok) {
      // Unexpected Runtime errors use the HTTP server's own error shape.
      const error = typeof payload.error === "object" ? payload.error : null;
      const message = error?.message ?? payload.message;
      throw new RuntimeRequestError(
        message === undefined
          ? uiText("Narraeon 服务请求失败（HTTP {status}）。", {
              status: response.status,
            })
          : runtimeErrorText(message),
        { protocolCode: error?.code, details: error?.details },
      );
    }
    if (payload.protocol !== v1Protocol)
      throw new Error(uiText("Narraeon 服务版本与页面不匹配，请刷新页面。"));
    return payload.result as T;
  }
}
