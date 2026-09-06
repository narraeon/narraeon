import type { AppLocale } from "../protocol/appPreferences.ts";

/**
 * Canonical author-owned guidance for AI-assisted setting improvement.
 *
 * The Runtime tool universe, schemas, per-call settlement, persistence and
 * current-tree settlement boundary deliberately do not live here. This text is an ordinary
 * portable preset asset: users may edit it without gaining authority over the
 * mechanical setting-improvement boundary.
 */
export const defaultSettingImprovementPromptPath =
  "prompts/setting-improvement.md";

export const defaultSettingImprovementPromptZhCN = `# 系统推荐的创作方法

以当前编辑目标、已有内容和用户目标为起点。讨论时说明必要判断，落实时定向修改；用户要求审查或重组时，相关结构与重复表达也在范围内。不为填满结构制造内容，无需修改也是合法结果。

## 编辑目标与世界起点

内容包设定完善定义开场结束处的世界起点，可以包含已有历史、当前状态、持续过程和各人的认知。简单起点足以开玩，普通未定义内容可在游玩中生长；不预写未来必然发生的经历或强制剧情阶段。

运行中世界修订维护当前已经演变的世界，按用户要求调整并保留未受影响的事实、经历与认知，不退回初始取值。此分支不读取或修改 opening.md。明确修订不是世界内事件，不需虚构行动解释它。

涉及结构、材料发现或更新位置时，先列出编辑目标根目录，完整读取 control/frame.yaml、启用的世界提示块、绑定的当前情境及受影响文档。实际操作遵守本轮工具边界。

## 世界信息怎样组织

世界文档承载事实与语义：当前值归自然所有者；持续过程记录实际进展与条件；意图、承诺、日程保留主体和已知条件，其目标尚未实现。角色声称、猜测与真实发生的事分开。人物的认知和态度属于各自主体，不随事实变化自动同步，也不互相对称；不代填玩家未表达的感情。

重要事件的经过集中承载，需要多人引用、持续追溯或重新解释时安排独立可引用的事件文档。事件记载当时的经过和结果；最新状态、待办与看法留在各自文档，用引用关联，事件不充当滚动状态表。对象保存当前结果，个人保存认知、关系评价与简短依据，引用相关事件而不各抄经过。已经形成的状态和态度也要保存，不能只存事件再让每次游玩重新推算。事件按事情组织，不按回合建档；普通细节可以只留在叙事。

这些区别适用于物品、伤病、地点、组织、交易、调查与人物关系，不要求固定目录、字段或数量。独立引用、自身状态或生命周期需要独立文档；小规模信息可集中在合适载体中。当前情境只承接眼前地点、在场者、进行中的事及待回应事项，不承担全部历史或未来分支。

summary 是目录简介：只写识别文档所需的简短身份、主题或稳定线索，不复述具体状态和事件经过。具体事实放在正文，仅在识别信息改变时更新标题与简介。

## 承载与发现一起安排

每项持续信息确定自然所有者、更新位置及实际的发现或注入路径。常用当前值按需全文或节点注入；较长事件通过目录和引用按需读取。重要事件应有实际可用的集中承载位置，不能只有无法创建的目录设想。查看真实 frame 和写后覆盖，不假定所有正文都已进入游玩请求。

同一时点、同一含义的事实尽量只维护一份；过去取值、当前结果和不同主体的理解不按重复删去。当前情境、叙事及界面只承担各自用途，避免重复强化同一概念。

world/ 或 state/ 承载虚构事实，control/ 安排本世界的取材、规则运用、保存位置与呈现，不复制当前值。未来游玩参考只代表实际启用的作者块；它不是本轮叙事要求，可选政策也未必始终启用。世界指令补充本世界特有约束，不重复通用规则或工具流程，不擅自改写世界外预设。

## 开场与整理

仅在内容包分支检查 opening.md：写玩家当时可感知的具体局面，保留尚待回答的请求与必要原话，不替玩家决定行动、台词或内心。独处、安静和等待也可形成开场。开场与文档停在同一时点，将约束首次行动的结果写给自然所有者，无需复制整篇叙事。

整理结束已完成或失效的进程、约定和限制，保留仍有意义的成果、后遗影响、经历与引用。补录、去重和归档不让事情再发生。长材料按需发现，软体积提示不授权截断；暂时离场不等于退役，退役也不会移除显式全文槽。

检查实际玩家视图选择器。容器会显示子树，隐藏认知不能混进公开节点；重组绑定结构时同步更新选择器。审计先对应概念、时间与主体，再处理重复句子；最后用实际写后覆盖检查发现路径，不默认输出整份内部审计表。
`;

export const defaultSettingImprovementPromptEn = `# Recommended authoring method

Start with the editing target, existing content and the user's goal. Discuss necessary judgments when asked to discuss; apply targeted changes when asked to implement. An audit or restructuring request includes relevant structure and duplicated expression. Do not invent content to fill a structure; no change needed is valid.

## Editing target and world starting point

Content-package setting improvement defines the world where the opening ends, including established history, current state, ongoing processes and individual knowledge. A simple starting point can be playable and ordinary undefined content can grow during play. Do not prewrite inevitable future experiences or mandatory plot stages.

Running-world revision maintains the world as it has evolved: apply requested changes while preserving unaffected facts, events and knowledge instead of resetting initial values. This branch does not read or modify opening.md. Explicit revision is not an in-world event and needs no invented action to explain it.

When structure, discovery or update locations are affected, list the editing target's root and completely read control/frame.yaml, enabled world instructions, the bound current situation and affected documents. Follow this request's actual tool boundary.

## Organizing world information

World documents carry facts and semantics. Current values belong to natural owners; ongoing processes retain actual progress and conditions; intentions, promises and schedules retain subjects and known conditions while their goals remain unrealized. Separate claims and guesses from what actually happened. Knowledge and attitudes belong to their holders, do not automatically follow world changes, and need not be mutual. Do not invent unexpressed player feelings.

Keep important event accounts in one place, using independently referenceable event documents for shared reference, continued retrieval or reinterpretation. Events record what happened and the outcomes at that time; latest states, pending work and views stay in their own documents, connected by references rather than copied into a rolling event-state table. Objects retain current outcomes; people retain knowledge, relationship appraisals and a brief basis, linking relevant events instead of copying their accounts. Persist formed states and attitudes too, rather than saving only events and asking each play request to infer everything again. Organize events by what happened, not by turn; ordinary details may remain narrative-only.

These distinctions apply to objects, injuries, places, organizations, trades, investigations and personal relationships without fixed directories, fields or counts. Independent reference, evolving state or lifecycle tracking warrants a separate document; smaller records may share a suitable home. The current situation holds the immediate location, people present, ongoing matters and unanswered requests, not all history or future branches.

summary is a catalog description: include only a brief identity, topic or stable clue needed to identify the document, not detailed state or event accounts. Concrete facts belong in the body. Update titles and descriptions only when identifying information changes.

## Arrange storage and discovery together

Give each durable fact a natural owner, update location and actual discovery or injection path. Inject frequently needed current values as bodies or nodes when appropriate; retrieve longer event accounts through catalogs and references. Important events need a usable central home, not merely an imagined directory that play cannot create. Check the real frame and post-write coverage instead of assuming every body enters play requests.

Prefer one maintained home for facts with the same meaning at the same time. Past values, current outcomes and different subjects' interpretations are not duplicates. Let the current situation, prose and interface serve their own purposes without repeatedly overweighting one concept.

world/ or state/ carries fictional facts. control/ arranges world-specific material selection, rule use, save locations and presentation without copying current values. Future-play reference reflects only enabled author blocks: it is not this request's narrative instruction, and optional policies may not stay enabled. World instructions add world-specific constraints without repeating general rules or tool procedures or rewriting an external preset.

## Opening and consolidation

Inspect opening.md only in the content-package branch. Show a concrete situation the player can perceive, retaining unanswered requests and consequential wording without choosing player action, speech or inner thoughts. Solitude, quiet and waiting can also open a story. Documents and opening stop at the same moment; give outcomes constraining the first action to natural owners without copying the whole narrative.

Consolidation closes completed or expired processes, commitments and restrictions while retaining meaningful results, lasting effects, events and references. Recording, deduplication and archiving do not perform events again. Keep long material discoverable on demand; advisory size limits do not authorize truncation. Temporary absence is not retirement, and retirement does not remove explicit full-document slots.

Check actual player-view selectors. Containers display subtrees, so hidden knowledge must not enter public nodes. Update selectors with any restructuring of bound content. Audit concepts, time and subjects before removing repeated sentences; finish by checking discovery against real post-write coverage without printing a full internal audit by default.
`;

export const defaultSettingImprovementPrompt =
  defaultSettingImprovementPromptEn;

export function defaultSettingImprovementPromptForLocale(
  locale: AppLocale,
): string {
  return locale === "zh-CN"
    ? defaultSettingImprovementPromptZhCN
    : defaultSettingImprovementPromptEn;
}
