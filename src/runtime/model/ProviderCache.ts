import { createHash } from "node:crypto";
import {
  modelCacheStrategy,
  type ResolvedFileNativeModelConnection,
} from "./FileNativeModelConnection.ts";
import type { ModelHostAppendItem, ModelHostExchange } from "./ModelHost.ts";
import { isRecord } from "./ProviderValues.ts";

/** Anthropic allows four cache_control breakpoints per request. */
const explicitCacheBreakpointLimit = 4;

export function promptCacheKey(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
): string {
  const stablePrefixScope =
    request.bootstrap.cache.stablePrefixFingerprint ??
    createHash("sha256")
      .update(
        JSON.stringify({
          provider: request.bootstrap.provider,
          tools: request.toolUniverse ?? request.tools,
          toolStrategy: request.toolStrategy,
        }),
      )
      .digest("hex");
  // OpenAI uses this as a cache-routing hint, so equal frozen prefixes should
  // share it. CLIProxyAPI additionally treats it as execution-session identity;
  // there it must stay stable within one chain and isolated across chains.
  const scope =
    connection.dialect === "cliproxyapi"
      ? (request.operationId ?? stablePrefixScope)
      : stablePrefixScope;
  return createHash("sha256")
    .update(
      `${connection.provider}\0${connection.dialect}\0${connection.modelId}\0${scope}`,
    )
    .digest("hex");
}

/**
 * Explicit-breakpoint encodings mark the last transcript item before the
 * request-level suffix, so the next dispatch reads back the transcript it sent.
 * A request without a suffix keeps its request end as the transcript's entry,
 * so it is encoded exactly as before.
 */
export function appendWithSuffixBreakpoint(
  connection: ResolvedFileNativeModelConnection,
  request: ModelHostExchange,
  encode: (items: readonly ModelHostAppendItem[]) => unknown[],
  markLast: (encoded: unknown[]) => unknown[],
): unknown[] {
  const { transcript, suffix } = splitRequestSuffix(request.appended);
  const encoded = encode(transcript);
  const breakpoint =
    suffix.length > 0 &&
    encoded.length > 0 &&
    connection.cacheSuffixBreakpoint &&
    modelCacheStrategy(connection) !== "provider_managed";
  return [...(breakpoint ? markLast(encoded) : encoded), ...encode(suffix)];
}

/** Request-level suffix items are recompiled for every dispatch and never stored. */
function splitRequestSuffix(appended: readonly ModelHostAppendItem[]): {
  transcript: ModelHostAppendItem[];
  suffix: ModelHostAppendItem[];
} {
  let end = appended.length;
  while (end > 0 && isRequestSuffix(appended[end - 1]!)) end -= 1;
  return { transcript: appended.slice(0, end), suffix: appended.slice(end) };
}

export function isRequestSuffix(item: ModelHostAppendItem): boolean {
  return item.kind === "runtime_notice" && item.notice === "turn_guide";
}

/** Message-level cache_control, the form the CLIProxyAPI prefix breakpoints use. */
export function markLastMessage(messages: unknown[]): unknown[] {
  const last = messages.at(-1);
  if (!isRecord(last))
    throw new Error("The transcript tail cannot carry a cache breakpoint.");
  return [
    ...messages.slice(0, -1),
    { ...last, cache_control: { type: "ephemeral" } },
  ];
}

/** Refuses a request over the breakpoint limit instead of silently dropping one. */
export function checkedCacheBreakpoints<Body>(
  body: Body,
  count = countCacheBreakpoints(body),
): Body {
  if (count > explicitCacheBreakpointLimit)
    throw new Error(
      `The request has ${count} cache breakpoints; the Anthropic limit is ${explicitCacheBreakpointLimit}.`,
    );
  return body;
}

function countCacheBreakpoints(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce(
      (total: number, item) => total + countCacheBreakpoints(item),
      0,
    );
  if (!isRecord(value)) return 0;
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total + (key === "cache_control" ? 1 : 0) + countCacheBreakpoints(item),
    0,
  );
}
