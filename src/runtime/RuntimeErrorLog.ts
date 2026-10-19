import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const runtimeErrorLogFormat = "narraeon.runtime-error-log/v1" as const;

export interface RuntimeErrorDescription {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface RuntimeErrorRecord {
  format: typeof runtimeErrorLogFormat;
  recordedAt: string;
  kind: "request_failed" | "play_interrupted";
  requestType: string;
  /** Only identifiers and endpoints from the request, never player or world text. */
  request: Record<string, string | number>;
  error: RuntimeErrorDescription;
  /** The error's `cause` chain, outermost first. */
  causes?: RuntimeErrorDescription[];
}

/**
 * Append-only diagnostics for Runtime requests that fail or leave a play call
 * interrupted. One JSONL file per UTC day; recording never changes the
 * request's own outcome.
 */
export class FileNativeRuntimeErrorLog {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async recordRequestFailure(request: object, error: unknown): Promise<void> {
    const [outer, ...causes] = describeErrorChain(error);
    await this.#append({
      kind: "request_failed",
      request,
      error: outer!,
      ...(causes.length === 0 ? {} : { causes }),
    });
  }

  async recordPlayInterruption(
    request: object,
    failure: { message: string; kind?: string },
  ): Promise<void> {
    await this.#append({
      kind: "play_interrupted",
      request,
      error: {
        name: "PlayCallInterrupted",
        message: failure.message,
        ...(failure.kind === undefined ? {} : { code: failure.kind }),
      },
    });
  }

  async #append(input: {
    kind: RuntimeErrorRecord["kind"];
    request: object;
    error: RuntimeErrorDescription;
    causes?: RuntimeErrorDescription[];
  }): Promise<void> {
    try {
      const recordedAt = new Date().toISOString();
      const record: RuntimeErrorRecord = {
        format: runtimeErrorLogFormat,
        recordedAt,
        kind: input.kind,
        requestType: requestType(input.request),
        request: requestIdentifiers(input.request),
        error: input.error,
        ...(input.causes === undefined ? {} : { causes: input.causes }),
      };
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await chmod(this.#root, 0o700);
      const path = join(this.#root, `${recordedAt.slice(0, 10)}.jsonl`);
      await appendFile(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(path, 0o600);
    } catch {
      // Diagnostics must never change Runtime request semantics.
    }
  }
}

function requestType(request: object): string {
  const type = (request as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
}

function requestIdentifiers(request: object): Record<string, string | number> {
  const identifiers: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(request)) {
    if (!/(?:Id|Head|^continuation|^context|^format|^limit)$/u.test(key))
      continue;
    if (typeof value === "string" || typeof value === "number")
      identifiers[key] = value;
  }
  return identifiers;
}

function describeErrorChain(error: unknown): RuntimeErrorDescription[] {
  const chain: RuntimeErrorDescription[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push(describeError(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function describeError(error: unknown): RuntimeErrorDescription {
  if (!(error instanceof Error))
    return { name: "UnknownError", message: String(error) };
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
