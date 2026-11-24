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
  /** Concise authoring-facing boundary summary used inside author.play-reference. */
  authorSummary?: string;
  required: boolean;
  /** Explicit app default; omitted catalogs use their category/group convention. */
  defaultEnabled?: boolean;
  category: PromptCategory;
  dynamic?: "model-prompt";
  group?: PromptGroup;
  /** The default line this block contributes to the per-send turn guide. */
  turnGuide?: string;
  /** Tabletop-scoped builtins are skipped for interactive fiction. */
  gameplay?: PromptGameplayScope;
}

export function modelPromptBuiltin(
  surface: "play" | "author",
  locale: AppLocale,
): BuiltinPlayPrompt {
  return {
    id: surface + ".model-prompt",
    name: locale === "zh-CN" ? "模型提示词" : "Model prompt",
    body: "",
    required: false,
    category: "policy",
    dynamic: "model-prompt",
  };
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
          "Imply emotion, make outcomes clear, and let imagery reflect the time that has actually passed.",
      };
  const styleSummaries: Record<string, string> = zh
    ? {
        intimate:
          "附加情感与亲密文风：放慢当下瞬间并写清距离、边界与已有具体触感；不预设心跳脸红，对方是否接受仍由性格与处境决定。",
        noir: "附加冷硬推理文风：短句克制，只写可感知的动作、物件与声音，不替角色下判断；区分可观察细节、已确立证据与推测。",
        wuxia:
          "附加武侠古风文风：偏文而避现代词汇，称谓分寸合乎身份；交手写清出手应对与事实代价，景短托气。",
        horror:
          "附加悬疑恐怖文风：以不确定感与受限视角营造张力，写生理感官与声音质感，不替玩家定级危险、不给安全保证，也不凭空编造不存在的威胁。",
        action:
          "附加动作战斗文风：按顺序写清位置、起手、应对与结果，交手短句、间隙放长；利用具体环境，伤势与体力严格按世界事实累积。",
        literary:
          "附加克制留白文风：情绪借具体动作与小事暗示而不直呼其名，对话留表里层与余味；留白不模糊交易、伤势、承诺等结果事实，意象合乎实际经过的时间。",
      }
    : {
        intimate:
          "Adds intimate style: slows down key moments with concrete distance, boundaries, and established sensation without presupposing reactions; NPC acceptance still follows character and situation.",
        noir: "Adds noir/detective style: terse, restrained sentences grounded in perceptible actions, objects, and sounds without judging for characters; distinguishes details, evidence, and inference.",
        wuxia:
          "Adds wuxia/period style: period diction free of modern idioms, status-appropriate address, legible exchanges grounded in world facts, and brief atmospheric scenery.",
        horror:
          "Adds horror/suspense style: builds tension from uncertainty, limited sightlines, physical sensations, and sound without rating danger, promising safety, or inventing nonexistent threats.",
        action:
          "Adds action/combat style: tracks positions, sequence, outcomes, and environment clearly with varied sentence pacing; accumulates wounds and fatigue strictly from world facts.",
        literary:
          "Adds restrained literary style: conveys emotion through concrete actions, details, and subtext while keeping outcomes (deals, wounds, promises) unambiguous and imagery true to elapsed time.",
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

只可调用请求随附的工具，先使用已有材料，只在缺少必要证据或写入授权时读取。主调用链不能调用 artifact_emit 或 artifact_clear；这两个工具仅供后置请求使用。目录使用预加载索引或工具返回的 @dir-*；文档和历史使用返回的 @句柄。工具结果标明读取范围、完整性及 cursor；目录摘要不等于正文。材料覆盖中完整正文与精确读取取得对应范围的写入资格，界面绑定标注不扩大写入资格。初始世界材料只在全新上下文加载一次；后续成功工具调用与回执更新当前值和读取资格。全新上下文不继承旧对话的读取与写入资格。

工具响应的成功状态变化与后续最终叙事分别提交，后续失败不回滚已提交变化。以真实回执的结算状态为准，模型文字不能提交世界。

包含工具调用的响应属于中间步，其中的文字尚未展示或提交为最终叙事；后续仍属同一次玩家提交，可继续调用工具但勿重复已成功写入。结束时根据成功回执，用非空且无工具调用的最终正文呈现本轮尚未展示的内容并与已提交状态一致；工具结算不扩大叙事范围。Runtime 提交最终正文并结束循环。world_checkpoint 登记历史重放边界并向玩家建议从此开始全新上下文；在随后非空且无工具调用的最终正文成功提交后生效，边界包含该正文；登记后仍可继续工具调用。登记不结束世界内事件，也不自动切换上下文；界面预选下一次全新上下文，玩家可以取消预选。全新上下文完整补入边界后的已提交玩家原文与最终叙事，非空时替代 frame 的 recent；为空时沿用 frame 的 recent 声明，可以带入检查点所在正文。两种选择都排除开场白、工具和推理；故事起点已展示的开场白另行提供。何时登记由检查点政策块规定。

${historyUseGuidance(locale)}`
        : `# Tools and response settlement

Use only attached tools, using available material first and reading only for missing evidence or required write authorization. The main call chain may not call artifact_emit or artifact_clear; those tools are reserved for follow-up requests. Directories use @dir-* handles from the preload or tool results; documents and history use returned @handles. Results identify read scope, completeness and cursor; directory summaries are not document bodies. Complete injected bodies and exact reads obtain write authorization within their corresponding scopes; player-view annotations do not widen it. Initial world materials load once per fresh context. Later successful tool calls and receipts update current values and read scopes. A fresh context does not inherit an old conversation's read or write authorization.

Successful tool state changes and later final narrative commit separately; later failure does not roll back committed changes. Actual receipts determine settlement, not model prose.

Responses containing tool calls are intermediate steps whose text is neither displayed nor committed as final narrative; subsequent steps remain in the same player submission, and you may keep calling tools without repeating succeeded writes. To finish, use the receipts to present this turn's still-unshown content in nonempty tool-free final prose consistent with committed state; settlement does not expand narrative scope. Runtime commits the final prose and ends the loop. world_checkpoint registers the history-replay boundary and suggests a fresh context from that point to the player; it takes effect after the subsequent nonempty tool-free final prose successfully commits, including that prose, and further tool calls may follow registration. Registration neither ends an in-world event nor switches context; the interface preselects a fresh context for the next send, and the player can cancel the preselection. A fresh context replays all committed player originals and final narratives after the boundary; nonempty replay replaces the frame's recent selection. When it is empty, the frame's recent declaration applies and may include the checkpoint narrative. Both selections exclude the opening, tools and reasoning; the already displayed opening is supplied separately at the story origin. The checkpoint policy block decides when to register.

${historyUseGuidance(locale)}`,
    },
    // Exclusive choice groups: the first member of each ships enabled.
    modelPromptBuiltin("play", locale),
    block("person-second", {
      category: "choice",
      group: "person",
      authorSummary: zh
        ? "第二人称“你”叙事，视角仅跟随玩家角色，直接引语保留说话者人称；无需在世界控制块重复人称规则。"
        : "Narrates the player character in second person (“you”) from their viewpoint only, keeping speakers' person in direct quotes; do not repeat person rules in control blocks.",
      turnGuide: zh
        ? "以第二人称“你”称呼玩家角色；视角只跟随玩家角色。"
        : "Address the player character as “you”; the viewpoint follows only the player character.",
    }),
    block("person-first", {
      category: "choice",
      group: "person",
      authorSummary: zh
        ? "第一人称“我”叙事，只写“我”可感知内容并贴合已建性格，不替主角表态；无需在控制块重复人称规则。"
        : "Narrates the player character in first person (“I”), limited to what “I” perceives without deciding their stance; do not repeat person rules in control blocks.",
      turnGuide: zh
        ? "以第一人称“我”写玩家角色；只写“我”能感知到的。"
        : "Write the player character as “I”; write only what “I” can perceive.",
    }),
    block("person-third", {
      category: "choice",
      group: "person",
      authorSummary: zh
        ? "第三人称写玩家角色（已知用名字，否则用对应“他／她”），视角仍跟随玩家角色；无需在控制块重复人称规则。"
        : "Narrates the player character in third person (by name when known) while keeping their viewpoint; do not repeat person rules in control blocks.",
      turnGuide: zh
        ? "以第三人称写玩家角色，已知名字时用名字；直接引语保留说话者的人称。"
        : "Third person for the player character, by name when known; preserve the speaker's person in direct quotations.",
    }),
    block("continue-stage", {
      category: "choice",
      group: "continue",
      authorSummary: zh
        ? "本轮新动作或台词先于首个世界回应演出（同次两者都给时均先演），不重演旧输入；条件未成立的后续按尝试处理。"
        : "Stages this turn's new player action or dialogue before the first world response (staging both when given) without replaying old input; unverified follow-through stays an attempt.",
      turnGuide: zh
        ? "本轮有新动作或台词时，在最终正文开头演出；同次已发起的两者都在首个世界回应前出现，不重演旧输入。"
        : "Stage new action or dialogue first; if both are given, stage both before the first world response. Skip old input.",
    }),
    block("continue-advance", {
      category: "choice",
      group: "continue",
      authorSummary: zh
        ? "不复述玩家动作与台词，直接从实际结果或回应起笔，仅在简写输入需要落场时补最短衔接并保留尝试条件。"
        : "Starts directly from the outcome or world response without restating player prose, adding only minimal transition when needed while keeping attempts unconfirmed.",
      turnGuide: zh
        ? "从行动的实际结果或回应起笔，不复述玩家的话；保留尝试与条件。"
        : "Start from the action's actual result or response; do not repeat the player's words; preserve attempts and conditions.",
    }),
    block("agency-default", {
      category: "choice",
      group: "agency",
      authorSummary: zh
        ? "可补普通连带动作与寒暄，但目标、立场、承诺、给予／接受、关系与风险选择必须来自玩家原文；感官不代立态度或感情。"
        : "May fill in routine steps and greetings, but goals, stance, promises, giving/accepting, ties, and risks require explicit player input; sensations do not establish feelings or choices.",
      turnGuide: zh
        ? "可以补连带动作和寒暄；目标、立场、承诺、给予或接受、关系与风险的选择只能来自玩家原文。"
        : "Fill in minor steps and greetings. Players choose goals, stance, promises, what to give or accept, ties and risks.",
    }),
    block("agency-strict", {
      category: "choice",
      group: "agency",
      authorSummary: zh
        ? "严格只演玩家原文明确写出的动作和台词，连带动作也停在原文边界，不补寒暄、台词或选择；不替玩家生成未表达感情。"
        : "Performs only actions and lines stated by the player, stopping even supporting steps at the player's text with no added lines, choices, or unexpressed feelings.",
      turnGuide: zh
        ? "只演玩家原文写出的动作和台词，连带动作也停在原文说到的地方；不替玩家补台词或做选择。"
        : "Perform only what the player's text states; supporting actions stop where the text stops; add no lines or choices.",
    }),
    block("agency-open", {
      category: "choice",
      group: "agency",
      authorSummary: zh
        ? "可替玩家接普通对话与日常互动（贴合既有性格与立场），但承诺、给予／接受、关系转折与风险选择仍交回玩家。"
        : "May handle routine dialogue and everyday interaction consistent with established character and stance, while promises, giving/accepting, relationship turns, and risks return to the player.",
      turnGuide: zh
        ? "可以替玩家接普通对话、推进日常互动；承诺、给予、关系转折和风险选择仍交回玩家。"
        : "Carry small talk and routine interaction for the player; promises, giving, relationship turns and risks return to them.",
    }),
    block("stop-beat", {
      category: "choice",
      group: "stop",
      authorSummary: zh
        ? "持续活动中出现影响玩家接话、调整或继续的新反馈即停；可按玩家明确要求快进普通过程，但遇新关键条件仍交回玩家。"
        : "Stops on new feedback that affects how the player replies or adjusts; allows requested fast-forwards through ordinary steps while stopping for new key conditions.",
      turnGuide: zh
        ? "呈现影响玩家接话的新反馈后停；可略过明确要求跳过的普通反馈，新增关键条件仍交回玩家。"
        : "Stop after feedback affecting replies; skip ordinary feedback if asked; return new key conditions to the player.",
    }),
    block("stop-scene", {
      category: "choice",
      group: "stop",
      authorSummary: zh
        ? "可接住普通往来推进到当前场景的自然段落；遇到玩家保留的回应／判断、归属玩家的决定或场景转换即停。"
        : "Carries routine exchanges to a natural pause in the current scene, stopping for a reserved reply or judgment, a player-owned decision, or a scene change.",
      turnGuide: zh
        ? "接住普通往来，推进到自然段落；在玩家保留的判断、回应或关键决定前停，换场景也停。"
        : "Carry routine exchanges to a natural pause. Stop for a reserved reply, judgment or key decision, or on a scene change.",
    }),
    // Independent policies: each rule lives in exactly one block.
    block("prose", {
      category: "policy",
      authorSummary: zh
        ? "以小说质感推进，篇幅随当下分量调节并跟随玩家重心；环境与动作服务于信息和节奏，不为凑字注水。设定文档无需仿写叙事腔调。"
        : "Writes with novelistic pacing scaled to the moment and the player's current focus without filler; setting documents should not imitate narrative prose style.",
    }),
    block("scene", {
      category: "policy",
      authorSummary: zh
        ? "通过正在进行的事呈现场面，不逐个点名在场者或每人轮流给动作；已知姓名自然直呼。"
        : "Shows scenes through ongoing action rather than rolling call or giving every bystander a gesture each turn; uses known names naturally.",
    }),
    block("ending", {
      category: "policy",
      authorSummary: zh
        ? "结尾停在最后一句台词、动作或环境变化，不附“你打算怎么做”式交接、选项清单或局势总结。"
        : "Ends on the final line, action, or environmental shift without “What do you do?” handoffs, option lists, or recaps.",
      turnGuide: zh
        ? "结尾停在最后一句话、一个动作或一个环境变化上；不写“你打算怎么做”类交接，不列选项，不总结。"
        : "End on the last line, action or change in the surroundings; no “What do you do?” handoffs, no option lists, no summary.",
    }),
    block("output", {
      category: "policy",
      authorSummary: zh
        ? "世界内回复只输出故事正文，禁止标题、清单、幕后说明及工具／句柄／检索等内部词；纯世界外查询或维护时简洁直答且不推进剧情。"
        : "Outputs story prose only in-world (no headings, lists, backstage notes, or tool/handle/search terms); answers out-of-world queries or maintenance concisely without advancing play.",
      turnGuide: zh
        ? "世界内叙事只写故事正文，无标题、清单、幕后说明；“资料／搜索／句柄／Runtime”等内部词不进正文。"
        : "Use only story prose in-world: no headings, lists or backstage notes; keep records, search, handle and Runtime out.",
    }),
    block("facts", {
      category: "policy",
      authorSummary: zh
        ? "按已加载材料与工具精确取材裁决，区分事实、角色声称与尝试；角色已知且影响眼下行动的未读前提须在可见正文说清，未披露秘密仍留待发现；允许在既定约束下自然生长未定义细节。"
        : "Adjudicates from loaded materials and exact tool reads, separating facts, character claims, and attempts; states character-known premises needed now if unread while keeping secrets discoverable and allowing constrained undefined details to grow.",
      turnGuide: zh
        ? "尝试不自动成功，声称不自动成真，遵守裁决。已有材料明确写出的角色已知前提影响眼下行动而玩家未读到时，写进正文。"
        : "Keep rulings; attempts and claims are no proof. State established character-known premises needed now if still unread.",
    }),
    block("npc", {
      category: "policy",
      authorSummary: zh
        ? "NPC 按自身性格、认知、处境与日程自主行动；不在场角色在换地点、时间推进或相关时点按需核查场外进展。"
        : "NPCs act autonomously from their character, knowledge, situation, and schedules; off-screen progress is checked when location, time, or scheduled milestones make it relevant.",
    }),
    block("save-timing", {
      category: "policy",
      authorSummary: zh
        ? "玩家视图绑定值变化、采用顶层 `背景` 节点时的定位值变化以及原文未记录的隐蔽进展须在本轮终态叙事前写回，其余持续结果可择机归并；当前明确修订优先于旧叙事。无需在控制块重复保存时机。"
        : "Writes changed player-view bindings, locator changes on the exact top-level `背景` field (when adopted), and unrecorded off-screen/hidden outcomes before final prose, consolidating other durable outcomes later; explicit revisions override old prose. Do not repeat save-timing rules in control blocks.",
      turnGuide: zh
        ? "玩家视图里的值若因本轮变化，先用工具写回再写最终正文。"
        : "If a player-view value changed this turn, write it back with a tool before the final prose.",
    }),
    block("ownership", {
      category: "policy",
      authorSummary: zh
        ? "当前事实归自然所有者，认知／态度归各自主体，写入玩家角色的感情时只记录玩家已表达的内容；重要事件集中保存并以引用关联（事件不作滚动状态表）；summary 只作简短目录识别，不复述具体状态或经过。"
        : "Stores current facts on natural owners, knowledge/attitudes on their holders (recording only player-expressed feelings for the player character), and major events centrally by reference (not as rolling state tables); keeps summary as a brief catalog identifier rather than a state or event recap.",
    }),
    block("situation", {
      category: "policy",
      authorSummary: zh
        ? "当前情境只保留叙事结束时的地点、在场者、进行中事件及直接约束下一步的少量待回应事项，不写成过程摘要或未来分支；公开视图容器不得混入隐藏认知。"
        : "Keeps current situation limited to ending location, present characters, ongoing activity, and immediate pending items rather than summaries or branches; never mixes hidden knowledge into public player-view containers.",
    }),
    block("checkpoint-policy", {
      category: "policy",
      authorSummary: zh
        ? "仅在前一事件已结束、进入事件间隙且已保存后续所需结果后才登记 world_checkpoint，不为登记压缩过程或中断持续活动；玩家明确要求在此收尾时照办。"
        : "Registers world_checkpoint only after the previous event has ended and entered an event gap with durable outcomes saved, never compressing ongoing activities to reach a gap; honors explicit player wrap-up requests.",
    }),
    // Stackable styles ship disabled.
    ...Object.keys(host)
      .filter((path) => path.startsWith("blocks/style-"))
      .map((path) => {
        const style = path.slice("blocks/style-".length, -".md".length);
        const turnGuide = styleGuides[style];
        const authorSummary = styleSummaries[style];
        return block(`style-${style}`, {
          category: "style",
          ...(authorSummary === undefined ? {} : { authorSummary }),
          ...(turnGuide === undefined ? {} : { turnGuide }),
        });
      }),
    {
      id: "play.tabletop",
      name: zh ? "跑团主持" : "Tabletop GM",
      body: tabletopPlayBody(locale),
      authorSummary: zh
        ? "跑团主持边界：仅在成败不确定且有意义后果时先调当前方案判定工具并完整兑现回执，不重掷；已有材料足够时直接使用，缺少判定依据时再读取相关人物或状态，不要在世界指令中重复通用判定流程。"
        : "Tabletop GM boundary: invokes the active resolution tool only for uncertain, consequential actions and honors its receipt fully without rerolls; uses loaded materials when sufficient and reads relevant character or state documents when check inputs are missing; do not duplicate generic resolution procedures in world instructions.",
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
