import type { AppLocale } from "../protocol/appPreferences.ts";
import { defaultSettingImprovementPromptForLocale } from "./default-setting-improvement-prompt.ts";
import type {
  BuiltinPlayPrompt,
  OrderedPlayPrompt,
} from "./ordered-play-prompts.ts";

/** Authoring uses the same permissions as play, with target-specific dynamic references. */
export function builtinAuthorPrompts(locale: AppLocale): BuiltinPlayPrompt[] {
  const zh = locale === "zh-CN";
  return [
    {
      id: "author.mechanics",
      name: zh
        ? "创作工具与结算（必选）"
        : "Authoring tools and settlement (required)",
      required: true,
      body: authoringMechanics(locale, "setting"),
    },
    {
      id: "author.guidance",
      name: zh ? "创作建议" : "Authoring guidance",
      required: false,
      body: defaultSettingImprovementPromptForLocale(locale),
    },
    {
      id: "author.target",
      name: zh
        ? "创作目标与读取授权（动态必选）"
        : "Target and read authorization (required, dynamic)",
      required: true,
      body: zh
        ? "实际请求在此显示内容包或修订世界身份及当前树边界。世界修订保留独占 epoch；跨 epoch 继续时在用户消息前显式通知并清空读取授权。文件正文只通过工具按需读取，不预注入整棵树。"
        : "The actual request shows the content package or revision world identity and current-tree boundary here. World revision retains its exclusive epoch; continuing across epochs announces the transition before the user message and clears read authorization. Files are read on demand through tools, never injected as a whole tree.",
    },
    {
      id: "author.play-reference",
      name: zh ? "未来游玩参考（动态）" : "Future play reference (dynamic)",
      required: false,
      body: zh
        ? "在此展开当前预设已启用的游玩编排，明确标为未来游玩参考，不是本轮叙事要求。内容包及世界正文仍通过创作工具读取。"
        : "Expands the current preset's enabled play arrangement as future-play reference, not narrative instructions for this conversation. Actual package and world content remains behind authoring tools.",
    },
  ];
}

export function authoringMechanics(
  locale: AppLocale,
  target: "setting" | "world-revision",
): string {
  const zh = locale === "zh-CN";
  const common = zh
    ? `只使用请求随附的工具及其参数契约。含工具调用的响应是中间步；收到全部工具结果后继续，非空且无工具调用的响应结束本次发送。完整工具响应按调用顺序结算，失败调用不撤销成功同级调用。修改既有文件前必须完整读取；cursor 只属于产生它的树 revision；本事务自身成功修改后的完整读取授权由 Runtime 承接。外部树变化或跨 epoch 后旧授权失效，需要重新读取。工具返回逻辑路径，不能访问宿主文件。文档引用使用返回的 @ref；YAML 整文档引用为单键 {$ref: "@ref"}，locator 使用 map key 或从零开始的数组下标。成功回执决定当前值，模型文字不构成提交。`
    : `Use only the attached tools and their parameter contracts. Responses with tool calls are intermediate steps; continue after all results. A nonempty tool-free response ends this send. Complete tool responses settle calls in order; a failed call does not undo successful siblings. Completely read existing files before writing. Cursors belong to their producing tree revision. Runtime carries complete-read authorization through this transaction’s own successful changes. External tree changes or an epoch transition invalidate old authorization and require new reads. Tools expose logical paths, never host files. Use returned @refs for documents; YAML whole-document references are single-key {$ref: "@ref"} maps, and locators use map keys or zero-based array indexes. Actual receipts determine current values; model prose cannot commit changes.`;
  const boundary =
    target === "setting"
      ? zh
        ? "内容包工具的成功变化在完整响应结算时原子发布到当前树，无需应用。setting_create 建立新文档身份；删除仅在无绑定与引用阻挡时接受。"
        : "Successful content-package changes publish atomically to the current tree when the complete response settles, with no Apply step. setting_create establishes new document identities; deletion is accepted only without binding or reference blockers."
      : zh
        ? "世界修订工具只修改持久独占 epoch 的 state/* 与 control/* 工作树。opening.md 不可读取或修改，既有状态文档不可删除或移动。只有玩家应用或放弃才结束 epoch；应用提交世界，放弃不改变世界。跨 epoch 全部旧读取授权失效。"
        : "World-revision tools modify only state/* and control/* in the durably locked exclusive epoch. opening.md cannot be read or changed; existing state documents cannot be deleted or moved. Only player Apply or Discard ends the epoch; Apply commits the world, Discard leaves it unchanged. Every old read authorization expires across epochs.";
  return `# ${zh ? "创作工具与结算" : "Authoring tools and settlement"}\n\n${common}\n\n${boundary}`;
}

export function defaultOrderedAuthorPrompts(): OrderedPlayPrompt[] {
  return builtinAuthorPrompts("en").map(({ id }) => ({
    id,
    kind: "builtin",
    builtin: id,
    enabled: true,
  }));
}
