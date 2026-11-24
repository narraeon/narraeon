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

/** Content-package-only paragraphs; a running-world revision omits them. */
const contentPackageWorldStartZhCN = `内容包设定用来确定“开场结束那一刻”的世界起点，包含既有历史、当前状态、进行中的事和各人认知。简单起点就能开玩，普通未定义内容可以在游玩中自然生长，不要预写必然发生的未来剧情或强制阶段。`;
const contentPackageCorePlayZhCN = `新建内容包或调整玩法方向时，按作者意图用一两句话把核心体验写进 \`control/frame.yaml\` 实际引用的世界主持块里：玩家能亲自做什么，哪些关系或局面提供空间。可以多线并行，也可以只是日常相处，不规定必经路线或结局。这里只写给主持人看，不复制开场原文、当前事实、谜底或秘密。`;
const contentPackageOpeningZhCN = `仅在编辑内容包时检查 \`opening.md\`：让首次游玩的玩家单读开场，就能明白主角是谁、眼前正发生什么、当前选择所需且角色已知的前提，以及待回应的交接或请求。只写眼下迈出第一步所需的信息，保留关键原话，不替玩家决定行动、台词或内心。独处、安静和等待同样可以开场，没有任务就不硬造任务。开场与设定文档停在同一时间点。`;
const contentPackageWorldStartEn = `Content-package authoring defines the world at the exact moment the opening ends: established history, current state, ongoing threads, and each character's knowledge. A lean start is playable, and ordinary undefined details can grow during play—do not script inevitable future events or mandatory plot stages.`;
const contentPackageCorePlayEn = `When creating a package or refining its play direction, state the core experience in one or two sentences inside a world GM block referenced by \`control/frame.yaml\`: what the player can do, and which relationships or situations create room for play. Multiple threads or quiet everyday companionship are equally valid, with no forced routes or endings. Address the GM only—do not copy opening prose, current facts, solutions, or secrets into this note.`;
const contentPackageOpeningEn = `Inspect \`opening.md\` only in content packages: let a first-time player understand from the opening alone who they play, what is happening right now, the character-known premises needed for the first choice, and any open request or handover. Include only what the first step needs, keep consequential wording, and never choose the player's action, speech, or inner thoughts. Quiet, solitude, and waiting are valid openings; never invent tasks. Stop the opening and world files at the exact same moment.`;

export const defaultSettingImprovementPromptZhCN = `# 推荐创作方法

一切从当前编辑目标、现有文件和用户意图出发：讨论时直接给出判断，动手时只改需要改的地方；若用户要求审查或整理，一并处理结构问题与重复表达。不要为了填满模板硬编设定——原本就够用时，保持原样完全没问题。

## 编辑目标与世界起点

${contentPackageWorldStartZhCN}

${contentPackageCorePlayZhCN}

运行中世界修订维护已经演变的世界：按用户要求调整，保留未受影响的事实、经历与认知，不退回初始值。修订属于世界外修改，无需编造剧情去解释。

涉及结构或文件位置时，先以本次请求已注入的目录和文档为准，缺少的再调工具读取。

## 世界信息怎么组织

- **状态归对应主体**：人物、物品、地点、组织和规则各自保存当前状态；进行中的事记进展和条件；意图、承诺和日程未实现前不写为已完成。把角色声称、猜测与客观事实分开。人物认知与态度各自独立，不随事实自动同步，也不代填玩家未表达的感情。
- **重要事件集中建档**：需要多人引用、持续追溯或重新解读的往事，放进独立事件文档，按事情组织而非按回合记流水账。事件只记当时的经过与结果；最新状态、待办和各人看法留在各自文档里并用引用关联。已经形成的状态和态度也要直接保存，不要每次开玩都从旧事件重推。
- **当前情境保持精简**：只写眼前的地点、在场者、正在发生的事和待回应事项，不塞进全部历史或未来分支。若当前情境用受限 YAML 的顶层 \`背景\`（或 \`background\`）记录简短时间/地点，Runtime 会将其随叙事保存以供日后理解“明天”“这里”；采用后就在该节点维护现值，不在别处重复保存。
- **\`summary\` 只做目录简介**：写清识别文档所需的简短身份或主题即可，不把具体状态和剧情经过塞进 \`summary\`。

## 保存位置与发现路径一起安排

每项长期信息都要明确放哪里、在哪更新、以及游玩时怎么被发现或注入。高频当前值按需注入，长事件通过目录和引用按需读取。查看真实的 \`frame.yaml\` 和写后覆盖情况，不要默认所有文档都会自动进入游玩请求。

同一时点、同一含义的事实尽量只维护一份；过去取值、当前结果和不同角色的看法不算重复。\`world/\`（或 \`state/\`）放故事事实，\`control/\` 放本世界的取材、规则、保存约定与视图绑定，不复制当前值，也不重复通用规则或工具流程。

## 开场与整理

${contentPackageOpeningZhCN}

整理时，收尾已完成或失效的事项、约定和限制，保留仍有影响的成果、后遗症、经历和引用。补录、去重和归档不代表事情重新发生。长材料留作按需读取，不要为了字数提示强行截断；角色暂时离场不算退场。

最后检查玩家视图选择器：容器会展示整个子树，隐藏认知不能混进公开节点；调整字段结构时同步更新选择器，无需默认输出冗长的内部审计表。
`;

export const defaultSettingImprovementPromptEn = `# Recommended authoring method

Start from the editing target, existing files, and the user's goal. Give clear judgment when asked to discuss, and make targeted edits when asked to implement; when asked to audit or reorganize, address structural issues and duplicate phrasing too. Never invent content just to fill a template—leaving things unchanged is fine when they already work.

## Target and starting point

${contentPackageWorldStartEn}

${contentPackageCorePlayEn}

Running-world revision updates an already evolving world: apply requested edits while preserving unaffected facts, history, and knowledge instead of resetting to initial values. Revision is out-of-world and needs no invented in-story explanation.

When structure or file locations are involved, start from the directory and files already provided in this request, and read additional files with tools only when needed.

## Organizing world information

- **Keep facts with their owners**: People, items, places, groups, and rules each hold their own current state. Ongoing processes record progress and conditions; intentions, promises, and schedules stay unrealized until fulfilled. Separate claims and guesses from objective facts. Character knowledge and attitudes belong to their holders, do not auto-sync with world changes, and never invent unexpressed player feelings.
- **Give major events one home**: Put shared past events that multiple characters will reference, recall, or reinterpret in dedicated event documents, grouped by what happened rather than turn by turn. Record what happened and the outcomes at that time; keep latest states, pending work, and personal views on their own owners linked to the event. Persist formed states and attitudes directly instead of making play re-infer them every session.
- **Keep the current situation focused**: Hold only the immediate location, people present, active events, and unanswered requests—not full history or future branches. If a restricted-YAML current situation uses a top-level \`background\` (or \`背景\`) node for brief time/place context, Runtime saves it alongside committed narrative to anchor relative references like "tomorrow" or "here"; once adopted, maintain those values there without a second copy.
- **Keep \`summary\` brief**: Use \`summary\` only to identify who or what a document is about; put concrete states and event accounts in the body.

## Plan storage and discovery together

Give every durable fact a clear owner, update spot, and real discovery or injection path. Inject frequently needed current values and keep long event accounts discoverable via catalogs and references. Check the actual \`frame.yaml\` and post-write coverage instead of assuming every body enters play automatically.

Prefer one maintained home for the same fact at the same time; past values, current outcomes, and different characters' views are not duplicates. \`world/\` (or \`state/\`) holds fictional facts; \`control/\` arranges selection, world-specific rules, save spots, and player views without duplicating current values or repeating general tool rules.

## Opening and consolidation

${contentPackageOpeningEn}

When consolidating, close completed or expired threads, commitments, and limits while keeping meaningful outcomes, lasting effects, history, and references. Backfilling, deduplicating, and archiving never replay events. Keep long material discoverable on demand instead of truncating for soft size hints; temporary absence is not retirement.

Check player-view selectors before finishing: containers expose entire subtrees, so keep hidden knowledge out of public nodes, update selectors whenever structure changes, and skip printing a full internal audit table unless asked.
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

/**
 * The same guidance for a running-world revision: the content-package-only
 * paragraphs are omitted, and everything else stays byte-identical.
 */
export function revisionSettingImprovementPromptForLocale(
  locale: AppLocale,
): string {
  const paragraphs =
    locale === "zh-CN"
      ? [
          contentPackageWorldStartZhCN,
          contentPackageCorePlayZhCN,
          contentPackageOpeningZhCN,
        ]
      : [
          contentPackageWorldStartEn,
          contentPackageCorePlayEn,
          contentPackageOpeningEn,
        ];
  return paragraphs.reduce(
    (text, paragraph) => text.replace(`${paragraph}\n\n`, ""),
    defaultSettingImprovementPromptForLocale(locale),
  );
}
