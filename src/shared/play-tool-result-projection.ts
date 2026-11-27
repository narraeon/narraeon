import type { V1PlayCallChainEvent } from "../protocol/v1.ts";

type ToolResult = Extract<V1PlayCallChainEvent, { kind: "tool_result" }>;

/** Keep a settled hidden result available to turn controls without projecting its contents. */
export function projectPlayToolResult(
  event: ToolResult,
): Omit<ToolResult, "markdown"> {
  const { markdown: _markdown, resolution, ...summary } = event;
  void _markdown;
  if (resolution?.visibility === "hidden" || summary.hiddenResolution)
    return { ...summary, hiddenResolution: true };
  if (resolution === undefined) return summary;
  return { ...summary, resolution: structuredClone(resolution) };
}
