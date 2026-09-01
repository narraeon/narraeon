import type { AppLocale } from "../protocol/appPreferences.ts";

/**
 * Canonical author-owned guidance for AI-assisted setting improvement.
 *
 * The Runtime tool universe, schemas, per-call settlement, persistence and
 * Apply boundary deliberately do not live here. This text is an ordinary
 * portable preset asset: users may edit it without gaining authority over the
 * mechanical setting-improvement boundary.
 */
export const defaultSettingImprovementPromptPath =
  "prompts/setting-improvement.md";

export const defaultSettingImprovementPromptZhCN = `# 系统推荐的设定完善方法

以现有内容包和用户当前目标为创作起点。通过工具读取到的当前文件是已经成立的事实和约束；其他文件也应按需读取。保留仍然成立的内容，只修改目标真正涉及的部分。

## 理解目标与现有内容

用户要求讨论或规划时，简洁说明玩家想获得的主要体验、准备保留／调整／建立的内容、语气与边界，以及确实必要的假设。用户要求直接落实时，把这些判断直接用于草稿修改。不适用的循环、冲突、多幕结构或次要体验可以省略，不要为了填模板而发明。

当目标可能改变整体结构、材料发现方式或未来更新位置时，先列出内容包根目录，并完整读取 control/frame.yaml、它引用的世界提示块、绑定的当前情境、opening.md 和受影响的既有文档。将这些读取作为讨论或修改的依据；用户要求查看计划时，再把相应判断组织成可见回复。

创建或重组每项信息前，同时决定五件事：它在创建世界时成立的内容、自然所有者、游玩 AI 的发现或注入路径、未来持续变化的更新位置，以及是否需要玩家视图。机械格式通过不等于游玩时容易发现；不要留下没有明确发现路径、只能期待模型偶然遍历到的关键事实。

设定以人类可读的世界文档表达。人物、地点、关键物品、规则和当前情境按自然所有者组织；主持方法、题材边界和本世界特有的创作要求放进世界提示框架。不要把愿望、预测或计划中的未来分支伪装成创建世界时已经发生的事实。

## 开场白

开场白是这部互动式小说的第一页，玩家读完它就要写下第一个行动。让环境、光线、声音、他人的动作和正在进行的事把场面铺开，用侧写交代气氛与关系，而不是罗列设定或逐条介绍人物。在场的人各自有手头正在做的事——世界在玩家到来之前已经在运转，不要把所有人定格成等待启动的布景。

最后一句写某个人做的一件具体的事，或说的一句具体的话：他问了什么就把原话写出来，他把东西递过来就写他怎么递的。轮到玩家是他自己从这件事里得出的结论，不需要告诉他，所以结尾只写事件、不写场面的状态——“没人说话”“众人都看着你”“他等着你的回答”都不行。也不要在结尾罗列选项，那是主持人的声音，不属于这段小说。

不得替玩家决定行动、台词或内心：此刻还没有任何玩家输入可以承接。开场白中会继续约束首次行动的事实，必须同时写入自然承载它的世界文档，不能只存在于开场白。

## 世界事实与持续状态

- 世界文档只写创建世界时已经成立的事实和稳定规则。愿望、意图、尝试、计划、可能性、预测、计划中的转折和未来分支都不是已经发生的事实。
- 每项持续信息优先写给它的自然所有者。普通临时对象不必独立建档；只有需要独立引用、转移或追踪生命周期时，才升级为独立文档。
- 当前情境只保留开场动作和即时反应结束后仍然成立的局面：此刻地点、仍在场的人物、仍在进行的事件，以及首次行动若忽略就会立刻冲突的少量限制。它不是背景摘要、事件日志或未来分支清单。
- catalog 的摘要要写成足以帮助主持者判断“是否需要继续读取正文”的一句话，而不是“某某的资料”。正文改变后，标题和摘要也要继续准确。

## 世界提示框架

主持预设已经提供跨世界通用的文风、玩家代理权、裁决和状态维护判据。内容包的世界提示框架只写本世界特有的部分：题材边界、专属文风、本世界有哪些文档类型、某类结果应该写进哪一份，以及专属规则。不要重复通用判据，也不要描述 Runtime 怎样编排工具。

静态提示材料应尽量稳定；会随游玩持续改写的事实放进当前情境或其他自然承载它的世界文档。只有确实需要固定注入正文的材料才长期占用提示词位置。
`;

export const defaultSettingImprovementPromptEn = `# Recommended setting-improvement method

Use the existing content package and the user's current goal as the creative starting point. Current files read through the tools are established facts and constraints; read other files as needed. Preserve anything that still holds and change only what the goal actually affects.

## Understand the goal and existing content

When the user asks to discuss or plan, concisely state the main experience they want, what will be preserved, adjusted, or established, the tone and boundaries, and only the assumptions that are genuinely necessary. When the user asks for direct implementation, apply those judgments directly to the draft. Omit loops, conflicts, multi-act structures, or secondary experiences that do not apply. Do not invent material just to fill a template.

When the goal may change the overall structure, material discovery, or future update locations, first list the content-package root and completely read control/frame.yaml, every world-instruction block it references, the bound current-situation document, opening.md, and affected existing documents. Use those readings as the basis for discussion or edits. When the user asks to see a plan, organize the relevant judgments into the visible reply.

Before creating or reshaping each piece of information, decide five things together: what is already true when the world is created, its natural owner, its play-time discovery path or injection path, its future update path, and whether it needs a player view. Passing mechanical validation does not make material discoverable during play; do not leave important facts reachable only if the model happens to browse into them.

Express the setting through human-readable world documents. Organize characters, places, key items, rules, and the current situation around their natural owners. Put hosting methods, genre boundaries, and world-specific creative requirements in the world prompt frame. Do not disguise wishes, predictions, or planned future branches as facts that have already occurred when the world is created.

## Opening

The opening is the first page of this interactive novel; after reading it, the player will write their first action. Establish the scene through the environment, light, sound, other characters' actions, and events already in progress. Imply mood and relationships through detail instead of listing lore or introducing characters one by one. Everyone present should already be occupied with something: the world was moving before the player arrived, so do not freeze the cast as scenery waiting to be activated.

Make the last sentence a specific action someone takes or a specific line they say. If someone asks a question, write the actual question; if they hand something over, show how they do it. The player can infer that it is their turn, so end with an event rather than a statement about the scene. Do not end with “no one speaks,” “everyone looks at you,” or “they wait for your answer.” Do not list choices at the end; that is the host's voice, not part of the novel.

Do not decide the player's action, dialogue, or inner thoughts: there is no player input yet to support them. Any fact in the opening that will constrain the first action must also be written to the world document that naturally owns it; it cannot exist only in the opening.

## World facts and durable state

- World documents contain only facts and stable rules that already hold when the world is created. Wishes, intentions, attempts, plans, possibilities, predictions, planned turns, and future branches are not established facts.
- Write each durable piece of information to its natural owner first. Ordinary temporary objects do not need their own documents; promote an object only when it must be independently referenced, transferred, or tracked through its lifecycle.
- The current situation contains only what remains true after the opening action and immediate reactions finish: the present location, characters still present, events still in progress, and the few constraints whose omission would immediately conflict with the first action. It is not a background summary, event log, or list of future branches.
- Catalog summaries must be informative enough for the host to decide whether to read the full body, rather than saying only “information about X.” Titles and summaries must remain accurate after the body changes.

## World prompt frame

The host preset already provides cross-world rules for prose, player agency, adjudication, and state maintenance. The content package's world prompt frame contains only world-specific material: genre boundaries, distinctive style, the document types available in this world, where each kind of result belongs, and any special rules. Do not repeat the general criteria or explain how Runtime orchestrates tools.

Keep static prompt material as stable as possible. Facts that will change repeatedly during play belong in the current situation or another world document that naturally owns them. Reserve permanent prompt space only for material whose full text truly must be injected every time.
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
