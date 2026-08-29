import {
  v1Protocol,
  type V1PlayCallChainStreamFrame,
  type V1PlayCallChainView,
  type V1Request,
  type V1Response,
} from "../protocol/v1.ts";

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
  async request<T = unknown>(request: V1Request): Promise<T> {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: v1Protocol, request }),
    });
    const payload = (await response.json()) as V1Response & {
      error?: {
        code?: string;
        message?: string;
      };
    };
    if (!response.ok)
      throw new RuntimeRequestError(
        payload.error?.message ?? `Runtime request failed: ${response.status}`,
        {
          protocolCode: payload.error?.code,
        },
      );
    if (payload.protocol !== v1Protocol)
      throw new Error("The Runtime returned an incompatible protocol");
    return payload.result as T;
  }

  async streamPlayCallChain(
    request: Extract<
      V1Request,
      { type: "play.chain.start" | "play.chain.append" }
    >,
    onFrame: (frame: V1PlayCallChainStreamFrame) => void,
  ): Promise<V1PlayCallChainView> {
    const response = await fetch("/api/runtime/v1", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ protocol: v1Protocol, request }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      throw new RuntimeRequestError(
        payload.error?.message ?? `Runtime request failed: ${response.status}`,
      );
    }
    if (response.body === null)
      throw new RuntimeRequestError(
        "The Runtime did not return a call-chain stream",
      );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let final: V1PlayCallChainView | null = null;
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parsePlayCallChainStreamLine(line);
        if (frame === null) continue;
        if (frame.kind === "error")
          throw new RuntimeRequestError(frame.message);
        onFrame(frame);
        if (frame.kind === "snapshot" && frame.final) final = frame.value;
      }
      if (chunk.done) break;
    }
    const trailing = parsePlayCallChainStreamLine(pending);
    if (trailing !== null) {
      if (trailing.kind === "error")
        throw new RuntimeRequestError(trailing.message);
      onFrame(trailing);
      if (trailing.kind === "snapshot" && trailing.final)
        final = trailing.value;
    }
    if (final === null)
      throw new RuntimeRequestError(
        "The Runtime call-chain stream ended before the final snapshot",
      );
    return final;
  }
}

function parsePlayCallChainStreamLine(
  line: string,
): V1PlayCallChainStreamFrame | null {
  if (line.trim() === "") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new RuntimeRequestError(
      "The Runtime call-chain stream contains invalid JSON",
    );
  }
  if (!isRecord(payload) || payload.protocol !== v1Protocol)
    throw new RuntimeRequestError(
      "The Runtime returned an incompatible call-chain stream",
    );
  const frame = payload.frame;
  if (!isRecord(frame) || typeof frame.kind !== "string")
    throw new RuntimeRequestError(
      "The Runtime call-chain stream is missing a frame",
    );
  return frame as unknown as V1PlayCallChainStreamFrame;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
