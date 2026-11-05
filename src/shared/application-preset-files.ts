import type { AppLocale } from "../protocol/appPreferences.ts";
import { stringify } from "yaml";

/** App-owned defaults contain declarations, never copies of the prompt catalog. */
export function applicationPresetFilesForLocale(
  locale: AppLocale,
): Record<string, string> {
  return {
    "preset.yaml": stringify({
      format: "narraeon.play-preset/v3",
      name: locale === "zh-CN" ? "系统推荐" : "System recommended",
      callChain: "call-chain.yaml",
      playPrompts: {},
      authorPrompts: {},
      mergeConsecutiveMessages: false,
      mounts: [],
      extensions: [],
    }),
    "call-chain.yaml":
      "format: narraeon.play-call-chain/v1\nnarrative: []\nfollowups: []\n",
    "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - include: world.instructions
  world_context:
    - include: world.context
    - builtin: runtime.coverage
`,
  };
}
