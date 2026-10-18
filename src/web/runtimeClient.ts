import { observeConversation } from "./ConversationObserver.ts";
import { v1Protocol, type V1Request, type V1Response } from "../protocol/v1.ts";

export class RuntimeRequestError extends Error {
  readonly protocolCode: string | undefined;

  constructor(
    message: string,
    options: {
      protocolCode?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = "RuntimeRequestError";
    this.protocolCode = options.protocolCode;
  }
}

export class RuntimeClient {
  readonly observeConversation = observeConversation;
  async request<T = unknown>(request: V1Request): Promise<T> {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: v1Protocol, request }),
    });
    const payload = (await response.json()) as V1Response & {
      error?: { code?: string; message?: string } | string;
      message?: string;
    };
    if (!response.ok) {
      // Unexpected Runtime errors use the HTTP server's own error shape.
      const error = typeof payload.error === "object" ? payload.error : null;
      throw new RuntimeRequestError(
        error?.message ??
          payload.message ??
          `Runtime request failed: ${response.status}`,
        { protocolCode: error?.code },
      );
    }
    if (payload.protocol !== v1Protocol)
      throw new Error("The Runtime returned an incompatible protocol");
    return payload.result as T;
  }
}
