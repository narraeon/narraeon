export function findToolResult(
  requests: readonly {
    appended: readonly {
      kind: string;
      toolCallId?: string;
      markdown?: string;
    }[];
  }[],
  toolCallId: string,
): string {
  for (const request of requests)
    for (const item of request.appended)
      if (
        item.kind === "tool" &&
        item.toolCallId === toolCallId &&
        typeof item.markdown === "string"
      )
        return item.markdown;
  throw new Error(`缺少工具结果：${toolCallId}`);
}
