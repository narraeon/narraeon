import type { AppLocale } from "../protocol/appPreferences.ts";
import { defaultNarrationPromptForLocale } from "./default-play-prompts.ts";
import { defaultPresetHostFilesForLocale } from "./default-preset-host.ts";

export type OrderedPlayPrompt =
  | { id: string; kind: "user"; name: string; enabled: boolean; body: string }
  | { id: string; kind: "builtin"; builtin: string; enabled: boolean }
  | { id: string; kind: "world" };

export interface BuiltinPlayPrompt {
  id: string;
  name: string;
  body: string;
  required: boolean;
}

/** Application-owned references. Persist references; freeze resolved text in requests. */
export function builtinPlayPrompts(locale: AppLocale): BuiltinPlayPrompt[] {
  const zh = locale === "zh-CN";
  const host = defaultPresetHostFilesForLocale(locale);
  return [
    {
      id: "play.mechanics",
      name: zh
        ? "工具与响应结算（必选）"
        : "Tools and response settlement (required)",
      required: true,
      body: zh
        ? `# 工具与响应结算

只可调用请求随附的工具。目录使用 Runtime 返回的 @dir-*；文档和历史使用返回的 @句柄。工具结果标明读取范围、完整性及 cursor；目录摘要不等于正文。材料覆盖中完整正文与精确读取授予对应范围的写入资格，界面绑定标注不授予额外权限。同一原生对话刷新提示时，仅在当前状态与旧读取凭据完全匹配时承接原精确范围，并合并本次注入授权；全新上下文不继承旧对话授权。

world_patch 的 YAML locator 可以包含 map key 和从零开始的数组下标；remove 删除一个精确位置。未提供的元数据保持原值。world_retire 从目录注入中退役文档，文档仍可读取、引用和恢复。工具响应的成功状态变化与后续最终叙事分别提交，后续失败不回滚已提交变化。成功写入回执表示当前值已改变；以真实回执的结算状态为准，模型文字不能提交世界。

包含工具调用的响应属于中间步，正文不作为最终叙事提交。收到全部工具结果后继续；没有工具调用的非空正文结束本次循环并由 Runtime 提交叙事。world_checkpoint 登记在随后最终叙事成功提交后生效，边界包含该叙事；登记后仍可继续工具调用。全新上下文的历史补充只包含检查点后的已提交玩家原文与最终叙事，排除开场白、工具和推理。`
        : `# Tools and response settlement

Use only attached tools. Directories use returned @dir-* handles; documents and history use returned @handles. Results identify read scope, completeness and cursor; directory summaries are not document bodies. Complete injected bodies and exact reads authorize writes within their corresponding scopes; player-view annotations grant no additional authority. Refreshing the same native conversation retains prior exact scopes only when the current state matches their proof, merging them with current injected authorization. A fresh context does not inherit old conversation authorization.

YAML world_patch locators accept map keys and zero-based array indexes; remove deletes one exact location. Omitted metadata remains unchanged. world_retire removes a document from catalog injection while keeping it readable, referenceable and restorable. Successful tool-response state changes and later final narrative commit separately; later failure does not roll back committed changes. Successful write receipts change current values; the actual receipt determines settlement, not model prose.

Responses containing tool calls are intermediate steps; their text is not committed as final narrative. Continue after all tool results. A nonempty tool-free response ends this loop and Runtime commits its narrative. world_checkpoint takes effect after the subsequent final narrative commits, including that narrative in its boundary; further tool calls may follow registration. Fresh-context replay contains committed player originals and final narratives after the checkpoint, excluding the opening, tools and reasoning.`,
    },
    {
      id: "play.style",
      name: zh ? "通用文风" : "General style",
      body: host["blocks/style.md"]!,
      required: false,
    },
    ...["adjudication", "state"].map((id) => ({
      id: `play.${id}`,
      name: zh
        ? id === "state"
          ? "状态维护建议"
          : "裁判与玩家代理权"
        : id === "state"
          ? "State maintenance"
          : "Adjudication and player agency",
      body: host[`blocks/${id}.md`]!,
      required: false,
    })),
    {
      id: "play.narrative",
      name: zh ? "叙事建议" : "Narrative guidance",
      body: defaultNarrationPromptForLocale(locale),
      required: false,
    },
    ...Object.entries(host)
      .filter(([path]) => path.startsWith("blocks/style-"))
      .map(([path, body]) => ({
        id: `play.${path.slice(7, -3)}`,
        name: /^#\s+(.+)$/mu.exec(body)?.[1] ?? path,
        body,
        required: false,
      })),
  ];
}

export function defaultOrderedPlayPrompts(): OrderedPlayPrompt[] {
  return builtinPlayPrompts("en")
    .map(({ id }): OrderedPlayPrompt => ({
      id,
      kind: "builtin",
      builtin: id,
      enabled: !id.startsWith("play.style-"),
    }))
    .concat([{ id: "world", kind: "world" }]);
}
