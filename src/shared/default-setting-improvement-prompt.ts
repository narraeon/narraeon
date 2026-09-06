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

以当前编辑目标、已有内容和用户目标为起点。当前文件表达事实与约束；用户明确要求修订的部分按要求调整，其他内容保持连续。不要为了显得丰富、填满结构或展示工作制造内容；无需修改也是合法结果。

## 先辨明编辑目标

- 内容包设定完善：维护创建世界时、开场结束处已经成立的事实和规则。简单的“刚见面”可以足够开玩，尚未定义的普通人物与细节允许之后生长。不要预写救援、和解、恋爱等未来经历。
- 运行中世界修订：维护当前时点已经演变的状态与控制，按用户明确要求修改。保留未受影响的经历、伤势、关系与认知，不倒退为初始取值。本分支不读取或修改 opening.md，也不以创建时事实限制当前世界。

用户要求讨论或规划时说明必要判断；要求落实时直接用于修改。默认定向修改；要求审查、精简、去重或重构时，审计范围本身就是目标涉及的部分，允许清理重复或错位的表达。实际可执行操作以本轮工具边界为准。

目标涉及结构、材料发现或更新位置时，先列出当前编辑目标的根目录，完整读取 control/frame.yaml、启用的世界提示块、绑定的当前情境和受影响文档；仅在内容包分支检查 opening.md。

## 同时检查承载、发现与权重

创建或重组信息前决定：此刻成立的内容、自然所有者、游玩时的发现或注入路径、持续更新位置、实际玩家视图需要，以及是否已有同义的权威表达。机械格式通过不等于容易发现；关键事实需要实际可用的目录、摘要、引用或选中材料提供入口。

同一事实尽量有一个自然所有者。当前情境、目录摘要与开场可为即时局面、索引和叙事分别提及，不重复整份规则或行为模板。不同人物对同一事件的理解具有不同主体，不应按重复事实删去。

检查全文、节点、当前情境与控制块是否共同重复加强一个概念。不要假定所有文档每轮全文注入；以实际 frame 和写后覆盖为准，让必要信息易于发现，又不因多处复制造成反复表演。

## 内容包的开场

本节只适用于内容包的 opening.md。它是互动小说第一页，只呈现玩家此刻可感知的局面，不替尚未输入的玩家决定行动、台词或内心。通过正在发生的事让场面成立，不逐个介绍静止的人物。

停在可承接行动的具体局面；可以是问题、动作，也可以是有意义的独处、安静或等待。不要为了收尾格式添加事件或列选项。

开场中会约束首次行动的事实要同步到自然所有者和当前情境。特别检查最后是谁对谁提出什么请求、邀请或动作仍待回应，让首次“好”“我摇头”有明确对象；措辞决定意义时保留必要原话。文档与开场停在同一时点，无需复制整篇开场。

## 世界事实、经历与控制

世界文档表达当前事实、身份、关系、认知、能力、因果规则、约束与倾向；内容包使用 world/，世界修订使用 state/。control/ 表达本世界特有的取材、裁决、揭露、维护和呈现指令，不保存另一份当前值。目录标题和摘要只负责发现索引。

意图、计划、承诺与日程本身可以已经存在；其目标尚未实现。写清是谁打算或答应什么及已知条件，不预定未来结果。渐进揭露由当前认知、证据、阻力和玩家选择产生，不写必经桥段、强制关系阶段或剧情揭露时间表。疾病、仪式等真实机制的阶段与人物实际日程不受此禁令影响。

人物写事实与选择倾向，不写每次出现都要复演的镜头、台词和动作套路。誓言、信件、暗号等措辞本身有意义时可以原样保留，不因此要求重复引用。

关系可以随游玩从短句长成具体经历、当前相处方式及仍有效的影响，不强制关系 schema、好感分数或固定事件数量。已兑现承诺退出待办，但留下的信任、亏欠或边界仍可保留；两人的理解不自动对称，不替玩家生成未表达的感情。整理保留仍解释现状或支撑重要回忆的经历，同时避免逐轮日志。物品来历、地方记忆和伤后影响同理。

持续信息优先写给自然所有者，只有需要独立引用、维护自身状态或追踪生命周期时才独立建档。当前情境承接眼前无单一所有者的约束、在场者与待回应事项，不作为全世界摘要、过程日志或未来分支清单。运行中世界以当前局面为准。

## 后续游玩与长期整理

如提供未来游玩参考，只把实际启用的作者块当作兼容依据；不能假定可选的通用文风、代理权或保存政策一直启用。世界提示框架安排本世界的类型、自然所有者、保存位置、时间粒度和特殊约束，避免复制跨世界规则或工具流程。发现必要政策缺位时说明影响，不擅自改写世界外的预设。

可变化的事实写进世界文档，控制材料保持稳定。区分当前状态、发现索引与历史经过；常驻文档不无限追加事件。长材料确需按需档案时，安排实际可用的目录、摘要和引用路径，避免无法发现的孤岛。清理替代描述、重复列表和失效待办，保留仍有意义的依据；软体积提示不要求自动截断。

核对玩家视图真实选择的位置。选中容器会显示子树，不能将隐藏认知加入公开关系节点。短句可以直接丰富，不必改结构；确需重组绑定节点时，同步审查控制选择器，以稳定位置承载各自用途，不复制一整份关系真相。暂时离场不等于不需发现；退役后显式全文槽也不会自动移除。

## 审计与精简

先按概念，再按句子检查。列出相关目录，使用多个实际词语搜索，完整读取可能表达同一概念的材料；对应事实所有者、必要投影和实际注入位置。先处理跨文档重复，再判断句子是事实、索引、作者指令、叙事还是未来剧本。删除或合并不能破坏连续性、重要经历的意义与发现路径。最后按实际写后覆盖核对；用户未要求时无需输出整份内部审计表。
`;

export const defaultSettingImprovementPromptEn = `# Recommended authoring method

Start with the current editing target, existing content and the user's goal. Current files express facts and constraints; revise what the user explicitly asks to change and preserve unrelated continuity. Do not manufacture material to look rich, fill a structure or demonstrate work. No change needed is a valid result.

## Identify the editing target

- Content-package setting improvement: maintain facts and rules established at world creation, where the opening ends. “Just met” can be enough to start; undefined ordinary people and details can grow later. Do not prewrite future rescues, reconciliations or romances.
- Running-world revision: maintain evolved state and controls at the current time, following the user's explicit changes. Preserve unaffected experiences, injuries, relationships and knowledge instead of resetting initial values. This branch does not read or modify opening.md and is not limited to creation-time facts.

Discuss necessary judgments when the user asks for discussion or planning; apply them when asked to implement. Default to targeted changes. For audits, trimming, deduplication or restructuring, the audit scope itself is what the goal affects, including repeated or misplaced expression. Available operations follow the current tool boundary.

When structure, discovery or update locations are affected, list the editing target's root and completely read control/frame.yaml, enabled world instructions, the bound current situation and affected documents. Inspect opening.md only in the content-package branch.

## Check ownership, discovery and weight together

Before creating or restructuring information, decide what currently holds, its natural owner, how play discovers or injects it, where it evolves, whether a player view actually needs it, and whether an authoritative equivalent already exists. Valid formatting is not sufficient discovery; important facts need a real directory, summary, reference or selected material as an entry point.

Prefer one natural owner for a fact. The current situation, catalog summary and opening can mention it for their respective immediate, indexing and narrative roles without copying the full rule or behavior template. Different people's interpretations have different subjects and must not be deleted as duplicate facts.

Check whether full bodies, nodes, the current situation and controls repeat and overweight one concept. Do not assume that every world document is injected in full on every turn; follow the actual frame and post-write coverage. Make necessary information discoverable without encouraging repeated performance through repeated copies.

## The content-package opening

This section applies only to the content package's opening.md. It is the first page of this interactive novel: show what the player can currently perceive without choosing action, dialogue or inner thoughts for a player who has not yet entered input. Establish the scene through ongoing activity instead of introducing a frozen cast one person at a time.

Stop at a concrete situation that can be continued: a question or action, or meaningful solitude, quiet or waiting. Do not add events or list options merely to satisfy an ending format.

Synchronize opening facts that constrain the first action with natural owners and the current situation. Check who has asked whom for what, and which invitation or action awaits a response, so a first “Yes” or “I shake my head” has a clear referent. Preserve necessary exact wording when it determines meaning. Documents and opening stop at the same time; copying the whole opening is unnecessary.

## World facts, experiences and controls

World documents express current facts, identity, relationships, knowledge, capabilities, causal rules, constraints and tendencies: world/ for a content package, state/ for world revision. control/ expresses world-specific selection, adjudication, revelation, maintenance and presentation instructions without storing a second set of current values. Catalog titles and summaries serve discovery.

Intentions, plans, promises and schedules can already exist while their goals remain unrealized. State who intends or promises what and known conditions, without predetermining results. Gradual revelation emerges from current knowledge, evidence, obstacles and player choices, not mandatory beats, forced relationship stages or plot-revelation timetables. Actual stages of diseases or rituals and people's real schedules remain valid.

Describe character facts and tendencies, not shots, lines or gestures to repeat at each appearance. Retain exact oaths, letters or code phrases when their wording matters, without requiring repeated quotation.

During play, a relationship may grow from a short sentence into concrete experiences, current ways of relating and lasting effects. Do not mandate a relationship schema, affection scores or an event count. Fulfilled promises leave pending work while trust, indebtedness or boundaries may remain. Interpretations need not be mutual; do not invent unexpressed player feelings. Consolidation retains the basis of current relationships and meaningful recollection without becoming a turn log. Object provenance, memories of places and lasting injury effects follow the same principle.

Give durable information to its natural owner; create a separate document only for independent reference, evolving state or lifecycle tracking. The current situation carries immediate constraints without a single owner, people present and matters awaiting response. It is not a whole-world summary, process log or future branch list. Use the actual current scene in a running world.

## Subsequent play and long-term maintenance

When future-play reference is provided, use only its actually enabled author blocks as compatibility evidence. Do not assume optional style, agency or save policies are always enabled. The world prompt frame arranges this world's types, natural owners, save locations, time granularity and special constraints without copying cross-world rules or tool procedures. Explain the effect of a missing necessary policy rather than attempting to rewrite an external preset.

Put evolving facts in world documents and keep control material stable. Distinguish current state, discovery indexes and history; resident documents must not accumulate an unlimited event log. Arrange actual directories, summaries and references for any needed on-demand archive. Remove superseded descriptions, duplicates and expired pending work while retaining meaningful evidence. Advisory size limits do not require automatic truncation.

Inspect actual player-view selectors. Selecting a container displays its subtree; do not place hidden knowledge inside a public relationship node. Enrich a sentence directly when sufficient. If restructuring a bound node, review control selectors together, using stable locations for each purpose instead of copying an entire relationship truth. Temporary absence need not remove discoverability, and retirement does not cancel explicit full-document slots.

## Auditing and trimming

Audit concepts before sentences. List relevant directories, search several concrete terms, and completely read potentially overlapping material. Map factual owners, necessary projections and actual injection locations. Address cross-document duplication first, then classify sentences as facts, indexes, author instructions, narrative or future scripts. Merging or deletion must preserve continuity, meaningful experiences and discovery paths. Recheck actual post-write coverage; do not publish the entire internal audit map unless asked.
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
