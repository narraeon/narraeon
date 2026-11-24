import { stringify } from "yaml";
import type { AppLocale } from "../protocol/appPreferences.ts";
import {
  applicationPresetFilesForLocale,
  orchestrationFormat,
  orchestrationManifest,
} from "./application-preset-files.ts";
import { defaultFollowupItems } from "./ordered-followups.ts";

export function firstPartyArtifactDebuggerPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  const id = "emit_debug_example";
  const channel = "artifact-debugger.example";
  const promptPath = "prompts/debug-example.md";
  return {
    ...applicationPresetFilesForLocale(locale),
    [orchestrationManifest]: stringify({
      format: orchestrationFormat,
      name: "artifact-debugger",
      callChain: "call-chain.yaml",
      playPrompts: {},
      authorPrompts: {},
      mergeConsecutiveMessages: false,
      mounts: { [channel]: "debug" },
      extensions: [],
    }),
    "call-chain.yaml": stringify({
      format: "narraeon.play-call-chain/v2",
      narrative: [],
      followupItems: defaultFollowupItems([{ id }]),
      followups: [
        {
          id,
          displayName:
            locale === "zh-CN" ? "发送调试示例" : "Emit debug example",
          prompt: { role: "author_instruction", markdown: promptPath },
          maxArtifactBytes: 2048,
          artifacts: [
            {
              name: "debug_example",
              channel,
              strategy: "append",
              contentType: "text/markdown",
              save: "operation",
              invalidation: "operation_end",
              required: true,
              maxEmits: 1,
            },
          ],
        },
      ],
    }),
    [promptPath]:
      locale === "zh-CN"
        ? `# 调试频道示例

主叙事已经提交。用 artifact_emit 向 debug_example 发送一行 Markdown，简述本轮已发生的一件事。只发送一次。

世界页自带通用产物调试器，可查看扩展状态和产物原文。此示例只提供一条可检查的调试频道输出。
`
        : `# Debug channel example

The main narrative has already been committed. Use artifact_emit to send one line of Markdown to debug_example about something that happened this turn. Emit exactly once.

The world page has a built-in artifact debugger for inspecting extension status and raw output. This example supplies one debug-channel output to inspect.
`,
  };
}
