import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import type { ModelProviderKind } from "../../protocol/modelConnections.ts";

export const aiFailureLogFormat = "narraeon.ai-failure-log/v1" as const;

export type AiFailureKind =
  | "provider_transport"
  | "provider_rejection"
  | "provider_response_format"
  | "tool_execution"
  | "format_validation"
  | "runtime_post_processing";

export interface AiFailureDescription {
  kind: AiFailureKind;
  message: string;
  details?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: string;
  };
}

export interface AiExchangeDiagnostics {
  captureId: string;
  provider: ModelProviderKind;
  endpoint: string;
  context: {
    scope:
      | "play_call_chain"
      | "play_followup"
      | "setting_improvement"
      | "model_host";
    requestId?: string;
    operationId?: string;
    requestAttempt?: number;
    exchange?: number;
  };
  request: {
    method: "POST";
    contentType: "application/json";
    body: string;
  };
  response?: {
    status: number;
    statusText: string;
    contentType: string | null;
    body: string;
    /** False means the Runtime only received the recorded prefix. */
    bodyComplete: boolean;
  };
  /** Only reasoning/thinking text the Provider actually returned. */
  reasoning?: string;
}

export interface AiFailureRecorder {
  /** Start an incident, or append another failure to the active incident. */
  recordFailure(input: {
    exchange: AiExchangeDiagnostics;
    failures: AiFailureDescription[];
  }): Promise<void>;
  /** Append a later exchange only while an incident for this operation is open. */
  recordExchangeIfActive(exchange: AiExchangeDiagnostics): Promise<void>;
  /** Close an active incident after the logical AI operation succeeds. */
  resolve(input: {
    exchange: AiExchangeDiagnostics;
    message: string;
    details?: unknown;
  }): Promise<void>;
}

interface IncidentState {
  format: typeof aiFailureLogFormat;
  traceKey: string;
  incidentId: string;
  logFile: string;
  status: "active" | "resolved";
  lastCaptureId: string | null;
  updatedAt: string;
}

/**
 * Append-only, failure-triggered Provider diagnostics.
 *
 * No successful request creates a file. Once an operation fails, the triggering
 * exchange and every later exchange are retained until the caller marks the
 * operation repaired. State files make that recording window survive a Runtime
 * restart. API credentials and request headers never enter the capture.
 */
export class FileNativeAiFailureLog implements AiFailureRecorder {
  readonly #root: string;
  readonly #stateRoot: string;

  constructor(root: string) {
    this.#root = root;
    this.#stateRoot = join(root, ".state");
  }

  async recordFailure(input: {
    exchange: AiExchangeDiagnostics;
    failures: AiFailureDescription[];
  }): Promise<void> {
    if (input.failures.length === 0) return;
    await this.#bestEffort(async () => {
      const traceKey = failureTraceKey(input.exchange);
      let state = await this.#readState(traceKey);
      if (state === null || state.status === "resolved")
        state = await this.#startIncident(traceKey, input.exchange);
      else state = await this.#appendExchange(state, input.exchange);
      await this.#appendLine(state, {
        type: "failure",
        recordedAt: new Date().toISOString(),
        failures: cloneJson(input.failures),
      });
      await this.#writeState({
        ...state,
        status: "active",
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async recordExchangeIfActive(exchange: AiExchangeDiagnostics): Promise<void> {
    await this.#bestEffort(async () => {
      const state = await this.#readState(failureTraceKey(exchange));
      if (state?.status !== "active") return;
      await this.#appendExchange(state, exchange);
    });
  }

  async resolve(input: {
    exchange: AiExchangeDiagnostics;
    message: string;
    details?: unknown;
  }): Promise<void> {
    await this.#bestEffort(async () => {
      const traceKey = failureTraceKey(input.exchange);
      const current = await this.#readState(traceKey);
      if (current?.status !== "active") return;
      const state = await this.#appendExchange(current, input.exchange);
      const recordedAt = new Date().toISOString();
      await this.#appendLine(state, {
        type: "resolved",
        recordedAt,
        message: input.message,
        ...(input.details === undefined
          ? {}
          : { details: cloneJson(input.details) }),
      });
      await this.#writeState({
        ...state,
        status: "resolved",
        updatedAt: recordedAt,
      });
    });
  }

  async #startIncident(
    traceKey: string,
    exchange: AiExchangeDiagnostics,
  ): Promise<IncidentState> {
    await this.#prepareRoots();
    const incidentId = randomUUID();
    const startedAt = new Date().toISOString();
    const logFile = `${fileTimestamp(startedAt)}-${incidentId}.jsonl`;
    const state: IncidentState = {
      format: aiFailureLogFormat,
      traceKey,
      incidentId,
      logFile,
      status: "active",
      lastCaptureId: exchange.captureId,
      updatedAt: startedAt,
    };
    const initial = [
      {
        type: "incident",
        format: aiFailureLogFormat,
        incidentId,
        traceKey,
        startedAt,
      },
      {
        type: "exchange",
        recordedAt: startedAt,
        exchange: cloneJson(exchange),
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    await writeFile(join(this.#root, logFile), `${initial}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(join(this.#root, logFile), 0o600);
    await this.#writeState(state);
    return state;
  }

  async #appendExchange(
    state: IncidentState,
    exchange: AiExchangeDiagnostics,
  ): Promise<IncidentState> {
    if (state.lastCaptureId === exchange.captureId) return state;
    const recordedAt = new Date().toISOString();
    await this.#appendLine(state, {
      type: "exchange",
      recordedAt,
      exchange: cloneJson(exchange),
    });
    const next = {
      ...state,
      lastCaptureId: exchange.captureId,
      updatedAt: recordedAt,
    };
    await this.#writeState(next);
    return next;
  }

  async #appendLine(state: IncidentState, value: unknown): Promise<void> {
    const path = join(this.#root, basename(state.logFile));
    await appendFile(path, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o600);
  }

  async #readState(traceKey: string): Promise<IncidentState | null> {
    const path = this.#statePath(traceKey);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    const value = JSON.parse(source) as unknown;
    if (!isIncidentState(value, traceKey)) return null;
    return value;
  }

  async #writeState(state: IncidentState): Promise<void> {
    await this.#prepareRoots();
    const path = this.#statePath(state.traceKey);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async #prepareRoots(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(this.#root, 0o700),
      chmod(this.#stateRoot, 0o700),
    ]);
  }

  #statePath(traceKey: string): string {
    const name = createHash("sha256").update(traceKey).digest("hex");
    return join(this.#stateRoot, `${name}.json`);
  }

  async #bestEffort(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      // Diagnostics must never change Provider or Runtime authority semantics.
    }
  }
}

/** Mutable capture used only for the lifetime of one Provider request. */
export class AiExchangeCapture {
  readonly #base: Omit<AiExchangeDiagnostics, "response" | "reasoning">;
  readonly #responseChunks: Buffer[] = [];
  #response:
    Omit<NonNullable<AiExchangeDiagnostics["response"]>, "body"> | undefined;
  #reasoning = "";

  constructor(input: {
    provider: ModelProviderKind;
    endpoint: URL;
    context: AiExchangeDiagnostics["context"];
    requestBody: string;
  }) {
    this.#base = {
      captureId: randomUUID(),
      provider: input.provider,
      endpoint: safeEndpoint(input.endpoint),
      context: cloneJson(input.context),
      request: {
        method: "POST",
        contentType: "application/json",
        body: input.requestBody,
      },
    };
  }

  observeReasoning(text: string): void {
    this.#reasoning += text;
  }

  setReasoning(text: string | undefined): void {
    if (text !== undefined) this.#reasoning = text;
  }

  captureResponse(response: Response): Response {
    this.#response = {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type"),
      bodyComplete: response.body === null,
    };
    if (response.body === null) return response;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const captured = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (this.#response !== undefined)
              this.#response.bodyComplete = true;
            controller.close();
            return;
          }
          this.#responseChunks.push(Buffer.from(value));
          controller.enqueue(value);
        } catch (error: unknown) {
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } catch {
          // The caller's Provider classification remains authoritative.
        }
      },
    });
    return new Response(captured, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  snapshot(): AiExchangeDiagnostics {
    return {
      ...cloneJson(this.#base),
      ...(this.#response === undefined
        ? {}
        : {
            response: {
              ...cloneJson(this.#response),
              body: Buffer.concat(this.#responseChunks).toString("utf8"),
            },
          }),
      ...(this.#reasoning === "" ? {} : { reasoning: this.#reasoning }),
    };
  }
}

export function errorDescription(
  error: unknown,
): NonNullable<AiFailureDescription["error"]> {
  if (!(error instanceof Error))
    return { name: "UnknownError", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined ? {} : { cause: describeCause(error.cause) }),
  };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  if (
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  )
    return String(cause);
  if (cause === null) return "null";
  try {
    return JSON.stringify(cause) ?? "undefined";
  } catch {
    return "[unserializable cause]";
  }
}

function failureTraceKey(exchange: AiExchangeDiagnostics): string {
  const { scope, operationId, requestId } = exchange.context;
  if (scope === "play_followup")
    return [scope, operationId ?? "", requestId ?? exchange.endpoint].join(
      "\0",
    );
  return [scope, operationId ?? requestId ?? exchange.endpoint].join("\0");
}

function safeEndpoint(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function fileTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function isIncidentState(
  value: unknown,
  traceKey: string,
): value is IncidentState {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Partial<IncidentState>).format === aiFailureLogFormat &&
    (value as Partial<IncidentState>).traceKey === traceKey &&
    typeof (value as Partial<IncidentState>).incidentId === "string" &&
    typeof (value as Partial<IncidentState>).logFile === "string" &&
    ((value as Partial<IncidentState>).status === "active" ||
      (value as Partial<IncidentState>).status === "resolved") &&
    ((value as Partial<IncidentState>).lastCaptureId === null ||
      typeof (value as Partial<IncidentState>).lastCaptureId === "string") &&
    typeof (value as Partial<IncidentState>).updatedAt === "string"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
