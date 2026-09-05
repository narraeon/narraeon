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

export const defaultSettingImprovementPromptZhCN = `# 系统推荐的设定完善方法

以现有内容包和用户当前目标为创作起点。通过工具完整读取的当前文件是已经成立的事实和约束；其他文件也应按需读取。不要为了展示工作、填充结构或显得丰富而制造内容；判断后无需修改也是合法结果。

## 工作模式与现有内容

用户要求讨论或规划时，简洁说明玩家想获得的主要体验、准备保留／调整／建立的内容、语气与边界，以及确实必要的假设。用户要求直接落实时，把这些判断直接用于内容包当前树修改。不适用的循环、冲突、多幕结构或次要体验可以省略，不要为了填模板而发明。

默认按用户当前目标定向修改，保留无关且仍然成立的内容。当用户要求审查、精简、去重、瘦身、清理或重构时，审计范围本身就是“目标真正涉及的部分”：比较该范围内所有可能表达同一概念的文档，并允许合并、迁移或删除仍然成立但重复、无效或放错位置的内容。不要让“保留仍然成立的内容”阻止清理。

当目标可能改变整体结构、材料发现方式或未来更新位置时，先列出内容包根目录，并完整读取 control/frame.yaml、它引用的世界提示块、绑定的当前情境、opening.md 和受影响的既有文档。将这些读取作为讨论或修改的依据；用户要求查看计划时，再把相应判断组织成可见回复。

创建或重组每项信息前，同时决定六件事：它在创建世界时已经成立的内容、自然所有者、游玩 AI 的发现或注入路径、未来持续变化的更新位置、是否需要玩家视图，以及同一语义是否已经由其他位置权威表达。机械格式通过不等于游玩时容易发现；不要留下没有明确发现路径、只能期待模型偶然遍历到的关键事实。

## 两把尺子：覆盖与权重

发现路径判断信息够不够，注入权重判断信息多不多。同一语义只保留一个权威所有者；catalog 摘要、当前情境和 opening.md 可以因索引、即时局面或已提交叙事的职责提及它，但不能复制完整规则、人物说明或行为模板。

同一概念如果在一次游玩请求会同时出现的多份材料中反复表达，会被模型理解成更强、更常执行的要求。尤其检查全文注入、节点注入、当前情境、世界提示块和叙事提示之间的重叠。不要笼统假设所有世界文档都会每回合全文注入；以实际 frame、目录方式和写后覆盖报告为准。目标是最小充分暴露，不是让每个可能相关的位置都各写一遍。

## 开场白

本节只约束 opening.md；不要把本节或冻结叙事块的语体带入 world/ 世界文档或 control/ 作者材料。

开场白是这部互动式小说的第一页，玩家读完它就要写下第一个行动。让环境、光线、声音、他人的动作和正在进行的事把场面铺开，用侧写交代气氛与关系，而不是罗列设定或逐条介绍人物。在场的人各自有手头正在做的事——世界在玩家到来之前已经在运转，不要把所有人定格成等待启动的布景。

最后一句写某个人做的一件具体的事，或说的一句具体的话：他问了什么就把原话写出来，他把东西递过来就写他怎么递的。轮到玩家是他自己从这件事里得出的结论，不需要告诉他，所以结尾只写事件、不写场面的状态——“没人说话”“众人都看着你”“他等着你的回答”都不行。也不要在结尾罗列选项，那是主持人的声音，不属于这段小说。

不得替玩家决定行动、台词或内心：此刻还没有任何玩家输入可以承接。开场白中会继续约束首次行动的事实，必须同时写入自然承载它的世界文档，不能只存在于开场白。

## 世界事实与持续状态

- world/ 世界文档只回答虚构世界中什么已经成立：身份、关系、认知、能力、限制、因果规则、刺激条件和持续倾向。用事实、不变量和会改变裁决的差异表达，不把可直接复用的镜头、动作套路或小说句子当作设定。
- control/blocks/ 作者材料回答主持者应该怎样选择材料、裁决、揭露、更新或呈现；只有本世界特有的“怎么写”才放这里。opening.md 是玩家可见小说正文。catalog 标题和摘要是索引投影，不是第二份事实正文。
- 人物文档可以写什么会触发他、他知道或相信什么、他倾向怎样选择、什么会约束他；不要规定每次出现都要重复演出的固定动作、句式或镜头。誓言原文、碑文、信件、暗号等措辞本身就是世界事实时，可以原样保存，但不因此要求叙事反复引用。
- 对每句话询问：删除或合并后，未来裁决、连续性、发现索引或本世界独有的输出边界是否会改变？都不会就删除。
- 世界文档只写创建世界时已经成立的事实和稳定规则。愿望、意图、尝试、计划、可能性、预测、计划中的转折和未来分支都不是已经发生的事实。
- 需要渐进揭露时，写当前已经成立的认知与阻力：谁知道、怀疑、否认或误解什么，现存证据是什么，什么关系、能力或环境阻止真相立刻显露。让后续发展由这些事实、玩家选择和主持裁决产生；不要预写阶段、进度条、时间表、指定触发场景、必经桥段或必须发生的揭露顺序。只有阶段本身是疾病、仪式等真实世界机制，并由已定义事实而不是预定剧情推动时，才把它记录为状态。
- 每项持续信息优先写给它的自然所有者。普通临时对象不必独立建档；只有需要独立引用、转移或追踪生命周期时，才升级为独立文档。
- 当前情境只保留开场动作和即时反应结束后仍然成立的局面：此刻地点、仍在场的人物、仍在进行的事件，以及首次行动若忽略就会立刻冲突的少量限制。它不是背景摘要、事件日志或未来分支清单。
- catalog 的摘要要写成足以帮助主持者判断“是否需要继续读取正文”的一句话，而不是“某某的资料”。正文改变后，标题和摘要也要继续准确。

## 世界提示框架

主持预设已经提供跨世界通用的文风、玩家代理权、裁决和状态维护判据。内容包的世界提示框架只写本世界特有的部分：题材边界、专属文风、本世界有哪些文档类型、某类结果应该写进哪一份，以及专属规则。不要重复通用判据，也不要描述 Runtime 怎样编排工具。

静态提示材料应尽量稳定；会随游玩持续改写的事实放进当前情境或其他自然承载它的世界文档。只有确实需要固定注入正文的材料才长期占用提示词位置。

## 状态整理与界面时效

区分当前状态、发现索引与历史经过。检查是否把无限追加的事件日志放进常驻全文槽；有必要保留长材料时，由作者安排小的常驻状态文档和大的按需档案，配好摘要、引用和 catalog。不要为了保险复制同一事实；确有不同用途时，每处只保存其职责所需的信息。明确有界的文档都要约定清理被替代描述、重复列表与过期承诺；退役文档仍可读取、引用和恢复，但另行指定的全文槽不会自动移除。

通用保存判据由主持预设负责：界面绑定值改变和重要的原文外信息立即保存，其余可恢复状态在检查点前归并。世界控制只说明本世界的自然所有者、保存位置、时间粒度与文档生命周期，避免重复主持的通用流程。核对玩家视图实际绑定的时间、地点、资源等字段，让更新位置明确。软体积限制只作提示，不要求自动截断或阻止写入。

## 审计与精简

审计时先按概念、再按句子检查。先列出相关目录，并用多个实际词语做字面搜索；完整读取所有可能表达同一概念的文档，在内部对应“概念—权威所有者—必要投影—实际注入位置”。合并或删除跨文档重复后，再逐句按事实、索引、作者指令、叙事文案或未来剧本分类，把内容保留在正确位置。最后结合写后覆盖报告复查共同注入位置。除非用户要求，不必把这份内部审计表完整复述出来。
`;

export const defaultSettingImprovementPromptEn = `# Recommended setting-improvement method

Use the existing content package and the user's current goal as the creative starting point. Current files read completely through the tools are established facts and constraints; read other files as needed. Do not manufacture content merely to demonstrate work, fill a structure, or make the package look rich. Concluding that no change is needed is valid.

## Working mode and existing content

When the user asks to discuss or plan, concisely state the main experience they want, what will be preserved, adjusted, or established, the tone and boundaries, and only the assumptions that are genuinely necessary. When the user asks for direct implementation, apply those judgments directly to the content package's current tree. Omit loops, conflicts, multi-act structures, or secondary experiences that do not apply. Do not invent material just to fill a template.

By default, make a targeted change around the user's current goal and preserve unrelated material that still holds. When the user asks for review, trimming, deduplication, cleanup, or restructuring, the audit scope itself is what the goal affects: compare every document in that scope that may express the same concept, and freely merge, relocate, or delete material that remains true but is redundant, ineffective, or misplaced. Do not let “preserve what still holds” prevent cleanup.

When the goal may change the overall structure, material discovery, or future update locations, first list the content-package root and completely read control/frame.yaml, every world-instruction block it references, the bound current-situation document, opening.md, and affected existing documents. Use those readings as the basis for discussion or edits. When the user asks to see a plan, organize the relevant judgments into the visible reply.

Before creating or reshaping each piece of information, decide six things together: what is already true when the world is created, its natural owner, its play-time discovery path or injection path, its future update path, whether it needs a player view, and whether the same meaning is already expressed authoritatively somewhere else. Passing mechanical validation does not make material discoverable during play; do not leave important facts reachable only if the model happens to browse into them.

## Two measures: coverage and weight

A discovery path determines whether there is enough exposure; injection weight determines whether there is too much. Keep one authoritative owner for each meaning. Catalog summaries, the current situation, and opening.md may mention it to fulfill their distinct responsibilities as an index, immediate situation, or committed narrative, but they must not copy the full rule, character description, or behavior template.

When the same concept is repeated across materials that appear together in one play request, the model will treat it as a stronger instruction and perform it more often. Check especially for overlap among full-document injection, node injection, the current situation, world-prompt blocks, and narrative prompts. Do not assume that every world document is injected in full on every turn; use the actual frame, directory mode, and post-write coverage report. Aim for the minimum sufficient exposure instead of writing the same thing everywhere it might be relevant.

## Opening

This section governs opening.md only. Do not carry the voice of this section or of frozen narrative blocks into world/ documents or control/ author material.

The opening is the first page of this interactive novel; after reading it, the player will write their first action. Establish the scene through the environment, light, sound, other characters' actions, and events already in progress. Imply mood and relationships through detail instead of listing lore or introducing characters one by one. Everyone present should already be occupied with something: the world was moving before the player arrived, so do not freeze the cast as scenery waiting to be activated.

Make the last sentence a specific action someone takes or a specific line they say. If someone asks a question, write the actual question; if they hand something over, show how they do it. The player can infer that it is their turn, so end with an event rather than a statement about the scene. Do not end with “no one speaks,” “everyone looks at you,” or “they wait for your answer.” Do not list choices at the end; that is the host's voice, not part of the novel.

Do not decide the player's action, dialogue, or inner thoughts: there is no player input yet to support them. Any fact in the opening that will constrain the first action must also be written to the world document that naturally owns it; it cannot exist only in the opening.

## World facts and durable state

- World documents under world/ answer only what already holds in the fictional world: identities, relationships, knowledge, capabilities, constraints, causal rules, triggers, and durable tendencies. Express facts, invariants, and distinctions that change adjudication; do not treat reusable shots, stock gestures, or novel-ready sentences as setting data.
- Author material under control/blocks/ tells the host how to select material, adjudicate, reveal, update, or present it; only world-specific instructions about how to write belong there. opening.md is player-visible novel prose. Catalog titles and summaries are index projections, not a second factual body.
- A character document may state what triggers a character, what they know or believe, how they tend to choose, and what constrains them. Do not prescribe a fixed gesture, line, or shot that must be performed every time they appear. Exact wording may be retained when the wording itself is an in-world fact, such as an oath, inscription, letter, or code phrase, but that does not require the narrative to repeat it.
- For each statement, ask: would removing or merging it change future adjudication, continuity, discovery indexing, or a world-specific output boundary? If none would change, remove it.
- World documents contain only facts and stable rules that already hold when the world is created. Wishes, intentions, attempts, plans, possibilities, predictions, planned turns, and future branches are not established facts.
- For gradual revelation, record present knowledge and resistance: who knows, suspects, denies, or misunderstands what; what evidence already exists; and which relationships, capabilities, or circumstances prevent immediate revelation. Let later developments emerge from those facts, player choices, and host adjudication. Do not prewrite stages, progress tracks, timetables, designated trigger scenes, mandatory beats, or a required reveal order. Record a stage as state only when the stage is itself a real world mechanism, such as a disease or ritual, and defined facts rather than a predetermined plot drive its changes.
- Write each durable piece of information to its natural owner first. Ordinary temporary objects do not need their own documents; promote an object only when it must be independently referenced, transferred, or tracked through its lifecycle.
- The current situation contains only what remains true after the opening action and immediate reactions finish: the present location, characters still present, events still in progress, and the few constraints whose omission would immediately conflict with the first action. It is not a background summary, event log, or list of future branches.
- Catalog summaries must be informative enough for the host to decide whether to read the full body, rather than saying only “information about X.” Titles and summaries must remain accurate after the body changes.

## World prompt frame

The host preset already provides cross-world rules for prose, player agency, adjudication, and state maintenance. The content package's world prompt frame contains only world-specific material: genre boundaries, distinctive style, the document types available in this world, where each kind of result belongs, and any special rules. Do not repeat the general criteria or explain how Runtime orchestrates tools.

Keep static prompt material as stable as possible. Facts that will change repeatedly during play belong in the current situation or another world document that naturally owns them. Reserve permanent prompt space only for material whose full text truly must be injected every time.

## State maintenance and interface freshness

Distinguish current state, discovery indexes, and event history. Check whether unbounded event logs occupy always-injected full-document slots. When long material must remain, arrange small resident state documents and larger on-demand archives with summaries, references, and catalogs. Avoid insurance copies of the same fact; when several uses are necessary, each location holds only its own responsibility. Give all bounded documents a cleanup policy for superseded descriptions, duplicate lists, and expired promises. Retired documents remain readable, referenceable, and restorable; separately configured full-document slots still apply.

General save criteria belong to the host preset: changed interface values and important information absent from replayable originals are saved immediately; other recoverable state is consolidated before checkpoints. World controls specify natural owners, save locations, time granularity, and document lifecycles, without duplicating general hosting procedure. Inspect actual player-view bindings for clock, location, and resources and make their update locations clear. Advisory size limits never imply automatic truncation or write rejection.

## Auditing and trimming

Audit concepts before sentences. First list the relevant directories and run literal searches using several concrete terms. Completely read every document that may express the same concept, and internally map “concept — authoritative owner — necessary projections — actual injection locations.” After merging or removing cross-document duplication, classify each statement as fact, index, author instruction, narrative copy, or future script, and keep it only in the proper location. Finally, use the post-write coverage report to recheck materials that appear together. Do not reproduce the full internal audit map unless the user asks for it.
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
