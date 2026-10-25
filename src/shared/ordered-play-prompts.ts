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
        intimate:
          "把这一刻拆开写，触觉先于视觉；对方是否接受由他的性格和处境决定。",
        noir: "短句，只写看得见的动作和物件，不替角色下判断。",
        wuxia: "用语偏文，不用现代词汇；交手写清出手与应对。",
        horror: "恐惧来自不确定；不替玩家判断危险程度，也不给安全保证。",
        action: "写清谁在哪、朝哪动、打到没打到、代价是什么；伤势和体力累积。",
        literary: "说七分留三分，情绪不直接命名，但结果事实写清楚。",
      }
    : {
        intimate:
          "Unfold the moment; touch before sight; whether they accept follows their character and situation.",
        noir: "Short sentences; only observable actions and objects; no judging for characters.",
        wuxia:
          "Period diction, no modern vocabulary; make each exchange of blows legible.",
        horror:
          "Fear comes from uncertainty; do not rate the danger for the player or promise safety.",
        action:
          "Make clear who is where, which way they move, what lands and what it costs; wounds and fatigue accumulate.",
        literary:
          "Say seven parts and leave three; do not name the emotion, but state outcomes clearly.",
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

只可调用请求随附的工具。目录使用预加载索引或工具返回的 @dir-*，无需重复列目录确认；文档和历史使用返回的 @句柄。工具结果标明读取范围、完整性及 cursor；目录摘要不等于正文。材料覆盖中完整正文与精确读取取得对应范围的写入资格，界面绑定标注不扩大写入资格。初始世界材料只在全新上下文加载一次；后续成功工具调用与回执更新当前值和读取资格，不必重读自己刚成功写入的内容。全新上下文不继承旧对话的读取与写入资格。

world_patch 的 YAML locator 可以包含 map key 和从零开始的数组下标；remove 删除一个精确位置。未提供的元数据保持原值。world_retire 从目录注入中退役文档，文档仍可读取、引用和恢复。工具响应的成功状态变化与后续最终叙事分别提交，后续失败不回滚已提交变化。成功写入回执表示当前值已改变；以真实回执的结算状态为准，模型文字不能提交世界。

包含工具调用的响应属于中间步，其中的文字尚未展示或提交为最终叙事。收到全部工具结果后，根据回执在最终正文中呈现本轮尚未展示的内容，并与已提交状态一致；没有工具调用的非空正文结束本次循环并由 Runtime 提交。world_checkpoint 登记历史重放边界并向玩家建议从此开始全新上下文；在随后非空且无工具调用的最终正文成功提交后生效，边界包含该正文；登记后仍可继续工具调用。登记不结束世界内事件，也不自动切换上下文，玩家自行选择。全新上下文补入边界后的已提交玩家原文与最终叙事，排除开场白、工具和推理。何时登记由检查点政策块规定。

${historyUseGuidance(locale)}`
        : `# Tools and response settlement

Use only attached tools. Directories use @dir-* handles from the preload or tool results; do not list them again just to confirm a handle; documents and history use returned @handles. Results identify read scope, completeness and cursor; directory summaries are not document bodies. Complete injected bodies and exact reads obtain write authorization within their corresponding scopes; player-view annotations do not widen it. Initial world materials load once per fresh context. Later successful tool calls and receipts update current values and read scopes; do not re-read merely to confirm your own successful writes. A fresh context does not inherit an old conversation's read or write authorization.

YAML world_patch locators accept map keys and zero-based array indexes; remove deletes one exact location. Omitted metadata remains unchanged. world_retire removes a document from catalog injection while keeping it readable, referenceable and restorable. Successful tool-response state changes and later final narrative commit separately; later failure does not roll back committed changes. Successful write receipts change current values; the actual receipt determines settlement, not model prose.

Responses containing tool calls are intermediate steps; their text has not yet been displayed or committed as final narrative. After all tool results, use the receipts to present this turn's still-unshown content in final prose consistent with committed state. A nonempty tool-free response ends this loop and Runtime commits it. world_checkpoint registers the history-replay boundary and suggests a fresh context from that point to the player; it takes effect after the subsequent nonempty tool-free final prose successfully commits, including that prose, and further tool calls may follow registration. Registration neither ends an in-world event nor switches context, which the player chooses. Fresh-context replay contains committed player originals and final narratives after the boundary, excluding the opening, tools and reasoning. The checkpoint policy block decides when to register.

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
        ? "以第三人称写玩家角色，已知名字时用名字；玩家原文里的“我”“你”转为第三人称。"
        : "Third person for the player character, by name when known; “I” and “you” in the player's text become third person.",
    }),
    block("continue-stage", {
      category: "choice",
      group: "continue",
      turnGuide: zh
        ? "先把玩家这次的行动和台词演成叙事，再写世界的反应；上一轮已经演过的不重述。"
        : "Stage the player's action and dialogue as narrative first, then the world's reaction; never restate earlier turns.",
    }),
    block("continue-advance", {
      category: "choice",
      group: "continue",
      turnGuide: zh
        ? "玩家原文已经是正文，从它之后的第一件事写起，不复述玩家的话。"
        : "The player's text is already prose: start from the first thing after it and do not repeat the player's words.",
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
        ? "对方给出会影响玩家接话的新反馈就停下，即使不是重大决定。"
        : "Stop as soon as the other person's feedback could change how the player replies, even without a consequential decision.",
    }),
    block("stop-scene", {
      category: "choice",
      group: "stop",
      turnGuide: zh
        ? "推进到当前场景的自然段落再停；只在归玩家的决定或换场景时停。"
        : "Carry the scene to its natural pause; stop only at a decision that belongs to the player or at a scene change.",
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
        ? "尝试不自动成功，声称不自动成真；正文不改变已裁决的结果。"
        : "Attempts do not automatically succeed and claims are not automatically true; prose never changes an adjudicated result.",
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
