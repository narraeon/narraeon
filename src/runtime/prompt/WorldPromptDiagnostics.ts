import type {
  WorldPromptPrefixComparison,
  PromptEncodingSummary,
} from "../../protocol/worldPromptDiagnostics.ts";
import type {
  ModelHostWireRequest,
  ModelHostUsage,
} from "../model/ModelHost.ts";

interface ContextPromptSample {
  bootstrap: {
    logicalMessages: {
      role: string;
      markdown: string;
      blocks: { source: string; markdown: string }[];
    }[];
  };
  encoding?: ModelHostWireRequest | null;
  usage?: ModelHostUsage;
}

/** Diagnostic comparison only: never edits the compiler or Provider cache routing. */
export function comparePromptPrefixes(
  previous: ContextPromptSample | null,
  current: ContextPromptSample,
): WorldPromptPrefixComparison {
  const previousEncoding = previous?.encoding;
  const currentEncoding = current.encoding;
  const beforeBlocks =
    previous === null ? [] : sourceBlocks(previous.bootstrap);
  const afterBlocks = sourceBlocks(current.bootstrap);
  const before = new Map(beforeBlocks.map((block) => [block.key, block]));
  const after = new Map(afterBlocks.map((block) => [block.key, block]));
  const changedSources: NonNullable<
    WorldPromptPrefixComparison["logical"]
  >["changedSources"] = [];
  if (previous !== null)
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(key);
      const right = after.get(key);
      const change =
        left === undefined
          ? "added"
          : right === undefined
            ? "removed"
            : left.markdown !== right.markdown
              ? "changed"
              : left.position !== right.position
                ? "moved"
                : null;
      if (change !== null)
        changedSources.push({
          source: (right ?? left)!.source,
          role: (right ?? left)!.role,
          change,
          previousPosition: left?.position ?? null,
          currentPosition: right?.position ?? null,
          previousBytes: left?.bytes ?? 0,
          currentBytes: right?.bytes ?? 0,
        });
    }
  const previousText = previous === null ? "" : promptText(previous.bootstrap);
  const currentText = promptText(current.bootstrap);
  const prefix = commonBytes(previousText, currentText);
  const completeEncoding = previousEncoding != null && currentEncoding != null;
  const previousBody = previousEncoding?.body;
  const currentBody = currentEncoding?.body;
  const beforeKey = cacheKey(previousBody);
  const afterKey = cacheKey(currentBody);
  const suggestions: WorldPromptPrefixComparison["suggestions"] = [];
  for (const changed of changedSources) {
    if (
      changed.role !== "world_context" ||
      changed.change !== "changed" ||
      changed.currentPosition === null
    )
      continue;
    const stableLater = afterBlocks.find(
      (block) =>
        block.role === "world_context" &&
        block.position > changed.currentPosition! &&
        block.bytes >= changed.currentBytes &&
        before.get(block.key)?.markdown === block.markdown,
    );
    if (stableLater !== undefined)
      suggestions.push({
        source: changed.source,
        afterSource: stableLater.source,
      });
  }
  return {
    logical:
      previous === null
        ? null
        : {
            commonPrefixBytes: prefix,
            previousBytes: bytes(previousText),
            currentBytes: bytes(currentText),
            firstChangedSource: firstChangedSource(current.bootstrap, prefix),
            changedSources,
            currentOrder: afterBlocks.map(
              ({ source, role, position, bytes }) => ({
                source,
                role,
                position,
                bytes,
              }),
            ),
          },
    encoding: {
      previous:
        previousEncoding == null ? null : summarizeEncoding(previousEncoding),
      current:
        currentEncoding == null ? null : summarizeEncoding(currentEncoding),
      commonJsonPrefixBytes: completeEncoding
        ? commonBytes(JSON.stringify(previousBody), JSON.stringify(currentBody))
        : null,
      firstChangedPath: completeEncoding
        ? firstChangedPath(previousBody, currentBody)
        : null,
      cacheKey: !completeEncoding
        ? "unavailable"
        : beforeKey === undefined && afterKey === undefined
          ? "absent"
          : beforeKey === afterKey
            ? "same"
            : "different",
    },
    providerUsage: {
      previous: previous?.usage ?? null,
      current: current.usage ?? null,
    },
    suggestions,
    cacheBenefit: "not_measured",
  };
}

function sourceBlocks(bootstrap: ContextPromptSample["bootstrap"]) {
  const seen = new Map<string, number>();
  return bootstrap.logicalMessages
    .flatMap(({ role, blocks }) =>
      blocks.map(({ source, markdown }) => ({ role, source, markdown })),
    )
    .map((block, index) => {
      const identity = `${block.role}\0${block.source}`;
      const occurrence = seen.get(identity) ?? 0;
      seen.set(identity, occurrence + 1);
      return {
        ...block,
        key: `${identity}\0${occurrence}`,
        position: index + 1,
        bytes: bytes(block.markdown),
      };
    });
}
function promptText(bootstrap: ContextPromptSample["bootstrap"]): string {
  return bootstrap.logicalMessages.map(({ markdown }) => markdown).join("\n\n");
}
function firstChangedSource(
  bootstrap: ContextPromptSample["bootstrap"],
  offset: number,
): string | null {
  let start = 0;
  for (const message of bootstrap.logicalMessages) {
    let search = 0;
    for (const block of message.blocks) {
      const exact = block.markdown.trim();
      const index = message.markdown.indexOf(exact, search);
      if (index < 0) continue;
      const end =
        start + bytes(message.markdown.slice(0, index + exact.length));
      if (offset < end) return block.source;
      search = index + exact.length;
    }
    start += bytes(message.markdown) + 2;
  }
  return null;
}
function summarizeEncoding(
  request: ModelHostWireRequest,
): PromptEncodingSummary {
  const leaves = scalarPaths(request.body);
  return {
    provider: request.provider,
    jsonBytes: bytes(JSON.stringify(request.body)),
    contentBlocks: leaves
      .filter(
        ({ path, value }) =>
          typeof value === "string" &&
          /(?:^|\.)(?:text|content|instructions)$/u.test(path),
      )
      .map(({ path, value }) => ({ path, bytes: bytes(String(value)) })),
    cacheBreakpoints: leaves
      .filter(
        ({ path, value }) =>
          path.endsWith("cache_control.type") && value === "ephemeral",
      )
      .map(({ path }) => path.slice(0, -".type".length)),
    hasCacheKey: cacheKey(request.body) !== undefined,
  };
}
function scalarPaths(
  value: unknown,
  path = "",
): { path: string; value: unknown }[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      scalarPaths(item, `${path}[${index}]`),
    );
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      scalarPaths(item, path === "" ? key : `${path}.${key}`),
    );
  return [{ path, value }];
}
function firstChangedPath(left: unknown, right: unknown): string | null {
  const before = scalarPaths(left);
  const after = scalarPaths(right);
  for (let index = 0; index < Math.max(before.length, after.length); index += 1)
    if (
      before[index]?.path !== after[index]?.path ||
      JSON.stringify(before[index]?.value) !==
        JSON.stringify(after[index]?.value)
    )
      return after[index]?.path ?? before[index]?.path ?? null;
  return null;
}
function cacheKey(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    "prompt_cache_key" in value
    ? value.prompt_cache_key
    : undefined;
}
function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function commonBytes(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index])
    index += 1;
  return index;
}
