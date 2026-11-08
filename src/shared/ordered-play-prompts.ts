import { historyUseGuidance } from "./history-use-guidance.ts";
import type { AppLocale } from "../protocol/appPreferences.ts";
import type { Gameplay } from "../protocol/gameplay.ts";
import { defaultPresetHostFilesForLocale } from "./default-preset-host.ts";
import { tabletopPlayBody } from "./tabletop-guidance.ts";

export type PromptMessageRole = "system" | "user" | "assistant";

export function isPromptMessageRole(
  value: unknown,
): value is PromptMessageRole {
  return value === "system" || value === "user" || value === "assistant";
}

/** A prompt that compiles only for worlds or packages with this gameplay. */
export type PromptGameplayScope = "tabletop";

/**
 * How the editor presents a builtin: the required mechanics, one choice out
 * of an exclusive group, an independent policy, or a stackable style. The
 * category never changes compilation; every enabled entry compiles in list
 * order regardless of it.
 */
export type PromptCategory = "mechanics" | "choice" | "policy" | "style";

/** Exclusive choice groups: enabling one member disables its siblings. */
export type PromptGroup = "person" | "continue" | "agency" | "stop";

export const promptGroups: readonly PromptGroup[] = [
  "person",
  "continue",
  "agency",
  "stop",
];

export function isPromptGroup(value: unknown): value is PromptGroup {
  return (promptGroups as readonly unknown[]).includes(value);
}

/**
 * An ordered play prompt. Builtin and user entries carry prose for the prefix
 * and may carry one turn-guide line for the per-send suffix; a tail entry
 * carries only the line. A builtin's `turnGuide` overrides the catalog default
 * (`""` clears it, `undefined` keeps it).
 */
export type OrderedPlayPrompt = { messageRole?: PromptMessageRole } & (
  | {
      id: string;
      kind: "user";
      name: string;
      enabled: boolean;
      body: string;
      gameplay?: PromptGameplayScope;
      turnGuide?: string;
    }
  | {
      id: string;
      kind: "builtin";
      builtin: string;
      enabled: boolean;
      turnGuide?: string;
    }
  | { id: string; kind: "tail"; name: string; enabled: boolean; body: string }
  | { id: string; kind: "world" }
);

export interface BuiltinPlayPrompt {
  id: string;
  name: string;
  body: string;
  required: boolean;
  /** Explicit app default; omitted catalogs use their category/group convention. */
  defaultEnabled?: boolean;
  category: PromptCategory;
  group?: PromptGroup;
  /** The default line this block contributes to the per-send turn guide. */
  turnGuide?: string;
  /** Tabletop-scoped builtins are skipped for interactive fiction. */
  gameplay?: PromptGameplayScope;
}

/** Soft limits for the turn guide; exceeding them warns without rejecting. */
export const turnGuideLineSoftLimit = 120;
export const turnGuideLinesSoftLimit = 10;

/** One turn-guide line: no line breaks, bounded length; empty clears a builtin default. */
const turnGuideLinePattern = /^[^\r\n\0]{0,1000}$/u;

export function isTurnGuideLine(value: string): boolean {
  return turnGuideLinePattern.test(value);
}

/**
 * Unscoped prompts always apply. A scoped prompt applies only when the compiled
 * world or package is tabletop, so fiction requests never see it.
 */
export function promptScopeApplies(
  scope: PromptGameplayScope | undefined,
  gameplay: Gameplay,
): boolean {
  return scope === undefined || gameplay.mode === "tabletop";
}

/** The scope of an ordered entry: a user entry's own scope or its builtin's. */
export function orderedPromptScope(
  entry: OrderedPlayPrompt,
  catalog: readonly BuiltinPlayPrompt[],
): PromptGameplayScope | undefined {
  if (entry.kind === "user") return entry.gameplay;
  if (entry.kind === "builtin")
    return catalog.find((item) => item.id === entry.builtin)?.gameplay;
  return undefined;
}

/**
 * The turn-guide line an entry contributes: the entry's own line, or the
 * catalog default for a builtin without an override. Blank lines contribute
 * nothing; the world placeholder's lines come from the world frame.
 */
export function orderedPromptTurnGuide(
  entry: OrderedPlayPrompt,
  catalog: readonly BuiltinPlayPrompt[],
): string | undefined {
  const line =
    entry.kind === "tail"
      ? entry.body
      : entry.kind === "builtin"
        ? (entry.turnGuide ??
          catalog.find((item) => item.id === entry.builtin)?.turnGuide)
        : entry.kind === "user"
          ? entry.turnGuide
          : undefined;
  const trimmed = line?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function heading(body: string, fallback: string): string {
  return /^#\s+(.+)$/mu.exec(body)?.[1] ?? fallback;
}

/** Application-owned references. Persist references; freeze resolved text in requests. */
export function builtinPlayPrompts(locale: AppLocale): BuiltinPlayPrompt[] {
  const zh = locale === "zh-CN";
  const host = defaultPresetHostFilesForLocale(locale);
  const block = (
    file: string,
    rest: Omit<BuiltinPlayPrompt, "id" | "name" | "body" | "required">,
  ): BuiltinPlayPrompt => {
    const body = host[`blocks/${file}.md`]!;
    return {
      id: `play.${file}`,
      name: heading(body, `blocks/${file}.md`),
      body,
      required: false,
      ...rest,
    };
  };
  const styleGuides: Record<string, string> = zh
    ? {
        intimate: "写清距离和已有触感；对方是否接受由他的性格和处境决定。",
        noir: "短句，写可感知的动作、物件与声音，不替角色下判断。",
        wuxia: "用语偏文，不用现代词汇；交手写清出手与应对。",
        horror: "恐惧来自不确定；不替玩家判断危险程度，也不给安全保证。",
        action:
          "写清谁在哪、朝哪动、打到没打到和已成立的代价；伤势和体力按事实累积。",
        literary:
          "说七分留三分，情绪不直接命名，结果事实写清楚；意象符合实际时间。",
      }
    : {
        intimate:
          "Show distance and established touch; whether they accept follows their character and situation.",
        noir: "Short sentences; perceptible actions, objects and sounds; no judging for characters.",
        wuxia:
          "Period diction, no modern vocabulary; make each exchange of blows legible.",
        horror:
          "Fear comes from uncertainty; do not rate the danger for the player or promise safety.",
        action:
          "Show positions, movement, what lands and established costs; wounds and fatigue accumulate according to facts.",
        literary:
          "Leave emotion unstated but outcomes clear; images must match elapsed time.",
      };
  return [
    {
      id: "play.mechanics",
      name: zh
        ? "工具与响应结算（必选）"
        : "Tools and response settlement (required)",
      required: true,
      category: "mechanics",
      body: zh
        ? `# 工具与响应结算

只可调用请求随附的工具。主调用链不能调用 artifact_emit 或 artifact_clear；这两个工具仅供后置请求使用。目录使用预加载索引或工具返回的 @dir-*，无需重复列目录确认；文档和历史使用返回的 @句柄。工具结果标明读取范围、完整性及 cursor；目录摘要不等于正文。材料覆盖中完整正文与精确读取取得对应范围的写入资格，界面绑定标注不扩大写入资格。初始世界材料只在全新上下文加载一次；后续成功工具调用与回执更新当前值和读取资格，不必重读自己刚成功写入的内容。全新上下文不继承旧对话的读取与写入资格。

world_patch 的 YAML locator 可以包含 map key 和从零开始的数组下标；add 与 replace 是 upsert，无论目标是否存在都写入，下标达到或超过长度时追加；remove 删除一个精确位置，目标不存在时为无操作。每条 edit 独立结算：失败的 edit 被跳过，其余照常生效；回执列出失败项时，已生效的 edit 不要重发，只补发列出的 edit。未提供的元数据保持原值。world_retire 从目录注入中退役文档，文档仍可读取、引用和恢复。工具响应的成功状态变化与后续最终叙事分别提交，后续失败不回滚已提交变化。成功写入回执表示当前值已改变；以真实回执的结算状态为准，模型文字不能提交世界。

包含工具调用的响应属于中间步，其中的文字尚未展示或提交为最终叙事。工具结果只结算本次调用，后续仍属同一次玩家提交；若还需读取、判定或写回，可继续调用工具，不重复已成功的写入。准备结束时，根据回执用非空无工具最终正文呈现本轮尚未展示的内容，并与已提交状态一致；工具结算不扩大叙事范围。Runtime 提交最终正文并结束循环。world_checkpoint 登记历史重放边界并向玩家建议从此开始全新上下文；在随后非空且无工具调用的最终正文成功提交后生效，边界包含该正文；登记后仍可继续工具调用。登记不结束世界内事件，也不自动切换上下文；界面预选下一次全新上下文，玩家可以取消预选。全新上下文完整补入边界后的已提交玩家原文与最终叙事，非空时替代 frame 的 recent；为空时沿用 frame 的 recent 声明，可以带入检查点所在正文。两种选择都排除开场白、工具和推理；故事起点已展示的开场白另行提供。何时登记由检查点政策块规定。

${historyUseGuidance(locale)}`
        : `# Tools and response settlement

Use only attached tools. The main call chain may not call artifact_emit or artifact_clear; those tools are reserved for follow-up requests. Directories use @dir-* handles from the preload or tool results; do not list them again just to confirm a handle; documents and history use returned @handles. Results identify read scope, completeness and cursor; directory summaries are not document bodies. Complete injected bodies and exact reads obtain write authorization within their corresponding scopes; player-view annotations do not widen it. Initial world materials load once per fresh context. Later successful tool calls and receipts update current values and read scopes; do not re-read merely to confirm your own successful writes. A fresh context does not inherit an old conversation's read or write authorization.

YAML world_patch locators accept map keys and zero-based array indexes; add and replace are upserts that write whether or not the target exists, and an index past the end appends; remove deletes one exact location and is a no-op when it is absent. Each edit settles on its own: a failed edit is skipped and the others still apply, so when a receipt lists failed edits, send again only those. Omitted metadata remains unchanged. world_retire removes a document from catalog injection while keeping it readable, referenceable and restorable. Successful tool-response state changes and later final narrative commit separately; later failure does not roll back committed changes. Successful write receipts change current values; the actual receipt determines settlement, not model prose.

Responses containing tool calls are intermediate steps; their text has not yet been displayed or committed as final narrative. Tool results settle only those calls; subsequent steps remain in the same player submission. If further reads, adjudication or writes are needed, continue calling tools; do not repeat successful writes. When ready to finish, use the receipts to present this turn's still-unshown content in nonempty tool-free final prose consistent with committed state. Settlement does not expand the narrative scope. Runtime commits the final prose and ends the loop. world_checkpoint registers the history-replay boundary and suggests a fresh context from that point to the player; it takes effect after the subsequent nonempty tool-free final prose successfully commits, including that prose, and further tool calls may follow registration. Registration neither ends an in-world event nor switches context; the interface preselects a fresh context for the next send, and the player can cancel the preselection. A fresh context replays all committed player originals and final narratives after the boundary; nonempty replay replaces the frame's recent selection. When it is empty, the frame's recent declaration applies and may include the checkpoint narrative. Both selections exclude the opening, tools and reasoning; the already displayed opening is supplied separately at the story origin. The checkpoint policy block decides when to register.

${historyUseGuidance(locale)}`,
    },
    // Exclusive choice groups: the first member of each ships enabled.
    block("person-second", {
      category: "choice",
      group: "person",
      turnGuide: zh
        ? "以第二人称“你”称呼玩家角色；视角只跟随玩家角色。"
        : "Address the player character as “you”; the viewpoint follows only the player character.",
    }),
    block("person-first", {
      category: "choice",
      group: "person",
      turnGuide: zh
        ? "以第一人称“我”写玩家角色；只写“我”能感知到的。"
        : "Write the player character as “I”; write only what “I” can perceive.",
    }),
    block("person-third", {
      category: "choice",
      group: "person",
      turnGuide: zh
        ? "以第三人称写玩家角色，已知名字时用名字；直接引语保留说话者的人称。"
        : "Third person for the player character, by name when known; preserve the speaker's person in direct quotations.",
    }),
    block("continue-stage", {
      category: "choice",
      group: "continue",
      turnGuide: zh
        ? "本轮有新动作或台词时，在最终正文开头演出；同次已发起的两者都在首个世界回应前出现，不重演旧输入。"
        : "Stage newly initiated action and dialogue before the first world response in final prose; no replay of old input.",
    }),
    block("continue-advance", {
      category: "choice",
      group: "continue",
      turnGuide: zh
        ? "从行动的实际结果或回应起笔，不复述玩家的话；保留尝试与条件。"
        : "Start from the action's actual result or response; do not repeat the player's words; preserve attempts and conditions.",
    }),
    block("agency-default", {
      category: "choice",
      group: "agency",
      turnGuide: zh
        ? "可以补连带动作和寒暄；目标、立场、承诺、给予或接受、关系与风险的选择只能来自玩家原文。"
        : "Fill in supporting actions and small talk; goals, stance, promises, giving, accepting and risk choices are the player's.",
    }),
    block("agency-strict", {
      category: "choice",
      group: "agency",
      turnGuide: zh
        ? "只演玩家原文写出的动作和台词，连带动作也停在原文说到的地方；不替玩家补台词或做选择。"
        : "Perform only what the player's text states; supporting actions stop where the text stops; add no lines or choices.",
    }),
    block("agency-open", {
      category: "choice",
      group: "agency",
      turnGuide: zh
        ? "可以替玩家接普通对话、推进日常互动；承诺、给予、关系转折和风险选择仍交回玩家。"
        : "Carry small talk and routine interaction for the player; promises, giving, relationship turns and risks return to them.",
    }),
    block("stop-beat", {
      category: "choice",
      group: "stop",
      turnGuide: zh
        ? "呈现影响玩家接话的新反馈后停；可略过明确要求跳过的普通反馈，新增关键条件仍交回玩家。"
        : "Stop after feedback affecting replies; skip ordinary feedback if asked; return new key conditions to the player.",
    }),
    block("stop-scene", {
      category: "choice",
      group: "stop",
      turnGuide: zh
        ? "接住普通往来，推进到自然段落；在玩家保留的判断、回应或关键决定前停，换场景也停。"
        : "Carry ordinary exchanges to a natural pause; stop before reserved judgments, replies or key choices, or at a scene change.",
    }),
    // Independent policies: each rule lives in exactly one block.
    block("prose", { category: "policy" }),
    block("scene", { category: "policy" }),
    block("ending", {
      category: "policy",
      turnGuide: zh
        ? "结尾停在最后一句话、一个动作或一个环境变化上；不写“你打算怎么做”类交接，不列选项，不总结。"
        : "End on the last line, action or change in the surroundings; no “What do you do?” handoffs, no option lists, no summary.",
    }),
    block("output", {
      category: "policy",
      turnGuide: zh
        ? "只写小说正文，无标题、清单、幕后说明；“资料／搜索／句柄／Runtime”等内部词不进正文。"
        : "Only the novel's prose: no headings, lists or backstage notes; words like records, search, handle or Runtime stay out.",
    }),
    block("facts", {
      category: "policy",
      turnGuide: zh
        ? "尝试不自动成功，声称不自动成真，遵守裁决。已有材料明确写出角色曾收到某项交代，且这项交代影响眼下行动时，把玩家尚未读到的必要内容写进正文。其余场景按玩家当前行动自然推进。"
        : "Keep rulings; attempts and claims are no proof. If a prior instruction is established and matters now, tell what is new.",
    }),
    block("npc", { category: "policy" }),
    block("save-timing", {
      category: "policy",
      turnGuide: zh
        ? "玩家视图里的值若因本轮变化，先用工具写回再写最终正文。"
        : "If a player-view value changed this turn, write it back with a tool before the final prose.",
    }),
    block("ownership", { category: "policy" }),
    block("situation", { category: "policy" }),
    block("checkpoint-policy", { category: "policy" }),
    // Stackable styles ship disabled.
    ...Object.keys(host)
      .filter((path) => path.startsWith("blocks/style-"))
      .map((path) => {
        const style = path.slice("blocks/style-".length, -".md".length);
        const turnGuide = styleGuides[style];
        return block(`style-${style}`, {
          category: "style",
          ...(turnGuide === undefined ? {} : { turnGuide }),
        });
      }),
    {
      id: "play.tabletop",
      name: zh ? "跑团主持" : "Tabletop GM",
      body: tabletopPlayBody(locale),
      required: false,
      category: "policy",
      gameplay: "tabletop",
      turnGuide: zh
        ? "有成败不确定的行动先调用判定工具并完整兑现回执，再叙述。"
        : "For an action whose outcome is uncertain, call the resolution tool first and honor its receipt fully before narrating.",
    },
  ];
}

/** Ids of the builtins that ship enabled: each group's first member and every policy. */
export function defaultEnabledBuiltin(
  item: BuiltinPlayPrompt,
  catalog: readonly BuiltinPlayPrompt[],
): boolean {
  if (item.defaultEnabled !== undefined) return item.defaultEnabled;
  if (item.category === "style") return false;
  if (item.group === undefined) return true;
  return catalog.find((other) => other.group === item.group)?.id === item.id;
}

export function defaultOrderedPlayPrompts(): OrderedPlayPrompt[] {
  const catalog = builtinPlayPrompts("en");
  return catalog
    .map((item): OrderedPlayPrompt => ({
      id: item.id,
      kind: "builtin",
      builtin: item.id,
      enabled: defaultEnabledBuiltin(item, catalog),
    }))
    .concat([{ id: "world", kind: "world" }]);
}
