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
      ? "主叙事已完成。整理一段简短的场景回顾，通过 artifact_emit 输出 recap。不要补写剧情或引入新事实。"
      : "The main narrative has settled. Emit a brief scene recap as recap using artifact_emit. Do not continue the story or introduce new facts.",
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
