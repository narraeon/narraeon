import type { ContentTreeFile } from "../content/ContentTreeFile.ts";
import {
  defaultAppLocale,
  type AppLocale,
} from "../../protocol/appPreferences.ts";
import {
  aggregateModelUsage,
  emptyAggregatedModelUsage,
  type ModelUsage,
} from "../../protocol/modelUsage.ts";
import { defaultSettingImprovementPromptForLocale } from "../../shared/default-setting-improvement-prompt.ts";
import {
  inspectContentPackageCurrentTree,
  type FileNativeContentInspection,
} from "../content/FileNativeContentTree.ts";
import type { PromptPreview } from "../prompt/FileNativePromptCompiler.ts";
import type { ProviderExchangeState } from "../model/ProviderExchangeState.ts";
import type {
  AiExchangeDiagnostics,
  AiFailureDescription,
  AiFailureRecorder,
} from "../model/AiFailureLog.ts";
import {
  WorldDocumentStore,
  type WorldDocumentDescriptor,
  type WorldDocumentQueryFailure,
  type WorldDocumentRevisionChange,
  type WorldDocumentRevisionCommand,
  type WorldDocumentRevisionTarget,
  type WorldDocumentRevisionYamlValue,
  type WorldDocumentSelector,
} from "../world/WorldDocumentStore.ts";

export interface SettingAuthorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  isError?: boolean;
  toolCalls?: SettingAuthorToolCall[];
  reasoningContent?: string;
  providerState?: ProviderExchangeState;
}

export interface SettingAuthorToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type SettingAuthorUsage = ModelUsage;

/**
 * One fragment of a response still being produced. Reported for observability
 * only: the exchange's result is still the aggregated response `next` resolves
 * to. `tool` carries raw argument JSON, which is worth counting as liveness but
 * not worth showing.
 */
export interface SettingAuthorDelta {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

export interface SettingAuthorAdapter {
  next(request: {
    messages: SettingAuthorMessage[];
    tools: readonly DocumentCandidateSettingTool[];
    maxOutputTokens: number;
    onDelta?: (delta: SettingAuthorDelta) => void;
  }): Promise<{
    role: "assistant";
    content: string;
    reasoningContent?: string;
    providerState?: ProviderExchangeState;
    toolCalls: SettingAuthorToolCall[];
    usage?: SettingAuthorUsage;
    /** Ephemeral raw Provider exchange; never enters the author transcript. */
    diagnostics?: AiExchangeDiagnostics;
  }>;
}

type SettingAuthorResponse = Awaited<ReturnType<SettingAuthorAdapter["next"]>>;

export interface SettingCandidateDiff {
  path: string;
  kind: "create" | "modify" | "delete";
  before: string | null;
  after: string | null;
}

export interface SettingCandidateReview {
  status: "usable" | "needs_repair";
  diff: SettingCandidateDiff[];
  diagnostics: FileNativeContentInspection["issues"];
  preview: PromptPreview;
}

export const readOnlyDocumentCandidateSettingTools = [
  "setting_list",
  "setting_search",
  "setting_read",
] as const;

export const documentCandidateSettingTools = [
  ...readOnlyDocumentCandidateSettingTools,
  "setting_write_file",
  "setting_patch",
  "setting_move",
  "setting_preview_candidate",
  "setting_finish_candidate",
] as const;

export type DocumentCandidateSettingTool =
  (typeof documentCandidateSettingTools)[number];

const readOnlySettingToolNames = new Set<string>(
  readOnlyDocumentCandidateSettingTools,
);

// setting_write_file is a world revision only when it targets world/. Control
// files and opening.md are opaque to WorldDocumentStore and go through
// executeTool, so the batch boundary follows the path, not the tool name.
function isWorldRevisionCall(call: SettingAuthorToolCall): boolean {
  if (call.name === "setting_patch" || call.name === "setting_move")
    return true;
  if (call.name !== "setting_write_file") return false;
  const { path } = call.arguments;
  return typeof path === "string" && path.startsWith("world/");
}

function writableControlPath(path: string): boolean {
  return (
    path === "control/frame.yaml" ||
    path === "control/player-views.yaml" ||
    /^control\/blocks\/[a-z0-9][a-z0-9/_-]*\.md$/u.test(path)
  );
}

// Reasoning-capable providers count hidden reasoning against max_tokens. A
// 4k cap can therefore return an empty visible plan even for a short request.
const planningOutputTokens = 16_384;
const editingOutputTokens = 16_384;

// The contract's control-file examples are the author's only specification of
// these shapes, so they are held as constants and checked against the real
// content-tree validator in tests. An example that drifts out of the schema
// teaches the author to write files the candidate self-check will reject.
const frameExample = `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: document, document: "@cultivation" }
  - slot: { kind: node, document: "@alex", locator: { yaml: [关系] } }
  - slot:
      kind: reference_targets
      from: { document: "@current-situation", locator: { yaml: [人物] } }
      maxEntries: 8
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`;

const emptyPlayerViewsExample = `format: narraeon.player-views/v1
views: []
`;

const playerViewsExample = `format: narraeon.player-views/v1
views:
  - id: player-status
    title: 当前状态
    items:
      - id: alex-clothes
        label: Alex 衣着
        select:
          document: "@alex"
          locator:
            yaml: [衣着]
      - id: jindan-rule
        label: 金丹
        select:
          document: "@cultivation"
          locator:
            markdown: [金丹]
`;

const frameExampleEn = `format: narraeon.world-frame/v1
bindings:
  currentSituation: "@current-situation"
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: catalog, directory: characters, maxEntries: 24 }
  - slot: { kind: document, document: "@cultivation" }
  - slot: { kind: node, document: "@alex", locator: { yaml: [relationships] } }
  - slot:
      kind: reference_targets
      from: { document: "@current-situation", locator: { yaml: [characters] } }
      maxEntries: 8
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`;

const playerViewsExampleEn = `format: narraeon.player-views/v1
views:
  - id: player-status
    title: Current status
    items:
      - id: alex-clothes
        label: Alex's clothing
        select:
          document: "@alex"
          locator:
            yaml: [clothing]
      - id: gold-core-rule
        label: Gold Core
        select:
          document: "@cultivation"
          locator:
            markdown: [Gold Core]
`;

/** Control-file examples from the author contract, validated by tests. */
export const settingAuthorContractExamples = {
  frame: frameExampleEn,
  emptyPlayerViews: emptyPlayerViewsExample,
  playerViews: playerViewsExampleEn,
} as const;

const settingAuthorRuntimeContractZhCN = `# Runtime 设定完善工具与机械契约

你只编辑固定内容包的隔离候选，不得修改运行中世界、历史、认知或权威提交。
Runtime 可能把用户选定文件的完整原文直接注入为“当前设定文件”；这些原文已经完整读取，不需要再调用读取工具取得写授权。
计划优先路径中，只能使用精确 list、原文字面 search 和精确 read 了解现有设定，再输出一份以“# 创作计划”开头的可见计划；这个阶段不得写候选。setting_list 的 directory 使用 world 或 world/ 下目录；list／search／read 返回的 cursor 只属于产生它的固定候选快照和原查询条件。
用户可以明确跳过可见计划并直接生成候选。进入候选阶段后，才可使用 \`setting_write_file\`、\`setting_patch\`、\`setting_move\` 和终态工具。\`setting_write_file\` 的 path 只接受这几类：\`world/\` 下以 \`.yaml\` 或 \`.md\` 结尾的世界文档、\`control/frame.yaml\`、\`control/player-views.yaml\`、\`control/blocks/\` 下的 \`.md\`，以及根级 \`opening.md\`；其余路径一律拒绝。\`world/\` 下的目录和文件名可以用中文，\`control/blocks/\` 下的文件名不行——它只接受小写字母开头、由小写字母、数字、连字符、下划线组成的名字，例如 \`control/blocks/world-style.md\`。修改既有文件前必须完整读取它；用户直接注入的完整文件视为已读，你自己创建或修改过的文件同样视为已读，都不需要为了再次修改而重读。同一模型响应里的 \`setting_write_file\`、\`setting_patch\`、\`setting_move\` 会合成一次原子 revision：其中任何一个被拒，整批都不生效，未被拒的调用也要连同修复一起重发，不要以为它们已经写进去了。每次成功 revision 都会替换候选快照并使旧 cursor 失效，需要继续分页时重新发起查询。所有工具只能看到逻辑路径，不能取得宿主路径。
内容包中的 world/ 文档会在创建世界时原样成为 state/。人物、地点、关键物品、规则和当前情境使用 YAML 或 Markdown；提示词框架、主持方法和玩家视图放在 control/。不要创建 schema、record 或 JSON 材料 DTO。
根级 opening.md 是玩家进入新世界后立即看到的开场白，内容包必须有且只有一份。先用 setting_list 检查它：缺失时用 setting_write_file 创建；如果本次修改改变开局地点、在场人物、眼前局面、叙事语气或行动钩子，必须先用 setting_read 完整读取既有 opening.md，再用 setting_write_file 更新；不受影响时保留原文，不要为了展示工作量而改写。
不得替玩家决定行动、台词或内心：此刻还没有任何玩家输入可以承接，写进去的每一个玩家动作都是凭空替他做主。开场白中会继续约束首次行动的事实，必须同时写入下面规则指定的世界文档，不能只存在于 opening.md。

## 这些设定将怎样被使用

- 游玩使用模型主导的调用链。全新上下文从最新世界端点重新编译 \`control/frame.yaml\` 的 context slot；追加上下文沿用当前 transcript。能持续约束后续行动的重要事实必须写进世界文档，不能只存在于开场白或某段叙事里。
- catalog slot 只注入每份文档的 title、summary 和 \`@ref\`，不注入正文。正文未读时，summary 是主持者判断“要不要读这份文档”的主要语义依据（title 也参与），所以要写成能支持这个判断的一句话，而不是“某某的资料”。
- 通用的裁决与状态维护判据由主持预设提供，并进入每条全新调用链的稳定 bootstrap。\`control/blocks/\` 只写这个世界特有的部分：题材边界、专属文风、本世界有哪些文档类型、某类结果该写进哪一份、专属规则。不要在这里重复通用判据，也不要重写人称与文风的通用默认值。
- \`control/blocks/\` 的内容会作为世界专属作者指令进入稳定 bootstrap。不要在其中描述 Runtime 编排；玩法预设负责叙事规则、工具契约和后置请求。
- \`control/player-views.yaml\` 决定玩家界面常驻显示哪些精确节点。空视图合法，但界面将没有常驻状态显示；如果这个世界有玩家应当随时看到的信息，按下面最小合法格式里的两层结构列出：视图负责分组和标题，视图的 \`items\` 里每个条目用 \`select\` 指向一份文档中的一个精确节点。文档和选择器只能写在条目上，不能写在视图上。它不是权限系统，未列出不等于秘密。

## 世界事实与状态维护

- 世界文档只写创建世界时已经成立的事实和稳定规则。愿望、意图、尝试、计划、可能性、预测、计划中的转折和未来分支都不是已经发生的事实；主持方法与创作要求写入 control/blocks/，不要伪装成世界事实。
- 运行时的保存判据与保存位置原则由主持预设承担，你不需要在内容包里复述它们。你在这里只决定**创建世界时已经成立的事实**该不该写、写成哪份文档，并在 \`control/blocks/\` 里说明这个世界有哪些文档类型、某类结果该写进哪一份。
- 普通上衣等临时对象不必独立建档，只在已有承载文档中记录后续真正需要的归属与意义。只有对象需要独立引用、转移或追踪生命周期时，才创建独立文档。
- 当前情境表示所有开场动作和即时反应结束后仍然成立的局面：只保留此刻地点、仍在场的人物、仍在进行的事件，以及首次行动若忽略就会立刻冲突的少量限制；删除背景回顾、已完成动作、已离场人物、已解决问题、已被取代的描述、计划、分支和预测。它不是事件日志。正文变化后，title 和 summary 也必须准确指向当前场景。
候选会接受文件安全、文档身份、引用、控制格式、必需 slot、玩家 selector 和真实 Prompt Preview 检查；Runtime 不解释好感度、关系方向或修为顺序。

## control/frame.yaml 的拼接与路径关联

- \`instructions\` 中的 Markdown 块按从上到下的顺序拼进 \`author_instruction\`；\`context\` 中的 slot 按从上到下的顺序拼进 \`world_context\`。移动条目只改变注入顺序，不会推断语义。如果固定 \`document\` 与 \`reference_targets\` 等 slot 恰好选择了同一整份文档，编译器保留第一次出现的位置并只注入一次；这只合并提示材料，不会改变当前情境中的在场引用或其他世界状态。整份文档与其中节点等范围重叠仍会被拒绝。
- 拼好的提示词按这个顺序送进模型，未变动的前缀可以命中缓存。当前情境会随权威提交变化，\`current_situation\` slot 已经排在后面承载它；你要做的是别让动态事实渗进前面的静态材料——用 \`document\` 或 \`node\` 固定注入正文的文档，以及 catalog 的 title 和 summary，都必须是稳定不变的。会持续改写的事实写进当前情境；确实需要额外的高频材料时另建文档，并把它的 slot 排在当前情境附近。
- 候选里的 \`world/\` 会在创建世界时改名为 \`state/\`，其后的相对路径保持不变。例如 \`world/states/sam.yaml\` 会成为 \`state/states/sam.yaml\`。
- \`catalog.directory: states\` 只匹配候选中 \`world/states/\` 下的直接子文档，也就是运行时 \`state/states/\` 下的直接子文档；它不按文档 id、ref、类型或文件名前缀匹配。特别是 \`world/state.sam.yaml\` 位于 \`world/\` 根级，不能被 \`states\` catalog 关联；用 \`setting_move\` 把路径改为真实目录，不要复制一份并遗留错误文件。更深的 \`world/states/group/sam.yaml\` 需要 \`directory: states/group\`。
- catalog 只注入每份文档的 title、summary 和 \`@ref\` 索引，不注入正文；需要固定注入整份正文时用 \`document\`，只注入局部时用 \`node\`，从 YAML 节点展开一层显式引用时用 \`reference_targets\`。bindings.currentSituation 决定 \`current_situation\` 的精确文档。这几种 slot 各自接受哪些参数由下面最小合法格式里的白名单规定，凭直觉多写一个键就会被判错。
- \`history\` slot 向全新上下文注入最近若干条已提交叙事（\`recent\` 默认 2，上限 32）。玩家可见叙事可能包含没有另行写入世界文档的具体细节——某个道具被拿起来、某句台词。少了这个 slot，重新编译的上下文只能看到当前情境，玩家顺着上一段叙事说话时会失去这些细节。除非这个世界确实不需要跨上下文的叙述连贯性，否则保留它。
- catalog 默认是必需的，必须至少关联一份直接子文档；只有明确允许目录暂时为空时才写 \`required: false\`。不要用可选空 catalog 掩盖路径拼错。

所有最终修改完成后调用 \`setting_preview_candidate\`；自检通过后才能调用 \`setting_finish_candidate\`，两者可以放在同一模型响应里先后调用。\`setting_finish_candidate\` 必须是该响应的最后一个工具调用，且该响应里不能有任何被拒绝的调用，否则结束请求不被接受。如果自检返回路径、slot、引用或 Prompt Preview 诊断，先修复并重新自检；自检未通过是正常的迭代，不是失败。用户只可整批应用或整批放弃。

## 最小合法格式

YAML 世界文档（ref 是 2 到 32 个字符，小写字母开头，其余只能是小写字母、数字或连字符；title 最多 120 字、summary 最多 240 字，两者必需；aliases 是可省略的别名数组，会连同 title、summary 一起进入 \`setting_search\` 的检索范围，写常用的口语称呼即可）：

例如把下面的 YAML 文档保存为 \`world/characters/alex.yaml\`，它才会进入 \`directory: characters\` 的 catalog：

\`\`\`yaml
$document:
  id: character.alex
  ref: alex
  title: Alex
  summary: 篮球队前锋，直率护短。
  aliases: [小艾]
衣着: 白色运动背心，运动短裤，拖鞋
关系:
  Sam: 熟悉但仍在试探
\`\`\`

Markdown 世界文档：

\`\`\`markdown
---
$document:
  id: rule.cultivation
  ref: cultivation
  title: 修炼境界
  summary: 境界顺序和突破方式。
  aliases: []
---
# 修炼境界

炼气之后是筑基，随后是金丹、元婴。金丹意味着……
\`\`\`

跨文档引用只使用精确对象，并且**写 Runtime 返回的 @短引用**，例如 \`{ $ref: "@alex" }\`；Runtime 存盘时会把它解析成目标文档的身份。绝对不要自己编一个像 \`character.alex\` 的 id 填进 \`$ref\`：文档 id 由 Runtime 分配，新建文档拿到的是 \`doc.7316210301cb48e2ae9a43954312b87d\` 这样的随机值，猜出来的 id 会被判成引用了不存在的身份。\`setting_read\` 返回的正文里 \`$ref\` 已经是解析后的 id 形式，原样保留写回即可，不必改写成短引用。也不要把文件路径冒充引用。

上面这样的完整原文就是 \`setting_write_file\` 的 contents，\`path\` 是完整逻辑路径。\`$document\` 里的 \`id\` 和 \`ref\` 由 Runtime 决定：新建时分配一个新 id 并在 \`ref\` 冲突时改写 \`ref\`，覆盖既有文档时保留原值；你照写即可，写成什么都不会被判错，实际生效的 id 和 \`@短引用\` 以工具返回为准。你不需要知道 id 具体是什么：文件正文的 \`$ref\`、\`control/frame.yaml\` 和 \`control/player-views.yaml\` 一律用 \`@短引用\` 寻址，Runtime 负责解析成身份。覆盖既有文档时也可以整段省略 \`$document\`，直接把 \`setting_read\` 返回的正文改好写回，Runtime 会沿用该文档原有的身份、title、summary 和 aliases；只有新建文档必须自带 \`$document\`。\`setting_patch\` 必须用 op 明确区分新增节点的 add 与替换既有节点的 replace，Runtime 不猜测有序批次执行到该命令时的意图；它的 locator 是一串 map-key，例如 \`["关系","Sam"]\`，不能用下标指向列表中的某一项——要改列表就 replace 承载它的那个键，整份新列表作为 value。Markdown 文档没有分节 patch，改动用 \`setting_write_file\` 整份重写。

control/frame.yaml（下面列出了全部七种 slot，按这个世界实际需要挑选，不必都用）：

\`\`\`yaml
${frameExample}\`\`\`

\`context\` 的每一项都只能是 \`- slot: {...}\`，slot 的参数是白名单，写入白名单以外的键会被判错。可用的 kind 和它们接受的全部参数：

- \`current_situation\`：只接受 kind。注入哪份文档由 \`bindings.currentSituation\` 决定，这里不写文档，写 required 也会被判错。
- \`additional_materials\`：只接受 kind，同样不接受 required。
- \`document\`：kind、document、required。\`document\` 写工具返回的 \`@短引用\`（必须加双引号），不是文件路径。
- \`node\`：kind、document、locator、required。\`locator\` 恰好写 \`yaml: [键, 子键]\` 或 \`markdown: [标题]\` 之一，YAML 文档只能用 yaml、Markdown 文档只能用 markdown，且该节点必须在文档里真实存在。
- \`catalog\`：kind、directory、maxEntries、required。maxEntries 必填，取 1 到 100。
- \`history\`：kind、recent。\`recent\` 可选，默认 2，取 1 到 32；不接受 required。
- \`reference_targets\`：kind、from、maxEntries、required。\`from\` 恰好包含 document 和 locator 两个键，其 locator 只支持 \`yaml\` 形式；maxEntries 必填，取 1 到 64。

\`required\` 是可选布尔值，默认 true，只有 document、node、catalog、reference_targets 接受它。内容包里能用的 slot 就是以上七种，不要发明别的 kind。

\`bindings.currentSituation\` 以及 document、node、reference_targets 里的 document 都用 \`@短引用\` 指向文档，取自 setting_list、setting_search、setting_read 或修改回执。**\`@\` 是 YAML 保留字符，这些值必须写成带双引号的 \`"@alex"\`**；漏掉引号整份控制文件会被判成不安全 YAML。

control/player-views.yaml 可以从空视图开始：

\`\`\`yaml
${emptyPlayerViewsExample}\`\`\`

需要常驻显示时按这个两层结构写：

\`\`\`yaml
${playerViewsExample}\`\`\`

视图对象只接受 id、title、items 三个字段，最多 128 个条目；不要把 document 或选择器写在视图上。条目只接受 id、label、select 三个字段。\`select.document\` 与 frame 一样写带双引号的 \`@短引用\`，不是文件路径；\`select.locator\` 与 node slot 同规则，恰好写 \`yaml\` 或 \`markdown\` 数组之一，整份省略 locator 表示显示整份文档。指向不存在的文档不会被自检拦下，只会让该条目在玩家界面上静默消失，所以短引用要从工具输出里取，不要凭印象写。

根级 opening.md 是普通 Markdown 原文，不带 $document 头。例如：

\`\`\`markdown
雨水沿着廊檐砸在你脚边。紧闭的药铺门内传来第二声撞击，街角巡夜人的灯正朝这里靠近。你只有片刻决定如何回应。
\`\`\``;

const settingAuthorRuntimeContractEn = `# Runtime setting-improvement tools and mechanical contract

You edit only an isolated candidate for one fixed content package. You cannot change a running world, history, character knowledge, or an authority commit.
Runtime may inject the complete source of user-selected files under “Current setting files.” Those files already count as completely read and need no additional read call for write authorization.

In the plan-first path, use only precise list, literal search, and precise read operations to understand the existing setting. Then produce a visible plan whose first level-one heading begins with “# Creation plan.” Do not write the candidate during this phase. setting_list accepts world or a directory under world/. Cursors returned by list, search, or read belong only to the fixed candidate snapshot and exact query that produced them.

The user may explicitly skip the visible plan. Only after entering the candidate phase may you use setting_write_file, setting_patch, setting_move, and the final-state tools. setting_write_file accepts only these paths: .yaml or .md world documents under world/; control/frame.yaml; control/player-views.yaml; .md files under control/blocks/; and the root opening.md. Every other path is rejected. world/ paths may use Unicode names. A control/blocks/ file name must begin with a lowercase ASCII letter and contain only lowercase letters, digits, hyphens, underscores, and slashes, for example control/blocks/world-style.md.

Read an existing file completely before changing it. A complete file injected by the user, or a file you created or changed yourself, already counts as read and need not be read again before another edit. Consecutive setting_write_file, setting_patch, and setting_move calls in one model response form one atomic revision. If any call is rejected, none of them take effect; resend the entire batch with the repair. Each successful revision replaces the candidate snapshot and invalidates old cursors. Tools expose logical paths only, never host paths.

Documents under world/ become state/ unchanged when a world is created. Use YAML or Markdown for characters, places, key items, rules, and the current situation. Put prompt frames, hosting methods, and player views under control/. Do not create schema records or JSON material DTOs.

The root opening.md is the prose shown immediately after the player enters a new world. A content package must contain exactly one. Use setting_list to check it. Create it when missing. If the requested change affects the opening location, characters present, immediate situation, narrative tone, or action hook, read the existing opening completely and update it. Preserve an unaffected opening instead of rewriting it merely to demonstrate work.

Do not decide the player's action, dialogue, or inner thoughts: no player input exists yet. Any fact in the opening that will constrain the first action must also be written to the world document that naturally owns it; it cannot live only in opening.md.

## How the setting is used

- Play uses a model-directed call chain. A fresh context recompiles the context slots in control/frame.yaml from the latest world endpoint; append continues the current transcript. Important facts that must constrain later actions belong in world documents, not only in the opening or one narrative passage.
- A catalog slot injects only each document's title, summary, and @ref, never its body. Before a body is read, the summary is the host's main signal for whether reading it is worthwhile, so write a useful one-sentence summary rather than “information about X.”
- The host preset supplies general adjudication and state-maintenance criteria to every fresh call chain. control/blocks/ contains only world-specific material: genre boundaries, distinctive style, document types in this world, where each result belongs, and special rules. Do not repeat the general criteria or redefine the default point of view and style.
- control/blocks/ enters the stable bootstrap as world-specific author instruction. Do not describe Runtime orchestration there; the play preset owns narrative rules, tool contracts, and follow-up requests.
- control/player-views.yaml selects precise nodes for persistent player-facing display. An empty view set is valid. When persistent information should be visible, use the two-level structure in the example below: views group and title items, while every item has a select that targets one exact node. Documents and selectors belong on items, never on the view itself. Player views are not a permission system; material omitted from them is not automatically secret.

## World facts and state

- World documents contain facts and stable rules that already hold when the world is created. Wishes, intentions, attempts, plans, possibilities, predictions, planned turns, and future branches are not established facts. Hosting and creative requirements belong in control/blocks/, not disguised as world facts.
- General save criteria and ownership rules come from the host preset. Here, decide which facts already hold at world creation, which documents own them, and which world-specific document types and destinations control/blocks/ must explain.
- Ordinary temporary objects such as a shirt do not need separate documents. Record only ownership and meaning that must persist in an existing owner document. Create a separate document only when an object needs an independent reference, transfer, or lifecycle.
- The current situation contains only what remains true after opening actions and immediate reactions finish: the present location, characters still present, events still in progress, and the few constraints whose omission would immediately conflict with the first action. Remove background recap, completed actions, departed characters, resolved problems, superseded descriptions, plans, branches, and predictions. It is not an event log. Keep its title and summary aligned with the current scene.

The candidate is checked for file safety, document identity, references, control formats, required slots, player selectors, and the real Prompt Preview. Runtime does not interpret affinity scores, relationship direction, or progression order.

## control/frame.yaml assembly and path association

- Markdown blocks in instructions enter author_instruction from top to bottom. Slots in context enter world_context from top to bottom. Moving an entry changes only injection order. If a fixed document slot and reference_targets select the same whole document, the compiler keeps the first position and injects it once; this deduplicates prompt material without changing presence references or other world state. A whole document overlapping one of its nodes remains invalid.
- The compiled prompt reaches the model in this order, and an unchanged prefix may be cached. The current situation changes with authority commits and belongs later in the current_situation slot. Keep dynamic facts out of earlier static material. Documents or nodes injected permanently, and catalog titles and summaries, must stay stable. Put frequently changing facts in the current situation; when another high-frequency material document is genuinely necessary, place its slot near the current situation.
- Candidate world/ paths become state/ paths when the world is created; the remainder stays unchanged. world/states/alex.yaml becomes state/states/alex.yaml.
- catalog.directory: states matches only direct child documents under world/states/, which become direct children under state/states/. It does not match by document id, ref, type, or file-name prefix. world/state.alex.yaml is at the world root and does not belong to that catalog; use setting_move to fix the path rather than copying the document and leaving the wrong one behind. world/states/group/alex.yaml requires directory: states/group.
- A catalog injects title, summary, and @ref only. Use document for a whole body, node for a precise section, and reference_targets to expand one layer of explicit references from a YAML node. bindings.currentSituation identifies the exact document for current_situation. The example below contains the full parameter allowlist; extra keys are rejected.
- A history slot injects recent committed narrative into a fresh context (recent defaults to 2 and accepts 1 through 32). Narrative may contain precise details that were never duplicated into a world document. Removing history can break prose continuity when the player responds to the preceding passage, so keep it unless this world truly does not need continuity across contexts.
- A catalog is required by default and must associate at least one direct child document. Use required: false only when the directory is intentionally allowed to be empty. Do not hide a path error behind an optional empty catalog.

After all final edits, call setting_preview_candidate. Only after it passes may you call setting_finish_candidate. Both calls may appear in one model response in that order. setting_finish_candidate must be the last tool call in that response, and the response may contain no rejected call. Repair path, slot, reference, or Prompt Preview diagnostics and preview again. A failed preview is normal iteration, not a terminal failure. The user can only apply or discard the candidate as a whole.

## Minimal valid formats

A YAML world document uses a ref of 2–32 characters beginning with a lowercase ASCII letter and continuing with lowercase letters, digits, or hyphens. title is required and at most 120 characters; summary is required and at most 240. aliases is an optional list of ordinary spoken names and participates in setting_search together with title and summary.

For example, saving this as world/characters/alex.yaml makes it a direct member of the characters catalog:

\`\`\`yaml
$document:
  id: character.alex
  ref: alex
  title: Alex
  summary: A direct, loyal basketball forward.
  aliases: [Al]
clothing: White athletic top, shorts, and sandals
relationships:
  Morgan: Familiar, but still testing the relationship
\`\`\`

A Markdown world document:

\`\`\`markdown
---
$document:
  id: rule.cultivation
  ref: cultivation
  title: Cultivation stages
  summary: The order of stages and how breakthroughs work.
  aliases: []
---
# Cultivation stages

Foundation Establishment follows Qi Refining, then Gold Core and Nascent Soul. Gold Core means…
\`\`\`

Cross-document references use an exact object and **an @short-ref returned by Runtime**, for example \`{ $ref: "@alex" }\`. Runtime resolves it to the target identity when saving. Never invent a document id such as character.alex for $ref. Runtime allocates random ids for new documents, and a guessed id refers to nothing. A body returned by setting_read already contains resolved $ref identities; preserve them exactly when writing it back. Never use a file path as a reference.

The complete source above is the contents for setting_write_file, whose path is the full logical path. Runtime decides $document.id and $document.ref. It allocates them for new documents, rewrites a conflicting ref, and preserves existing values on replacement. The effective id and @short-ref are those returned by the tool. You do not need to know the id: file-body $ref values, control/frame.yaml, and control/player-views.yaml all address documents with @short-refs, which Runtime resolves. When replacing an existing document, you may omit the entire $document block and edit the body returned by setting_read; Runtime preserves identity, title, summary, and aliases. Only new documents require $document.

setting_patch distinguishes add for a new node from replace for an existing node. Runtime does not guess intent from earlier commands in the batch. A locator is a sequence of map keys such as ["relationships","Morgan"]; it cannot select an element by list index. Replace the map key that owns a list with a complete new list value. Markdown has no section patch in setting improvement; rewrite it in full with setting_write_file.

control/frame.yaml (the example lists all seven slot kinds; choose only those the world needs):

\`\`\`yaml
${frameExampleEn}\`\`\`

Every context entry has exactly the form \`- slot: {...}\`. Slot parameters are allowlisted:

- current_situation: kind only. bindings.currentSituation selects the document. required is not accepted.
- additional_materials: kind only. required is not accepted.
- document: kind, document, required. document is a quoted @short-ref returned by a tool, not a file path.
- node: kind, document, locator, required. locator contains exactly one of yaml: [key, child] or markdown: [Heading], matches the document codec, and identifies a node that exists.
- catalog: kind, directory, maxEntries, required. maxEntries is required and ranges from 1 to 100.
- history: kind, recent. recent is optional, defaults to 2, and ranges from 1 to 32. required is not accepted.
- reference_targets: kind, from, maxEntries, required. from contains exactly document and locator, and its locator supports only yaml. maxEntries is required and ranges from 1 to 64.

required is an optional boolean defaulting to true and is accepted only by document, node, catalog, and reference_targets. These seven kinds are the entire supported slot set.

bindings.currentSituation and every document field in document, node, and reference_targets use @short-refs returned by setting_list, setting_search, setting_read, or a write receipt. **@ is reserved in YAML, so values must be quoted, such as "@alex".** Omitting quotes makes the control file unsafe YAML.

control/player-views.yaml may begin empty:

\`\`\`yaml
${emptyPlayerViewsExample}\`\`\`

For persistent display, use the two-level structure:

\`\`\`yaml
${playerViewsExampleEn}\`\`\`

A view accepts only id, title, and items, with at most 128 items. Do not place a document or selector on the view. An item accepts only id, label, and select. select.document is a quoted @short-ref, not a file path. select.locator follows the node-slot rule and contains exactly one yaml or markdown array. Omitting locator displays the whole document. A nonexistent document does not fail candidate validation; the item simply disappears from the player UI, so always copy short refs from tool output.

The root opening.md is ordinary Markdown prose with no $document header. For example:

\`\`\`markdown
Rain strikes the pavement beneath the eaves. A second crash sounds behind the locked apothecary door while the night watchman's lantern turns into the street. You have only a moment to respond.
\`\`\``;

export interface SettingImprovementStartInput {
  goal: string;
  contextPaths: readonly string[];
  mode: "plan_first" | "direct_candidate";
}

export interface SettingImprovementPlanResult {
  kind: "plan";
  markdown: string;
}

export interface SettingImprovementCandidateResult {
  kind: "candidate";
  files: ContentTreeFile[];
  review: SettingCandidateReview;
}

export interface SettingImprovementAction {
  tool: string;
  target: string | null;
  ok: boolean;
}

/**
 * What the author is doing right now, readable while a phase is still running.
 * `updatedAt` is the point of the whole projection: a stalled provider call
 * shows up as an age that keeps growing, which no counter alone can express.
 */
/**
 * The exchange currently being streamed. Counters only move between exchanges,
 * so without this a long reasoning trace is indistinguishable from a hung
 * socket — both leave every counter untouched.
 */
export interface SettingImprovementStreaming {
  reasoningChars: number;
  textChars: number;
  toolChars: number;
  tail: string;
  receivedAt: number;
}

export interface SettingImprovementProgress {
  phase: "idle" | "planning" | "generating" | "settled";
  round: number;
  maxRounds: number;
  toolCalls: number;
  repairs: number;
  failedChecks: number;
  usage: ModelUsage;
  writing: string | null;
  recentActions: SettingImprovementAction[];
  lastCheck: string | null;
  failure: string | null;
  streaming: SettingImprovementStreaming | null;
  updatedAt: number;
}

const maxSettingStreamTail = 160;

const maxRecentSettingActions = 12;

export class SettingModelError extends Error {
  readonly code:
    | "plan_invalid"
    | "protocol_invalid"
    | "tool_argument_invalid"
    | "tool_not_allowed"
    | "revision_rejected"
    | "read_required";

  constructor(code: SettingModelError["code"], message: string) {
    super(message);
    this.name = "SettingModelError";
    this.code = code;
  }
}

export class DocumentCandidateSettingImprovement {
  readonly #adapter: SettingAuthorAdapter;
  readonly #preview: (snapshot: WorldDocumentStore) => PromptPreview;
  readonly #authorPrompt: string;
  readonly #locale: AppLocale;
  readonly #failureLog: AiFailureRecorder | undefined;
  readonly #baseFiles: ContentTreeFile[];
  readonly #baseSnapshot: WorldDocumentStore;
  #currentFiles: ContentTreeFile[];
  #candidateFiles: ContentTreeFile[] | null = null;
  #candidateSnapshot: WorldDocumentStore | null = null;
  #candidateReads: SettingReadAuthorizations = freshReadAuthorizations(
    WorldDocumentStore.open({ layout: "content_package", files: [] }),
  );
  #candidateWorldChanges = new Map<string, WorldDocumentRevisionChange>();
  #messages: SettingAuthorMessage[] = [];
  #baseReads: SettingReadAuthorizations;
  #progress: SettingImprovementProgress = idleSettingProgress();
  #state:
    | "idle"
    | "starting"
    | "planned"
    | "confirming"
    | "ready"
    | "applying"
    | "discarded"
    | "applied" = "idle";

  constructor(input: {
    files: readonly ContentTreeFile[];
    adapter: SettingAuthorAdapter;
    preview: (snapshot: WorldDocumentStore) => PromptPreview;
    authorPrompt?: string;
    failureLog?: AiFailureRecorder;
    locale?: AppLocale;
  }) {
    this.#baseSnapshot = WorldDocumentStore.open({
      layout: "content_package",
      files: input.files,
    });
    this.#baseFiles = cloneFiles(this.#baseSnapshot.files);
    this.#currentFiles = cloneFiles(this.#baseSnapshot.files);
    this.#baseReads = freshReadAuthorizations(this.#baseSnapshot);
    this.#adapter = input.adapter;
    this.#preview = input.preview;
    this.#failureLog = input.failureLog;
    this.#locale = input.locale ?? defaultAppLocale;
    this.#authorPrompt = requiredAuthorPrompt(
      input.authorPrompt ??
        defaultSettingImprovementPromptForLocale(this.#locale),
    );
  }

  progress(): SettingImprovementProgress {
    return structuredClone(this.#progress);
  }

  #beginPhase(phase: "planning" | "generating"): void {
    this.#progress = { ...idleSettingProgress(), phase, updatedAt: Date.now() };
  }

  #settlePhase(failure: string | null): void {
    this.#progress.phase = "settled";
    this.#progress.failure = failure;
    this.#progress.updatedAt = Date.now();
  }

  #recordExchange(usage: SettingAuthorUsage | undefined): void {
    this.#progress.round += 1;
    this.#progress.usage = aggregateModelUsage(this.#progress.usage, usage);
    this.#progress.streaming = null;
    this.#progress.updatedAt = Date.now();
  }

  #recordDelta(delta: SettingAuthorDelta): void {
    const now = Date.now();
    const streaming = this.#progress.streaming ?? {
      reasoningChars: 0,
      textChars: 0,
      toolChars: 0,
      tail: "",
      receivedAt: now,
    };
    const size = [...delta.text].length;
    if (delta.kind === "reasoning") streaming.reasoningChars += size;
    else if (delta.kind === "text") streaming.textChars += size;
    else streaming.toolChars += size;
    // Raw argument JSON counts as liveness but reads as noise, so the visible
    // tail follows prose only.
    if (delta.kind !== "tool")
      streaming.tail = [...(streaming.tail + delta.text)]
        .slice(-maxSettingStreamTail)
        .join("");
    streaming.receivedAt = now;
    this.#progress.streaming = streaming;
    this.#progress.updatedAt = now;
  }

  // Counts are published before the guard may throw, so a run that trips the
  // ceiling still reports the count that tripped it instead of one less.
  #countRepair(current: number, phase: "plan" | "candidate"): number {
    this.#progress.repairs = current + 1;
    this.#progress.updatedAt = Date.now();
    return nextRepairCount(current, phase);
  }

  #countFailedCheck(current: number): number {
    this.#progress.failedChecks = current + 1;
    this.#progress.updatedAt = Date.now();
    return nextFailedCheckCount(current);
  }

  #recordAction(call: SettingAuthorToolCall, ok: boolean): void {
    const target = settingCallTarget(call);
    this.#progress.toolCalls += 1;
    if (ok && call.name === "setting_write_file")
      this.#progress.writing = target;
    this.#progress.recentActions.push({ tool: call.name, target, ok });
    if (this.#progress.recentActions.length > maxRecentSettingActions)
      this.#progress.recentActions.shift();
    this.#progress.updatedAt = Date.now();
  }

  async #observeResponse(response: SettingAuthorResponse): Promise<void> {
    if (response.diagnostics !== undefined)
      await this.#failureLog?.recordExchangeIfActive(response.diagnostics);
  }

  async #recordResponseFailure(
    response: SettingAuthorResponse,
    failure: AiFailureDescription,
  ): Promise<void> {
    if (response.diagnostics !== undefined)
      await this.#failureLog?.recordFailure({
        exchange: response.diagnostics,
        failures: [failure],
      });
  }

  async #resolveResponseFailures(
    response: SettingAuthorResponse,
    message: string,
  ): Promise<void> {
    if (response.diagnostics !== undefined)
      await this.#failureLog?.resolve({
        exchange: response.diagnostics,
        message,
      });
  }

  async start(
    input: SettingImprovementStartInput,
  ): Promise<SettingImprovementPlanResult | SettingImprovementCandidateResult> {
    if (this.#state !== "idle")
      throw new Error("The setting-improvement session has already started");
    if (input.mode !== "plan_first" && input.mode !== "direct_candidate")
      throw new Error("Invalid setting-improvement start mode");
    const goal = input.goal.trim();
    if (goal.length === 0)
      throw new Error("The setting-improvement goal cannot be empty");
    const injectedFiles = selectInjectedFiles(
      this.#baseFiles,
      input.contextPaths,
    );
    this.#baseReads = freshReadAuthorizations(this.#baseSnapshot);
    for (const file of injectedFiles)
      authorizeInjectedFile(this.#baseSnapshot, this.#baseReads, file);
    this.#messages = [
      {
        role: "system",
        content: settingAuthorSystemPrompt(this.#authorPrompt, this.#locale),
      },
      ...(injectedFiles.length === 0
        ? []
        : [
            {
              role: "user" as const,
              content: injectedContext(injectedFiles, this.#locale),
            },
          ]),
      {
        role: "user",
        content: `${this.#locale === "zh-CN" ? "# 本次完善目标" : "# Current improvement goal"}\n\n${goal}`,
      },
    ];
    this.#state = "starting";
    if (input.mode === "direct_candidate")
      return this.#generateCandidate("direct");
    return this.#createPlan();
  }

  async #createPlan(
    entry: "initial" | "revision" = "initial",
  ): Promise<SettingImprovementPlanResult> {
    let repairs = 0;
    let lastResponse: SettingAuthorResponse | undefined;
    this.#beginPhase("planning");
    this.#messages.push({
      role: "user",
      content:
        entry === "initial"
          ? localized(
              this.#locale,
              "This is the read-only planning phase. Treat the goal as an improvement to the existing setting. Use setting_list, setting_search, and setting_read as needed to understand the fixed current tree, then output a visible creation plan. Do not create, change, or finish a candidate in this phase.",
              "这是只读计划阶段。把目标理解为对已有设定的完善；先用 setting_list、setting_search、setting_read 按需了解固定当前树，再输出可见创作计划。此阶段不得创建、修改或结束候选。",
            )
          : localized(
              this.#locale,
              "Adjust the direction from the feedback above, then output a complete replacement creation plan. Preserve what still holds instead of writing only a delta. This remains a read-only phase: you may continue checking with setting_list, setting_search, and setting_read, but may not create, change, or finish a candidate.",
              "按上面的修改意见调整方向，然后重新输出一份完整的创作计划；沿用仍然成立的部分，不要只写增量。仍是只读阶段，可以继续用 setting_list、setting_search、setting_read 核对，但不得创建、修改或结束候选。",
            ),
    });
    for (let round = 0; round < 64; round += 1) {
      const response = await this.#adapter.next({
        messages: publicMessages(this.#messages),
        tools: readOnlyDocumentCandidateSettingTools,
        maxOutputTokens: planningOutputTokens,
        onDelta: (delta) => this.#recordDelta(delta),
      });
      lastResponse = response;
      await this.#observeResponse(response);
      this.#recordExchange(response.usage);
      this.#messages.push(assistantMessage(response));
      if (response.toolCalls.length === 0) {
        try {
          assertVisiblePlan(response.content, this.#locale);
        } catch (error: unknown) {
          if (!(error instanceof SettingModelError)) throw error;
          await this.#recordResponseFailure(response, {
            kind: "format_validation",
            message: error.message,
            details: { phase: "planning", content: response.content },
          });
          this.#messages.push({
            role: "user",
            content: renderSettingRepair(error.message, this.#locale),
          });
          repairs = this.#countRepair(repairs, "plan");
          continue;
        }
        this.#state = "planned";
        this.#settlePhase(null);
        await this.#resolveResponseFailures(
          response,
          "The setting-improvement plan passed format validation in a later model exchange.",
        );
        return { kind: "plan", markdown: response.content };
      }
      for (const call of response.toolCalls) {
        let result: SettingToolResult;
        if (!readOnlySettingToolNames.has(call.name))
          result = settingToolFailure(
            this.#baseSnapshot,
            localized(
              this.#locale,
              "The planning phase allows only setting_list, setting_search, and setting_read",
              "计划阶段只允许 setting_list、setting_search、setting_read",
            ),
            this.#locale,
          );
        else {
          try {
            result = executeTool(
              this.#baseSnapshot,
              call,
              this.#baseReads,
              this.#locale,
            );
          } catch (error: unknown) {
            if (!(error instanceof SettingModelError)) throw error;
            result = settingToolFailure(
              this.#baseSnapshot,
              error.message,
              this.#locale,
            );
          }
        }
        this.#messages.push({
          role: "tool",
          toolCallId: call.id,
          content: result.markdown,
          ...(result.ok ? {} : { isError: true }),
        });
        this.#recordAction(call, result.ok);
        if (!result.ok) {
          await this.#recordResponseFailure(response, {
            kind: "tool_execution",
            message:
              "A model tool call in the setting-improvement planning phase was rejected.",
            details: {
              call: structuredClone(call),
              result: result.markdown,
            },
          });
          repairs = this.#countRepair(repairs, "plan");
        }
      }
    }
    const message =
      "Setting-improvement planning exceeded the maximum read-only tool rounds";
    if (lastResponse !== undefined)
      await this.#recordResponseFailure(lastResponse, {
        kind: "format_validation",
        message,
        details: { phase: "planning", maximumRounds: 64 },
      });
    throw new Error(message);
  }

  async confirmPlan(): Promise<SettingImprovementCandidateResult> {
    if (this.#state !== "planned")
      throw new Error("There is no creation plan to confirm");
    this.#state = "confirming";
    try {
      return await this.#generateCandidate("confirmed_plan");
    } catch (error: unknown) {
      this.#state = "planned";
      throw error;
    }
  }

  /**
   * Continues the same session with the user's note appended.
   *
   * Accept-all-or-discard-all forced a full restart over any disagreement,
   * throwing away everything the author had already read and got right. The
   * note lands in the existing transcript, so revision keeps that context.
   */
  async revisePlan(feedback: string): Promise<SettingImprovementPlanResult> {
    if (this.#state !== "planned")
      throw new Error("There is no creation plan to revise");
    this.#messages.push({
      role: "user",
      content: `${this.#locale === "zh-CN" ? "# 用户对创作计划的修改意见" : "# User feedback on the creation plan"}\n\n${requiredFeedback(feedback)}`,
    });
    this.#state = "starting";
    try {
      return await this.#createPlan("revision");
    } catch (error: unknown) {
      this.#state = "planned";
      throw error;
    }
  }

  async reviseCandidate(
    feedback: string,
  ): Promise<SettingImprovementCandidateResult> {
    if (this.#state !== "ready" || this.#candidateSnapshot === null)
      throw new Error("There is no candidate to revise");
    this.#messages.push({
      role: "user",
      content: `${this.#locale === "zh-CN" ? "# 用户对候选的修改意见" : "# User feedback on the candidate"}\n\n${requiredFeedback(feedback)}`,
    });
    this.#state = "confirming";
    try {
      return await this.#generateCandidate("revision");
    } catch (error: unknown) {
      this.#state = "ready";
      throw error;
    }
  }

  async #generateCandidate(
    entry: "confirmed_plan" | "direct" | "revision",
  ): Promise<SettingImprovementCandidateResult> {
    const preGenerationLength = this.#messages.length;
    try {
      const candidate = await this.#runCandidateGeneration(entry);
      this.#settlePhase(null);
      return candidate;
    } catch (error: unknown) {
      this.#messages.splice(preGenerationLength);
      // The counters survive the rollback: they are the only account of why
      // this run stopped once the conversation itself has been discarded.
      this.#settlePhase(
        error instanceof Error
          ? error.message
          : "Setting-improvement candidate generation was interrupted",
      );
      throw error;
    }
  }

  async #runCandidateGeneration(
    entry: "confirmed_plan" | "direct" | "revision",
  ): Promise<SettingImprovementCandidateResult> {
    // A revision resumes the candidate the user just looked at; starting from
    // the baseline again would make the author redo work it already got right.
    const resumed = entry === "revision" ? this.#candidateSnapshot : null;
    let candidate = resumed ?? this.#baseSnapshot;
    let lastFailedCheck: string | null = null;
    let previewedSnapshotId: string | null = null;
    let previewedCheck: Extract<CandidateAuthorCheck, { passed: true }> | null =
      null;
    const reads = cloneReadAuthorizations(
      resumed === null ? this.#baseReads : this.#candidateReads,
    );
    const worldChanges = new Map<string, WorldDocumentRevisionChange>(
      resumed === null ? [] : this.#candidateWorldChanges,
    );
    let repairs = 0;
    let failedChecks = 0;
    let lastResponse: SettingAuthorResponse | undefined;
    this.#beginPhase("generating");
    this.#messages.push({
      role: "user",
      content:
        entry === "confirmed_plan"
          ? localized(
              this.#locale,
              "The plan is confirmed. Enter the candidate phase: list the isolated candidate and inspect opening.md first. Read files completely as needed before changing them, and preserve the confirmed direction. After all edits, call setting_preview_candidate and, once it passes, setting_finish_candidate. The two calls may appear in that order in one model response.",
              "计划已确认。现在进入候选阶段：先列出隔离候选并检查 opening.md；按需完整读取后再修改文件，不要改变已确认方向。最终修改后调用 setting_preview_candidate，自检通过后调用 setting_finish_candidate，两者可以在同一模型响应内先后调用。",
            )
          : entry === "direct"
            ? localized(
                this.#locale,
                "The user explicitly skipped the visible creation plan. Enter the candidate phase directly: list the isolated candidate and inspect opening.md first, then produce a complete candidate from the current goal, injected files, and current setting read as needed. After all edits, call setting_preview_candidate and, once it passes, setting_finish_candidate. The two calls may appear in that order in one model response.",
                "用户明确选择跳过可见创作计划。现在直接进入候选阶段：先列出隔离候选并检查 opening.md，基于当前目标、已注入文件和按需读取的当前设定生成完整候选。最终修改后调用 setting_preview_candidate，自检通过后调用 setting_finish_candidate，两者可以在同一模型响应内先后调用。",
              )
            : localized(
                this.#locale,
                "Continue revising the candidate from the feedback above. The current candidate is exactly the state from the end of the previous generation, and accepted changes are still present. Change only what needs correction instead of rebuilding it. Then call setting_preview_candidate and, once it passes, setting_finish_candidate.",
                "按上面的修改意见继续调整候选。当前候选就是上一次生成结束时的状态，已落地的修改都还在，只需改动需要改的部分，不要推倒重来。改完后照旧调用 setting_preview_candidate，自检通过后调用 setting_finish_candidate。",
              ),
    });
    for (let round = 0; round < 64; round += 1) {
      const response = await this.#adapter.next({
        messages: publicMessages(this.#messages),
        tools: documentCandidateSettingTools,
        maxOutputTokens: editingOutputTokens,
        onDelta: (delta) => this.#recordDelta(delta),
      });
      lastResponse = response;
      await this.#observeResponse(response);
      this.#recordExchange(response.usage);
      this.#messages.push(assistantMessage(response));
      if (response.toolCalls.length === 0) {
        await this.#recordResponseFailure(response, {
          kind: "format_validation",
          message:
            lastFailedCheck === null
              ? "The setting-improvement candidate response did not call a final-state tool."
              : "The setting-improvement candidate response did not repair the failed mechanical check.",
          details: {
            phase: "candidate",
            content: response.content,
            lastFailedCheck,
          },
        });
        this.#messages.push({
          role: "user",
          content: renderSettingRepair(
            lastFailedCheck === null
              ? localized(
                  this.#locale,
                  "Setting improvement must finish the candidate with a final-state tool",
                  "设定完善必须使用终态工具结束候选",
                )
              : localized(
                  this.#locale,
                  `The candidate failed mechanical checks: ${lastFailedCheck.replace(/\s+/gu, " ")}`,
                  `候选未通过机械检查：${lastFailedCheck.replace(/\s+/gu, " ")}`,
                ),
            this.#locale,
          ),
        });
        repairs = this.#countRepair(repairs, "candidate");
        continue;
      }
      let finished = false;
      let responseHadRepairError = false;
      for (let callIndex = 0; callIndex < response.toolCalls.length;) {
        const call = response.toolCalls[callIndex]!;
        if (isWorldRevisionCall(call)) {
          const revisionCalls: SettingAuthorToolCall[] = [];
          while (
            callIndex < response.toolCalls.length &&
            isWorldRevisionCall(response.toolCalls[callIndex]!)
          ) {
            revisionCalls.push(response.toolCalls[callIndex]!);
            callIndex += 1;
          }
          let revisionFailure: SettingToolResult | null = null;
          // Which call in the batch is actually at fault. The others only need
          // to know the batch did not land and where to look, not a copy of a
          // diagnostic about someone else's command.
          let failureIndex: number | null = null;
          try {
            const commands: WorldDocumentRevisionCommand[] = [];
            for (const [index, revisionCall] of revisionCalls.entries()) {
              try {
                commands.push(worldRevisionCommand(revisionCall, this.#locale));
              } catch (error: unknown) {
                failureIndex = index;
                throw error;
              }
            }
            const revised = candidate.revise({ commands });
            if (!revised.ok) {
              failureIndex =
                revised.diagnostics.find(
                  ({ commandIndex }) => commandIndex !== null,
                )?.commandIndex ?? null;
              throw new SettingModelError(
                "revision_rejected",
                renderSettingRevisionFailure(revised.diagnostics),
              );
            }
            staleSettingReadAuthorizationForTest(reads);
            assertRevisionChangesAuthorized(
              candidate.id,
              reads,
              revised.changes,
              this.#locale,
            );
            candidate = revised.snapshot;
            mergeWorldRevisionChanges(worldChanges, revised.changes);
            rebaseReadAuthorizations(reads, candidate);
            for (const { documentId } of revised.changes)
              reads.worldDocumentIds.add(documentId);
            previewedSnapshotId = null;
            previewedCheck = null;
            for (const [index, revisionCall] of revisionCalls.entries())
              this.#messages.push({
                role: "tool",
                toolCallId: revisionCall.id,
                content: renderSettingCallSuccess(
                  revised.changes,
                  index,
                  this.#locale,
                ),
              });
          } catch (error: unknown) {
            if (!(error instanceof SettingModelError)) throw error;
            revisionFailure = settingToolFailure(
              candidate,
              error.message,
              this.#locale,
            );
          }
          if (revisionFailure !== null) {
            const failed = revisionFailure;
            for (const [index, revisionCall] of revisionCalls.entries())
              this.#messages.push({
                role: "tool",
                toolCallId: revisionCall.id,
                content:
                  failureIndex === null || failureIndex === index
                    ? failed.markdown
                    : renderSettingBatchRejected(
                        revisionCalls,
                        failureIndex,
                        this.#locale,
                      ),
                isError: true,
              });
            await this.#recordResponseFailure(response, {
              kind: "tool_execution",
              message:
                "The world-document revision for the setting-improvement candidate was rejected.",
              details: {
                calls: structuredClone(revisionCalls),
                failureIndex,
                result: failed.markdown,
              },
            });
            responseHadRepairError = true;
            repairs = this.#countRepair(repairs, "candidate");
          }
          for (const revisionCall of revisionCalls)
            this.#recordAction(revisionCall, revisionFailure === null);
          continue;
        }
        if (call.name === "setting_finish_candidate") {
          let rejection: string | null = null;
          if (call !== response.toolCalls.at(-1))
            rejection = localized(
              this.#locale,
              "The candidate final-state tool must be called last",
              "候选终态工具必须最后调用",
            );
          else if (responseHadRepairError)
            rejection = localized(
              this.#locale,
              "This response contains an unresolved error; repair it before finishing the candidate",
              "本响应中有未处理的错误，请先修复再结束候选",
            );
          else if (previewedSnapshotId !== candidate.id)
            rejection = localized(
              this.#locale,
              "setting_finish_candidate was rejected. Call setting_preview_candidate first and pass the complete check for the current candidate snapshot. Preview and finish may occur in that order in the same response.",
              "setting_finish_candidate 未被接受。必须先调用 setting_preview_candidate 并让当前候选快照的整体自检通过，才能结束候选；同一轮内先自检再结束也可以。",
            );
          this.#messages.push({
            role: "tool",
            toolCallId: call.id,
            content:
              rejection === null
                ? localized(
                    this.#locale,
                    "# Candidate final state accepted\n\nRuntime accepted the current isolated candidate for user review. The content package is unchanged and will be replaced only if the user applies the entire candidate.",
                    "# 候选终态已接受\n\nRuntime 已接受当前隔离候选供用户审阅；内容包尚未改变，只有用户整批应用后才会替换当前树。",
                  )
                : localized(
                    this.#locale,
                    `# Runtime tool rejected\n\n${rejection}`,
                    `# Runtime 工具拒绝\n\n${rejection}`,
                  ),
            ...(rejection === null ? {} : { isError: true }),
          });
          if (rejection === null) finished = true;
          else {
            await this.#recordResponseFailure(response, {
              kind: "tool_execution",
              message: rejection,
              details: { call: structuredClone(call) },
            });
            responseHadRepairError = true;
            repairs = this.#countRepair(repairs, "candidate");
          }
          this.#recordAction(call, rejection === null);
          callIndex += 1;
          continue;
        }
        if (call.name === "setting_preview_candidate") {
          const check = checkCandidateForAuthor(
            candidate,
            this.#preview,
            this.#locale,
          );
          this.#messages.push({
            role: "tool",
            toolCallId: call.id,
            content: check.markdown,
            ...(check.passed ? {} : { isError: true }),
          });
          lastFailedCheck = check.passed ? null : check.markdown;
          previewedSnapshotId = check.passed ? candidate.id : null;
          previewedCheck = check.passed ? check : null;
          this.#progress.lastCheck = check.passed
            ? null
            : summarizeSettingCheck(check.markdown);
          this.#recordAction(call, check.passed);
          if (!check.passed) {
            await this.#recordResponseFailure(response, {
              kind: "format_validation",
              message:
                "The setting-improvement candidate failed mechanical checks.",
              details: {
                call: structuredClone(call),
                check: check.markdown,
              },
            });
            responseHadRepairError = true;
            failedChecks = this.#countFailedCheck(failedChecks);
          }
          callIndex += 1;
          continue;
        }
        let result: SettingToolResult;
        try {
          result = executeTool(candidate, call, reads, this.#locale);
        } catch (error: unknown) {
          if (!(error instanceof SettingModelError)) throw error;
          result = settingToolFailure(candidate, error.message, this.#locale);
        }
        const previousSnapshotId = candidate.id;
        candidate = result.snapshot;
        if (candidate.id !== previousSnapshotId) {
          previewedSnapshotId = null;
          previewedCheck = null;
        }
        this.#messages.push({
          role: "tool",
          toolCallId: call.id,
          content: result.markdown,
          ...(result.ok ? {} : { isError: true }),
        });
        this.#recordAction(call, result.ok);
        if (!result.ok) {
          await this.#recordResponseFailure(response, {
            kind: "tool_execution",
            message:
              "A model tool call for the setting-improvement candidate was rejected.",
            details: {
              call: structuredClone(call),
              result: result.markdown,
            },
          });
          responseHadRepairError = true;
          repairs = this.#countRepair(repairs, "candidate");
        }
        callIndex += 1;
      }
      if (!finished) continue;
      const candidateFiles = cloneFiles(candidate.files);
      const check = previewedCheck;
      if (check === null || previewedSnapshotId !== candidate.id)
        throw new Error(
          "The candidate final state lacks a complete passing check for the current snapshot",
        );
      const review = {
        status: check.inspection.status,
        diff: candidateDiffs(this.#baseFiles, candidateFiles, worldChanges),
        diagnostics: structuredClone(check.inspection.issues),
        preview: structuredClone(check.preview),
      } satisfies SettingCandidateReview;
      this.#candidateFiles = candidateFiles;
      // Kept so a later revision can resume from here instead of the baseline.
      this.#candidateSnapshot = candidate;
      this.#candidateReads = cloneReadAuthorizations(reads);
      this.#candidateWorldChanges = new Map(worldChanges);
      this.#state = "ready";
      await this.#resolveResponseFailures(
        response,
        "The setting-improvement candidate was repaired and passed complete checks in a later model exchange.",
      );
      return { kind: "candidate", files: cloneFiles(candidateFiles), review };
    }
    const message = "Setting improvement exceeded the maximum tool rounds";
    if (lastResponse !== undefined)
      await this.#recordResponseFailure(lastResponse, {
        kind: "format_validation",
        message,
        details: { phase: "candidate", maximumRounds: 64 },
      });
    throw new Error(message);
  }

  currentFiles(): ContentTreeFile[] {
    return cloneFiles(this.#currentFiles);
  }

  async apply(
    replaceAtomically: (files: ContentTreeFile[]) => void | Promise<void>,
  ): Promise<void> {
    if (this.#state !== "ready" || this.#candidateFiles === null)
      throw new Error("There is no complete candidate to apply");
    const files = cloneFiles(this.#candidateFiles);
    this.#state = "applying";
    try {
      await replaceAtomically(files);
    } catch (error: unknown) {
      this.#state = "ready";
      throw error;
    }
    this.#currentFiles = files;
    this.#candidateFiles = null;
    this.#state = "applied";
  }

  discard(): void {
    if (this.#state === "applied")
      throw new Error("An applied candidate cannot be discarded");
    if (
      this.#state === "starting" ||
      this.#state === "confirming" ||
      this.#state === "applying"
    )
      throw new Error(
        "The setting-improvement operation is running and cannot be discarded",
      );
    this.#candidateFiles = null;
    this.#state = "discarded";
  }
}

type CandidateAuthorCheck =
  | { passed: false; markdown: string }
  | {
      passed: true;
      markdown: string;
      inspection: FileNativeContentInspection;
      preview: PromptPreview;
    };

function checkCandidateForAuthor(
  snapshot: WorldDocumentStore,
  preview: (snapshot: WorldDocumentStore) => PromptPreview,
  locale: AppLocale,
): CandidateAuthorCheck {
  const inspection = inspectContentPackageCurrentTree(snapshot.files, {
    worldDocumentSnapshot: snapshot,
  });
  if (inspection.status !== "usable")
    return {
      passed: false,
      markdown: [
        locale === "zh-CN" ? "# 候选自检未通过" : "# Candidate check failed",
        "",
        locale === "zh-CN"
          ? "先修复以下 Runtime 内容树诊断，再重新调用 setting_preview_candidate："
          : "Repair these Runtime content-tree diagnostics, then call setting_preview_candidate again:",
        "",
        ...inspection.issues.map(
          ({ code, path, message }) => `- ${code} · ${path} · ${message}`,
        ),
      ].join("\n"),
    };
  try {
    const result = preview(snapshot);
    return {
      passed: true,
      inspection,
      preview: result,
      markdown: [
        locale === "zh-CN" ? "# 候选自检通过" : "# Candidate check passed",
        "",
        locale === "zh-CN"
          ? "真实 Prompt Preview 已成功编译。材料覆盖如下："
          : "The real Prompt Preview compiled successfully. Material coverage:",
        "",
        ...result.compilation.coverage.map(
          ({ slot, source, status, complete }) =>
            `- ${slot} · ${source} · ${status} · ${complete ? (locale === "zh-CN" ? "完整" : "complete") : locale === "zh-CN" ? "未完整" : "incomplete"}`,
        ),
        "",
        locale === "zh-CN"
          ? "若这就是最终候选，可以调用 setting_finish_candidate；继续修改后必须重新自检。"
          : "If this is the final candidate, call setting_finish_candidate. Any further change requires another check.",
      ].join("\n"),
    };
  } catch (error: unknown) {
    return {
      passed: false,
      markdown: [
        locale === "zh-CN" ? "# 候选自检未通过" : "# Candidate check failed",
        "",
        locale === "zh-CN"
          ? "真实 Prompt Preview 编译失败。先修复后重新调用 setting_preview_candidate："
          : "The real Prompt Preview failed to compile. Repair it, then call setting_preview_candidate again:",
        "",
        `- ${
          error instanceof Error
            ? error.message
            : locale === "zh-CN"
              ? "未知 Prompt Preview 错误"
              : "Unknown Prompt Preview error"
        }`,
      ].join("\n"),
    };
  }
}

function assistantMessage(response: {
  content: string;
  reasoningContent?: string;
  providerState?: ProviderExchangeState;
  toolCalls: SettingAuthorToolCall[];
}): SettingAuthorMessage {
  return {
    role: "assistant",
    content: response.content,
    ...(response.reasoningContent === undefined
      ? {}
      : { reasoningContent: response.reasoningContent }),
    ...(response.providerState === undefined
      ? {}
      : { providerState: structuredClone(response.providerState) }),
    toolCalls: structuredClone(response.toolCalls),
  };
}

function selectInjectedFiles(
  files: readonly ContentTreeFile[],
  contextPaths: readonly string[],
): ContentTreeFile[] {
  if (!Array.isArray(contextPaths))
    throw new Error("Injected file paths must be an array");
  const selected: ContentTreeFile[] = [];
  const seen = new Set<string>();
  for (const candidatePath of contextPaths) {
    if (typeof candidatePath !== "string")
      throw new Error("An injected file path must be a string");
    const path = safeInputPath(candidatePath);
    if (seen.has(path))
      throw new Error(`Duplicate injected file path: ${path}`);
    seen.add(path);
    const file = files.find((candidate) => candidate.path === path);
    if (file === undefined)
      throw new Error(`Injected file does not exist: ${path}`);
    if (file.encoding === "base64")
      throw new Error(
        `A binary file cannot be injected into a model prompt: ${path}`,
      );
    selected.push(structuredClone(file));
  }
  return selected.sort((left, right) => left.path.localeCompare(right.path));
}

function injectedContext(
  files: readonly ContentTreeFile[],
  locale: AppLocale,
): string {
  const sections = files.map((file) => {
    const fence = markdownFence(file.contents);
    return `## \`${file.path}\`\n\n${fence}${markdownLanguage(file.path)}\n${file.contents}${file.contents.endsWith("\n") ? "" : "\n"}${fence}`;
  });
  return [
    locale === "zh-CN"
      ? "# 用户选定的当前设定文件"
      : "# User-selected current setting files",
    "",
    locale === "zh-CN"
      ? "以下完整原文来自本次会话固定的内容包当前树，已经视为完整读取。它们是要保留或完善的已有设定，不是从零创作指令。未注入的文件仍可通过只读工具按需读取。"
      : "The complete source below comes from the content package tree frozen for this session and already counts as completely read. These are existing setting files to preserve or improve, not instructions to create from scratch. Read uninjected files as needed with read-only tools.",
    "",
    ...sections.flatMap((section, index) =>
      index === sections.length - 1 ? [section] : [section, ""],
    ),
  ].join("\n");
}

function markdownFence(contents: string): string {
  const longest = Math.max(
    0,
    ...(contents.match(/`+/gu) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function markdownLanguage(path: string): string {
  if (/\.ya?ml$/u.test(path)) return "yaml";
  if (path.endsWith(".md")) return "markdown";
  return "text";
}

interface SettingReadAuthorizations {
  snapshotId: string;
  worldDocumentIds: Set<string>;
  damagedWorldPaths: Set<string>;
  opaquePaths: Set<string>;
  pendingWorldReads: Map<
    string,
    {
      documentId: string;
      nextOffset: number;
      totalBytes: number;
    }
  >;
}

interface SettingQueryResult {
  ok: boolean;
  markdown: string;
}

interface SettingToolResult extends SettingQueryResult {
  snapshot: WorldDocumentStore;
}

function freshReadAuthorizations(
  snapshot: WorldDocumentStore,
): SettingReadAuthorizations {
  return {
    snapshotId: snapshot.id,
    worldDocumentIds: new Set(),
    damagedWorldPaths: new Set(),
    opaquePaths: new Set(),
    pendingWorldReads: new Map(),
  };
}

function cloneReadAuthorizations(
  source: SettingReadAuthorizations,
): SettingReadAuthorizations {
  return {
    snapshotId: source.snapshotId,
    worldDocumentIds: new Set(source.worldDocumentIds),
    damagedWorldPaths: new Set(source.damagedWorldPaths),
    opaquePaths: new Set(source.opaquePaths),
    pendingWorldReads: new Map(
      [...source.pendingWorldReads].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    ),
  };
}

function authorizeInjectedFile(
  snapshot: WorldDocumentStore,
  reads: SettingReadAuthorizations,
  file: ContentTreeFile,
): void {
  if (!file.path.startsWith("world/")) {
    reads.opaquePaths.add(file.path);
    return;
  }
  const result = snapshot.query({
    kind: "read_document",
    document: { logicalPath: file.path },
    maxBytes: 4,
  });
  if (result.kind === "read_document" && result.ok)
    reads.worldDocumentIds.add(result.document.documentId);
  else reads.damagedWorldPaths.add(file.path);
}

function changedSnapshot(
  source: WorldDocumentStore,
  reads: SettingReadAuthorizations,
  files: readonly ContentTreeFile[],
  writtenPath: string,
  markdown: string,
): SettingToolResult {
  const snapshot = WorldDocumentStore.open({
    layout: "content_package",
    files,
  });
  if (snapshot.id === source.id)
    throw new Error(
      "The candidate snapshot update did not produce a new snapshot identity",
    );
  rebaseReadAuthorizations(reads, snapshot);
  reads.opaquePaths.add(writtenPath);
  return { ok: true, snapshot, markdown };
}

// Read authorizations exist to stop the author from overwriting content it has
// never seen. A revision does not erase that knowledge: untouched documents
// keep their contents, and a document the author just wrote is the one it knows
// best. Only paged cursors are bound to a snapshot, so only they are dropped.
function rebaseReadAuthorizations(
  reads: SettingReadAuthorizations,
  snapshot: WorldDocumentStore,
): void {
  reads.snapshotId = snapshot.id;
  reads.pendingWorldReads.clear();
}

function listSettingDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  locale: AppLocale,
): SettingQueryResult {
  if (!hasOnlyArguments(args, ["directory", "limit", "cursor"]))
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_list accepts only directory, limit, and cursor.",
        "setting_list 只接受 directory、limit 和 cursor。",
      ),
      locale,
    );
  const requestedDirectory = args.directory ?? "world";
  if (
    typeof requestedDirectory !== "string" ||
    (requestedDirectory !== "world" && !requestedDirectory.startsWith("world/"))
  )
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_list directory must be world or a directory under world/.",
        "setting_list directory 必须是 world 或 world/ 下的目录。",
      ),
      locale,
    );
  const relativeDirectory =
    requestedDirectory === "world"
      ? ""
      : requestedDirectory.slice("world/".length);
  const limit = args.limit ?? 100;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !validOptionalCursor(args.cursor)
  )
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_list limit must be between 1 and 100, and cursor must come from the same snapshot and directory query.",
        "setting_list limit 必须为 1 到 100，cursor 必须来自同一快照和目录查询。",
      ),
      locale,
    );
  const result = snapshot.query({
    kind: "catalog",
    directory: relativeDirectory,
    limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") return renderSettingQueryFailure(result, locale);
  if (result.kind !== "catalog") return unexpectedSettingQueryResult();
  const entries = result.entries.map((entry) => {
    if (entry.kind === "directory")
      return localized(
        locale,
        `- [directory] ${entry.logicalPath}/`,
        `- [目录] ${entry.logicalPath}/`,
      );
    if (entry.document === undefined)
      return localized(
        locale,
        `- [damaged document] ${entry.logicalPath} · ${entry.diagnostics
          .map(({ code }) => code)
          .join(", ")}`,
        `- [损坏文档] ${entry.logicalPath} · ${entry.diagnostics
          .map(({ code }) => code)
          .join(", ")}`,
      );
    return `- @${entry.document.shortRef} · ${entry.document.title} · ${entry.logicalPath}`;
  });
  const opaque =
    relativeDirectory === "" && result.page.start === 0
      ? snapshot.files
          .filter(({ path }) => !path.startsWith("world/"))
          .map(({ path, encoding }) =>
            encoding === undefined
              ? localized(
                  locale,
                  `- [special file] ${path}`,
                  `- [专用文件] ${path}`,
                )
              : localized(locale, `- [binary] ${path}`, `- [二进制] ${path}`),
          )
      : [];
  return settingQuerySuccess(
    localized(
      locale,
      `# Setting directory\n\nScope: world · ${relativeDirectory || "/"}\nCoverage: ${result.coverage.status === "complete" ? "complete" : "partial"}\n${[...opaque, ...entries].join("\n") || "(empty)"}\n\n---\nThis page: ${result.page.start}..${result.page.end} / ${result.page.total} items\nComplete: ${result.page.complete ? "yes" : "no"}${result.page.nextCursor === null ? "" : `\nNext-page cursor: ${result.page.nextCursor}`}`,
      `# 设定目录\n\n范围：world · ${relativeDirectory || "/"}\n覆盖：${result.coverage.status === "complete" ? "完整" : "部分"}\n${[...opaque, ...entries].join("\n") || "（空）"}\n\n---\n本页：${result.page.start}..${result.page.end} / ${result.page.total} 项\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
    ),
  );
}

function searchSettingDocuments(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  locale: AppLocale,
): SettingQueryResult {
  if (
    !hasOnlyArguments(args, [
      "query",
      "within",
      "caseSensitive",
      "limit",
      "cursor",
    ]) ||
    typeof args.query !== "string" ||
    args.query.length < 1 ||
    args.query.length > 256 ||
    (args.within !== undefined && typeof args.within !== "string") ||
    (args.caseSensitive !== undefined &&
      typeof args.caseSensitive !== "boolean") ||
    (args.limit !== undefined && typeof args.limit !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_search accepts only a literal query in world scope plus within, caseSensitive, limit, and cursor.",
        "setting_search 只接受 world 范围内的字面 query、within、caseSensitive、limit 和 cursor。",
      ),
      locale,
    );
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_search limit must be between 1 and 100.",
        "setting_search limit 必须为 1 到 100。",
      ),
      locale,
    );
  const within = settingSearchScope(args.within);
  if (within === invalidSettingSearchScope)
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_search within must be a world/ directory, world/ document path, @short-ref, or document identity.",
        "setting_search within 必须是 world/ 目录、world/ 文档路径、@短引用或文档身份。",
      ),
      locale,
    );
  const result = snapshot.query({
    kind: "literal_search",
    query: args.query,
    caseSensitive: args.caseSensitive === true,
    ...(within === undefined ? {} : { within }),
    limit,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") return renderSettingQueryFailure(result, locale);
  if (result.kind !== "literal_search") return unexpectedSettingQueryResult();
  const matches = result.matches
    .map(({ document, referenceProjection, range }) =>
      localized(
        locale,
        `- @${document.shortRef} · ${document.title} · ${document.logicalPath} · line ${range.start.line}, column ${range.start.column}\n  Exact match: ${JSON.stringify(referenceProjection.text)}\n  Exact-match excerpt: ${JSON.stringify(referenceProjection.excerpt)}`,
        `- @${document.shortRef} · ${document.title} · ${document.logicalPath} · 第 ${range.start.line} 行第 ${range.start.column} 列\n  原始命中：${JSON.stringify(referenceProjection.text)}\n  原始命中片段：${JSON.stringify(referenceProjection.excerpt)}`,
      ),
    )
    .join("\n");
  const scope = args.within === undefined ? "world" : `world · ${args.within}`;
  return settingQuerySuccess(
    localized(
      locale,
      `# Literal setting search\n\nScope: ${scope}\nNormalization: ${args.caseSensitive === true ? "original text" : "NFKC + case folding"}\nCoverage: ${result.coverage.status === "complete" ? "complete" : `partial (${result.coverage.excludedDocuments} damaged documents excluded)`}\nTotal matches: ${result.page.total}\n${matches || "Zero literal matches do not prove that the fact is absent from the setting."}\n\n---\nThis page: ${result.page.start}..${result.page.end} / ${result.page.total} matches\nComplete: ${result.page.complete ? "yes" : "no"}${result.page.nextCursor === null ? "" : `\nNext-page cursor: ${result.page.nextCursor}`}`,
      `# 设定字面搜索\n\n范围：${scope}\nnormalization：${args.caseSensitive === true ? "原文" : "NFKC + 大小写折叠"}\n覆盖：${result.coverage.status === "complete" ? "完整" : `部分（排除 ${result.coverage.excludedDocuments} 份损坏文档）`}\n命中总数：${result.page.total}\n${matches || "0 个字面命中不证明设定中不存在该事实。"}\n\n---\n本页：${result.page.start}..${result.page.end} / ${result.page.total} 个命中\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
    ),
  );
}

const invalidSettingSearchScope = Symbol("invalid-setting-search-scope");

function settingSearchScope(
  value: unknown,
):
  | undefined
  | { directory: string }
  | { document: WorldDocumentSelector }
  | typeof invalidSettingSearchScope {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    return invalidSettingSearchScope;
  if (value.startsWith("@"))
    return value.length > 1
      ? { document: { shortRef: value.slice(1) } }
      : invalidSettingSearchScope;
  if (value === "world") return { directory: "" };
  if (value.startsWith("world/")) {
    const safe = safePath(value);
    return /\.(?:ya?ml|md)$/u.test(safe)
      ? { document: { logicalPath: safe } }
      : { directory: safe.slice("world/".length) };
  }
  return { document: { documentId: value } };
}

function readSettingDocument(
  snapshot: WorldDocumentStore,
  args: Record<string, unknown>,
  reads: SettingReadAuthorizations,
  locale: AppLocale,
): SettingQueryResult {
  if (
    !hasOnlyArguments(args, ["path", "maxBytes", "cursor"]) ||
    typeof args.path !== "string" ||
    args.path.length === 0 ||
    (args.maxBytes !== undefined && typeof args.maxBytes !== "number") ||
    !validOptionalCursor(args.cursor)
  )
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_read accepts only an exact path, maxBytes, and cursor.",
        "setting_read 只接受精确 path、maxBytes 和 cursor。",
      ),
      locale,
    );
  const exactOpaque = snapshot.files.find(
    ({ path }) => path === args.path && !path.startsWith("world/"),
  );
  if (exactOpaque !== undefined) {
    if (args.cursor !== undefined || args.maxBytes !== undefined)
      return settingQueryArgumentError(
        localized(
          locale,
          "opening, control, and opaque special files support only one complete read and do not accept pagination arguments.",
          "opening／control／opaque 专用文件只支持一次完整读取，不接受分页参数。",
        ),
        locale,
      );
    if (exactOpaque.encoding !== undefined)
      return settingQueryArgumentError(
        localized(
          locale,
          `Binary files cannot be read: ${exactOpaque.path}`,
          `二进制文件不能读取：${exactOpaque.path}`,
        ),
        locale,
      );
    reads.opaquePaths.add(exactOpaque.path);
    return settingQuerySuccess(
      localized(
        locale,
        `# Special-file source ${exactOpaque.path}\n\n${exactOpaque.contents}\n\n---\nScope: opaque · ${exactOpaque.path}\nComplete: yes`,
        `# 专用文件原文 ${exactOpaque.path}\n\n${exactOpaque.contents}\n\n---\n范围：opaque · ${exactOpaque.path}\n完整：是`,
      ),
    );
  }
  const selector = settingDocumentSelector(args.path);
  if (selector === null)
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_read path must be a world/ document path, @short-ref, document identity, or existing special-file path.",
        "setting_read path 必须是 world/ 文档路径、@短引用、文档身份或存在的专用文件路径。",
      ),
      locale,
    );
  const maxBytes = args.maxBytes ?? 8192;
  if (
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > 65_536
  )
    return settingQueryArgumentError(
      localized(
        locale,
        "setting_read maxBytes must be between 4 and 65536.",
        "setting_read maxBytes 必须为 4 到 65536。",
      ),
      locale,
    );
  const result = snapshot.query({
    kind: "read_document",
    document: selector,
    maxBytes,
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
  });
  if (result.kind === "error") return renderSettingQueryFailure(result, locale);
  if (result.kind !== "read_document") return unexpectedSettingQueryResult();
  authorizeWorldReadPage(
    reads,
    result.document,
    selector,
    maxBytes,
    result.page,
  );
  return settingQuerySuccess(
    localized(
      locale,
      `# Exact read @${result.document.shortRef}\n\n${renderSettingDocumentMetadata(result.document, locale)}\n[Writable body starts; locators are relative to this point]\n${result.body.trimEnd()}\n[Writable body ${result.page.complete ? "ends" : "continues"}]\n\n---\nScope: world · @${result.document.shortRef}\nThis page: ${result.page.start}..${result.page.end} / ${result.page.total} bytes\nComplete: ${result.page.complete ? "yes" : "no"}${result.page.nextCursor === null ? "" : `\nNext-page cursor: ${result.page.nextCursor}`}`,
      `# 精确读取 @${result.document.shortRef}\n\n${renderSettingDocumentMetadata(result.document, locale)}\n[可写正文开始；locator 相对于这里]\n${result.body.trimEnd()}\n[可写正文${result.page.complete ? "结束" : "继续"}]\n\n---\n范围：world · @${result.document.shortRef}\n本页：${result.page.start}..${result.page.end} / ${result.page.total} bytes\n完整：${result.page.complete ? "是" : "否"}${result.page.nextCursor === null ? "" : `\n下一页 cursor：${result.page.nextCursor}`}`,
    ),
  );
}

function settingDocumentSelector(value: string): WorldDocumentSelector | null {
  if (value.startsWith("@"))
    return value.length > 1 ? { shortRef: value.slice(1) } : null;
  if (value.startsWith("world/"))
    return /\.(?:ya?ml|md)$/u.test(safePath(value))
      ? { logicalPath: value }
      : null;
  return value.includes("/") ? null : { documentId: value };
}

function authorizeWorldReadPage(
  reads: SettingReadAuthorizations,
  document: WorldDocumentDescriptor,
  selector: WorldDocumentSelector,
  maxBytes: number,
  page: {
    start: number;
    end: number;
    total: number;
    complete: boolean;
  },
): void {
  const key = JSON.stringify({ selector, maxBytes });
  if (page.start === 0) {
    reads.pendingWorldReads.set(key, {
      documentId: document.documentId,
      nextOffset: page.end,
      totalBytes: page.total,
    });
  } else {
    const pending = reads.pendingWorldReads.get(key);
    if (
      pending?.documentId !== document.documentId ||
      pending?.nextOffset !== page.start ||
      pending?.totalBytes !== page.total
    )
      return;
    pending.nextOffset = page.end;
  }
  const pending = reads.pendingWorldReads.get(key);
  if (pending?.nextOffset !== pending?.totalBytes || !page.complete) return;
  reads.worldDocumentIds.add(document.documentId);
  reads.pendingWorldReads.delete(key);
}

function renderSettingDocumentMetadata(
  document: WorldDocumentDescriptor,
  locale: AppLocale,
): string {
  return [
    `title: ${document.title}`,
    `summary: ${document.summary}`,
    `${locale === "zh-CN" ? "aliases：" : "aliases: "}${document.aliases.length === 0 ? localized(locale, "(none)", "（无）") : document.aliases.join(locale === "zh-CN" ? "、" : ", ")}`,
    `codec: ${document.codec}`,
    `logicalPath: ${document.logicalPath}`,
  ].join("\n");
}

function renderSettingQueryFailure(
  result: WorldDocumentQueryFailure,
  locale: AppLocale,
): SettingQueryResult {
  return {
    ok: false,
    markdown: [
      localized(
        locale,
        "# WorldDocumentStore query rejected",
        "# WorldDocumentStore 查询未接受",
      ),
      "",
      ...result.diagnostics.map(
        ({ code, logicalPath, message }) =>
          `- ${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${message}`,
      ),
    ].join("\n"),
  };
}

function unexpectedSettingQueryResult(): never {
  throw new Error("WorldDocumentStore returned an incompatible query result");
}

function settingQueryArgumentError(
  message: string,
  locale: AppLocale,
): SettingQueryResult {
  return {
    ok: false,
    markdown: `${localized(locale, "# Runtime argument error", "# Runtime 参数错误")}\n\n${message}`,
  };
}

function settingQuerySuccess(markdown: string): SettingQueryResult {
  return { ok: true, markdown };
}

function hasOnlyArguments(
  args: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(args).every((key) => allowed.includes(key));
}

function validOptionalCursor(
  value: unknown,
): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function worldRevisionCommand(
  call: SettingAuthorToolCall,
  locale: AppLocale,
): WorldDocumentRevisionCommand {
  if (call.name === "setting_write_file")
    return {
      kind: "write",
      logicalPath: safePath(requiredString(call.arguments.path, "path")),
      contents: requiredString(call.arguments.contents, "contents"),
    };
  if (call.name === "setting_move")
    return {
      kind: "move",
      document: settingRevisionTarget(
        requiredString(call.arguments.from, "from"),
        locale,
      ),
      toLogicalPath: safePath(requiredString(call.arguments.to, "to")),
    };
  if (call.name === "setting_patch") {
    const target = settingRevisionTarget(
      requiredString(call.arguments.document, "document"),
      locale,
    );
    const op = requiredString(call.arguments.op, "op");
    if (op !== "add" && op !== "replace")
      throw new SettingModelError(
        "tool_argument_invalid",
        localized(
          locale,
          "Tool argument op must be add or replace",
          "工具参数 op 必须是 add 或 replace",
        ),
      );
    const locator = requiredStringArray(
      call.arguments.locator,
      "locator",
      false,
      locale,
    );
    return {
      kind: "patch",
      document: target,
      edits: [
        {
          op,
          locator: { yaml: [...locator] },
          value: structuredClone(
            call.arguments.value,
          ) as WorldDocumentRevisionYamlValue,
        },
      ],
    };
  }
  throw new SettingModelError(
    "tool_not_allowed",
    localized(
      locale,
      `Unsupported world-document revision tool: ${call.name}`,
      `不支持的世界文档 revision 工具：${call.name}`,
    ),
  );
}

function settingRevisionTarget(
  value: string,
  locale: AppLocale,
): WorldDocumentRevisionTarget {
  const selector = settingDocumentSelector(value);
  if (selector === null)
    throw new SettingModelError(
      "tool_argument_invalid",
      localized(
        locale,
        `Invalid world-document selector: ${value}`,
        `世界文档选择器无效：${value}`,
      ),
    );
  return selector;
}

function assertRevisionChangesAuthorized(
  snapshotId: string,
  reads: SettingReadAuthorizations,
  changes: readonly WorldDocumentRevisionChange[],
  locale: AppLocale,
): void {
  if (reads.snapshotId !== snapshotId)
    throw new Error(
      "World-document read authorization does not belong to the current candidate snapshot",
    );
  for (const change of changes) {
    if (
      change.before === null ||
      reads.worldDocumentIds.has(change.documentId) ||
      reads.damagedWorldPaths.has(change.before.logicalPath)
    )
      continue;
    throw new SettingModelError(
      "read_required",
      localized(
        locale,
        `Read @${change.shortRef} completely before changing it`,
        `修改 @${change.shortRef} 前必须先完整读取该文档`,
      ),
    );
  }
}

function staleSettingReadAuthorizationForTest(
  reads: SettingReadAuthorizations,
): void {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.NARRAEON_INTERNAL_TEST_STALE_SETTING_READ_AUTHORIZATION === "1"
  )
    reads.snapshotId = `${reads.snapshotId}:stale-test`;
}

function mergeWorldRevisionChanges(
  accumulated: Map<string, WorldDocumentRevisionChange>,
  changes: readonly WorldDocumentRevisionChange[],
): void {
  for (const change of changes) {
    const previous = accumulated.get(change.documentId);
    const combined: WorldDocumentRevisionChange = {
      ...change,
      before: previous === undefined ? change.before : previous.before,
    };
    if (
      combined.before !== null &&
      combined.before.logicalPath === combined.after.logicalPath &&
      combined.before.mechanicalHash === combined.after.mechanicalHash
    )
      accumulated.delete(change.documentId);
    else accumulated.set(change.documentId, combined);
  }
}

/**
 * Reports what one call did, not what the batch did.
 *
 * A batch lands atomically, but each tool call still asked its own question.
 * Echoing the entire batch verdict into every call repeated the whole list N
 * times in the transcript and never told any single call its own outcome.
 */
function renderSettingCallSuccess(
  changes: readonly WorldDocumentRevisionChange[],
  callIndex: number,
  locale: AppLocale,
): string {
  const mine = changes.filter(({ commandIndex }) => commandIndex === callIndex);
  const others = changes.length - mine.length;
  return [
    localized(
      locale,
      "# WorldDocumentStore revision accepted",
      "# WorldDocumentStore revision 已接受",
    ),
    "",
    ...(mine.length === 0
      ? [
          localized(
            locale,
            "- This call did not change any files",
            "- 本次调用没有改变任何文件",
          ),
        ]
      : mine.map((change) => describeSettingChange(change, locale))),
    ...(others === 0
      ? []
      : [
          "",
          localized(
            locale,
            `${others} other document(s) in the same batch were committed together.`,
            `同批次另有 ${others} 份文档一并提交。`,
          ),
        ]),
    "",
    localized(
      locale,
      "The candidate snapshot has been replaced. Old cursors are invalid; read authorizations are preserved, and changed documents count as read.",
      "候选快照已替换；旧 cursor 已失效，读取授权保留，改动过的文档视为已读。",
    ),
  ].join("\n");
}

function describeSettingChange(
  { shortRef, before, after }: WorldDocumentRevisionChange,
  locale: AppLocale,
): string {
  if (before === null)
    return localized(
      locale,
      `- Created @${shortRef} · ${after.logicalPath}`,
      `- 创建 @${shortRef} · ${after.logicalPath}`,
    );
  return before.logicalPath === after.logicalPath
    ? localized(
        locale,
        `- Updated @${shortRef} · ${after.logicalPath}`,
        `- 修改 @${shortRef} · ${after.logicalPath}`,
      )
    : localized(
        locale,
        `- Moved @${shortRef} · ${before.logicalPath} → ${after.logicalPath}`,
        `- 移动 @${shortRef} · ${before.logicalPath} → ${after.logicalPath}`,
      );
}

function renderSettingBatchRejected(
  calls: readonly SettingAuthorToolCall[],
  failureIndex: number,
  locale: AppLocale,
): string {
  const detail = calls[failureIndex];
  const target = detail === undefined ? null : settingCallTarget(detail);
  const named =
    detail === undefined
      ? ""
      : `${locale === "zh-CN" ? "：" : ": "}${detail.name}${target === null ? "" : ` · ${target}`}`;
  return localized(
    locale,
    `# Runtime tool rejected\n\nThis call was valid, but the batch did not take effect. Call ${failureIndex + 1} of ${calls.length}${named} was rejected; see that call's result for diagnostics.`,
    `# Runtime 工具拒绝\n\n本次调用本身没有问题，但整批未生效。被拒绝的是本批次第 ${failureIndex + 1} 个调用（共 ${calls.length} 个）${named}，诊断见该调用的结果。`,
  );
}

function renderSettingRevisionFailure(
  diagnostics: readonly {
    commandIndex: number | null;
    code: string;
    logicalPath?: string;
    message: string;
  }[],
): string {
  return [
    "WorldDocumentStore revision was rejected:",
    ...diagnostics.map(
      ({ commandIndex, code, logicalPath, message }) =>
        `[${commandIndex ?? "batch"}] ${code}${logicalPath === undefined ? "" : ` · ${logicalPath}`} · ${message}`,
    ),
  ].join("\n");
}

function executeTool(
  snapshot: WorldDocumentStore,
  call: SettingAuthorToolCall,
  reads: SettingReadAuthorizations,
  locale: AppLocale,
): SettingToolResult {
  if (call.name === "setting_list")
    return {
      snapshot,
      ...listSettingDocuments(snapshot, call.arguments, locale),
    };
  if (call.name === "setting_search")
    return {
      snapshot,
      ...searchSettingDocuments(snapshot, call.arguments, locale),
    };
  if (call.name === "setting_read")
    return {
      snapshot,
      ...readSettingDocument(snapshot, call.arguments, reads, locale),
    };
  if (call.name === "setting_write_file") {
    const path = safePath(requiredString(call.arguments.path, "path"));
    if (path !== "opening.md" && !writableControlPath(path))
      throw new SettingModelError(
        "tool_argument_invalid",
        localized(
          locale,
          "setting_write_file path accepts only .yaml or .md documents under world/, control/frame.yaml, control/player-views.yaml, control/blocks/*.md, or the root opening.md",
          "setting_write_file 的 path 只接受 world/ 下的 .yaml 或 .md 文档、control/frame.yaml、control/player-views.yaml、control/blocks/*.md 或根级 opening.md",
        ),
      );
    const contents = requiredString(call.arguments.contents, "contents");
    const next = cloneFiles(snapshot.files);
    const existing = next.find((candidate) => candidate.path === path);
    if (
      path === "opening.md" &&
      existing !== undefined &&
      !reads.opaquePaths.has(path)
    )
      throw new SettingModelError(
        "read_required",
        localized(
          locale,
          "Read opening.md in full before updating the existing opening text",
          "更新既有开场白前必须完整读取 opening.md",
        ),
      );
    if (existing === undefined) next.push({ path, contents });
    else {
      existing.contents = contents;
      delete existing.encoding;
    }
    return changedSnapshot(
      snapshot,
      reads,
      sorted(next),
      path,
      localized(
        locale,
        `${existing === undefined ? "Created" : "Updated"} ${path} in the isolated candidate`,
        `已在隔离候选${existing === undefined ? "创建" : "写入"} ${path}`,
      ),
    );
  }
  throw new SettingModelError(
    "tool_not_allowed",
    localized(
      locale,
      `Unsupported setting-improvement tool: ${call.name}`,
      `不支持的设定完善工具：${call.name}`,
    ),
  );
}

function assertVisiblePlan(markdown: string, locale: AppLocale): void {
  const firstHeading = firstMarkdownLevelOneHeading(markdown);
  const expectedHeading = locale === "zh-CN" ? "创作计划" : "Creation plan";
  if (markdown.trim().length < 40 || !firstHeading?.startsWith(expectedHeading))
    throw new SettingModelError(
      "plan_invalid",
      locale === "zh-CN"
        ? "创作计划的首个围栏外一级标题必须以“创作计划”开头，且可见 Markdown 不得少于 40 字"
        : 'The first level-one heading outside a code fence must begin with "Creation plan", and the visible Markdown must contain at least 40 characters',
    );
}

function requiredAuthorPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0)
    throw new Error("The setting-improvement author prompt cannot be empty");
  return trimmed;
}

function settingAuthorSystemPrompt(
  authorPrompt: string,
  locale: AppLocale,
): string {
  // The editable author semantics come first. The non-editable Runtime/tool
  // contract is deliberately appended afterwards so a portable preset cannot
  // replace the actual authority, tool descriptions or settlement protocol.
  return `${authorPrompt}\n\n---\n\n${
    locale === "zh-CN"
      ? settingAuthorRuntimeContractZhCN
      : settingAuthorRuntimeContractEn
  }`;
}

function publicMessages(
  messages: SettingAuthorMessage[],
): SettingAuthorMessage[] {
  return structuredClone(messages);
}

function safePath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === ".." || part === "." || part.length === 0)
  )
    throw new SettingModelError(
      "tool_argument_invalid",
      `Unsafe candidate path: ${path}`,
    );
  return path;
}

function safeInputPath(path: string): string {
  try {
    return safePath(path);
  } catch (error: unknown) {
    if (error instanceof SettingModelError)
      throw new Error(error.message, { cause: error });
    throw error;
  }
}

function requiredFeedback(feedback: string): string {
  const trimmed = feedback.trim();
  if (trimmed.length === 0)
    throw new Error("Revision feedback cannot be empty");
  return trimmed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SettingModelError(
      "tool_argument_invalid",
      `Tool argument ${name} must be a non-empty string`,
    );
  return value;
}

function requiredStringArray(
  value: unknown,
  name: string,
  allowEmpty = true,
  locale: AppLocale = defaultAppLocale,
): string[] {
  if (!Array.isArray(value))
    throw new SettingModelError(
      "tool_argument_invalid",
      `Tool argument ${name} must be an array of strings`,
    );
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0)
      throw new SettingModelError(
        "tool_argument_invalid",
        localized(
          locale,
          `Tool argument ${name} must be an array of strings`,
          `工具参数 ${name} 必须是字符串数组`,
        ),
      );
    result.push(item);
  }
  if (!allowEmpty && result.length === 0)
    throw new SettingModelError(
      "tool_argument_invalid",
      localized(
        locale,
        `Tool argument ${name} must be a non-empty array of strings`,
        `工具参数 ${name} 必须是非空字符串数组`,
      ),
    );
  return result;
}

function firstMarkdownLevelOneHeading(markdown: string): string | null {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split(/\r?\n/u)) {
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fenceMatch !== null) {
      const run = fenceMatch[1]!;
      const marker = run[0] as "`" | "~";
      if (fence === null) {
        fence = { marker, length: run.length };
        continue;
      }
      if (
        marker === fence.marker &&
        run.length >= fence.length &&
        fenceMatch[2]!.trim() === ""
      )
        fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^[ \t]{0,3}#[ \t]+(.+?)\s*$/u.exec(line);
    if (heading !== null)
      return heading[1]!.replace(/[ \t]+#+[ \t]*$/u, "").trimEnd();
  }
  return null;
}

function settingToolFailure(
  snapshot: WorldDocumentStore,
  message: string,
  locale: AppLocale,
): SettingToolResult {
  return {
    ok: false,
    snapshot,
    markdown: `${localized(locale, "# Runtime tool rejected", "# Runtime 工具拒绝")}\n\n${message}`,
  };
}

function renderSettingRepair(message: string, locale: AppLocale): string {
  return `${localized(locale, "# Runtime repair required", "# Runtime 修复要求")}\n\n${message}`;
}

function idleSettingProgress(): SettingImprovementProgress {
  return {
    phase: "idle",
    round: 0,
    maxRounds: 64,
    toolCalls: 0,
    repairs: 0,
    failedChecks: 0,
    usage: emptyAggregatedModelUsage(),
    writing: null,
    recentActions: [],
    lastCheck: null,
    failure: null,
    streaming: null,
    updatedAt: 0,
  };
}

export function createSettingImprovementStartingProgress(
  mode: SettingImprovementStartInput["mode"],
): SettingImprovementProgress {
  return {
    ...idleSettingProgress(),
    phase: mode === "plan_first" ? "planning" : "generating",
    updatedAt: Date.now(),
  };
}

// The check renders as a Markdown report; the panel only has room for the
// diagnostic lines, which are the bullet list under the heading.
function summarizeSettingCheck(markdown: string): string {
  const bullets = markdown
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  return bullets.length === 0
    ? markdown.split(/\r?\n/u)[0]!.replace(/^#+\s*/u, "")
    : bullets.join("; ");
}

// The one argument worth showing per call: what the author is acting on.
function settingCallTarget(call: SettingAuthorToolCall): string | null {
  for (const key of ["path", "document", "from", "directory", "query"]) {
    const value = call.arguments[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function nextRepairCount(current: number, phase: "plan" | "candidate"): number {
  const next = current + 1;
  if (next > 8)
    throw new Error(
      `The setting-improvement ${phase} phase exceeded its repair limit`,
    );
  return next;
}

// A candidate that fails its own inspection is this system working as designed:
// inspect, repair, inspect again. It gets its own, looser budget so that honest
// iteration cannot exhaust the allowance meant for protocol errors.
function nextFailedCheckCount(current: number): number {
  const next = current + 1;
  if (next > 16)
    throw new Error("The setting-improvement candidate failed too many checks");
  return next;
}

function localized(
  locale: AppLocale,
  english: string,
  chinese: string,
): string {
  return locale === "zh-CN" ? chinese : english;
}

function candidateDiffs(
  baseFiles: readonly ContentTreeFile[],
  candidateFiles: readonly ContentTreeFile[],
  worldChanges: ReadonlyMap<string, WorldDocumentRevisionChange>,
): SettingCandidateDiff[] {
  const worldDiffs = [...worldChanges.values()].flatMap(
    ({ before, after }): SettingCandidateDiff[] => {
      if (before === null)
        return [
          {
            path: after.logicalPath,
            kind: "create",
            before: null,
            after: after.contents,
          },
        ];
      if (before.logicalPath === after.logicalPath)
        return [
          {
            path: after.logicalPath,
            kind: "modify",
            before: before.contents,
            after: after.contents,
          },
        ];
      return [
        {
          path: before.logicalPath,
          kind: "delete",
          before: before.contents,
          after: null,
        },
        {
          path: after.logicalPath,
          kind: "create",
          before: null,
          after: after.contents,
        },
      ];
    },
  );
  const left = new Map(
    baseFiles
      .filter(({ path }) => !path.startsWith("world/"))
      .map((file) => [file.path, file]),
  );
  const right = new Map(
    candidateFiles
      .filter(({ path }) => !path.startsWith("world/"))
      .map((file) => [file.path, file]),
  );
  const opaqueDiffs = [...new Set([...left.keys(), ...right.keys()])].flatMap(
    (path): SettingCandidateDiff[] => {
      const before = left.get(path) ?? null;
      const after = right.get(path) ?? null;
      if (
        before?.contents === after?.contents &&
        before?.encoding === after?.encoding
      )
        return [];
      return [
        {
          path,
          kind:
            before === null ? "create" : after === null ? "delete" : "modify",
          before: before?.contents ?? null,
          after: after?.contents ?? null,
        },
      ];
    },
  );
  return [...worldDiffs, ...opaqueDiffs].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function cloneFiles(files: readonly ContentTreeFile[]): ContentTreeFile[] {
  return files.map((file) => structuredClone(file));
}

function sorted(files: ContentTreeFile[]): ContentTreeFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
