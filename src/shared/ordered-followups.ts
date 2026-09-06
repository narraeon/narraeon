/** References own order and enablement; user definitions and resources stay intact. */
export interface FollowupItem {
  id: string;
  kind: "user" | "builtin" | "content-package";
  enabled: boolean;
}

export function defaultFollowupItems(
  definitions: readonly { id: string }[],
): FollowupItem[] {
  return [
    ...definitions.map(({ id }): FollowupItem => ({
      id,
      kind: "user",
      enabled: true,
    })),
    { id: "builtin:summary", kind: "builtin", enabled: false },
    { id: "package:followups", kind: "content-package", enabled: true },
  ];
}

/** A current application example; snapshots freeze the compiled text, never this reference. */
export function builtinFollowupExample(locale: "en" | "zh-CN") {
  const zh = locale === "zh-CN";
  return {
    body: zh
      ? "主叙事已完成。仅根据已向玩家呈现的叙事与明确可见事实整理简短场景回顾，通过 artifact_emit 输出 recap。不要从工具材料、未表露认知或场外状态补全幕后原因，不补写剧情或引入新事实。回顾只是显示产物，不替代状态维护、检查点或历史恢复。"
      : "The main narrative has settled. Emit a brief scene recap as recap using artifact_emit, using only narrative already shown to the player and explicitly visible facts. Do not fill in backstage causes from tool material, unexpressed knowledge or offstage state. Do not continue the story or introduce new facts. This display artifact does not replace state maintenance, checkpoints or history recovery.",
    definition: {
      id: "builtin:summary",
      displayName: zh ? "场景回顾（系统示例）" : "Scene recap (system example)",
      prompt: {
        role: "author_instruction" as const,
        path: "builtin:followup-summary",
      },
      artifacts: [
        {
          name: "recap",
          channel: "builtin:summary",
          strategy: "replace" as const,
          contentType: "text/markdown" as const,
          rendererMode: "document" as const,
          save: "commit" as const,
          invalidation: "explicit_clear" as const,
          required: true,
          maxEmits: 1,
        },
      ],
      maxArtifactBytes: 32_768,
    },
  };
}
