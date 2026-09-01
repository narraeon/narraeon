# 内容包设定创作教程

这份教程说明怎样把“我想玩什么”写成可直接复制为世界状态、又适合 AI 阅读和局部更新的 YAML／Markdown 内容包。手工编辑与 AI 设定完善使用同一种文件树；不存在七字段 JSON、世界数据 schema、初始记录或另一套只给 Runtime 的内容格式。

## 1. 先确定玩家反复获得什么体验

不要从“要建几个 schema”或“要有几张人物表”开始。先回答：

| 维度       | 要回答的问题                                             |
| ---------- | -------------------------------------------------------- |
| 主要体验   | 玩家最主要来谈恋爱、调查、探索、生存、经营，还是做别的？ |
| 次要体验   | 哪些内容只负责丰富主体验，不能喧宾夺主？                 |
| 反复循环   | 玩家会反复做什么，并从世界得到什么反馈？                 |
| 焦点       | 人物、关系、规则、地点、资源、线索或战斗各有多重要？     |
| 节奏       | 日常慢热、事件推进、章节调查，还是交替进行？             |
| 冲突       | 性格、身份、资源、阵营、信息差或外部威胁怎样产生压力？   |
| 信息结构   | 哪些是背景，哪些要通过行动逐步发现？                     |
| 语气与边界 | 希望轻松、克制、残酷或喜剧；明确不要什么？               |
| 混合方式   | 两种体验怎样彼此改变，而不是素材并排堆放？               |

例如“以人物性格和关系变化为主的校园恋爱，不要侦探故事”，就应优先写能反复驱动交谈、边界、误会和关系反馈的角色与场合；不能因为校园里“可以有秘密”就擅自建立案件、线索和幕后组织。

这些答案决定需要哪些自然文档和主持政策，但不需要先承诺某套固定数据类型。

## 2. 只有内容包里叫设定

推荐目录：

```text
content-package/
  opening.md
  world/
    situation/current.yaml
    characters/qinlong.yaml
    characters/qiming.yaml
    locations/dormitory-302.yaml
    rules/cultivation.md
    rules/favorability.md
  control/
    prompt/frame.yaml
    prompt/blocks/world-style.md
    prompt/blocks/state-maintenance.md
    player-views.yaml
```

在内容包中，`opening.md`、`world` 与 `control` 都属于设定：

- `opening.md` 保存玩家进入新世界后、首次行动前立即看到的主持原文；
- `world` 保存这个模板出生时就成立的全部虚构内容和当前取值；
- `control` 保存怎样主持、拼装和显示，不保存虚构实际值。

创建世界时，Runtime 机械复制：

```text
content-package/world/*   -> world/state/*
content-package/control/* -> world/control/*
content-package/opening.md -> world/history 的 genesis 第一条主持原文
```

复制后不再有“世界设定”。同一份 `qinlong.yaml` 直接成为秦龙的当前状态，之后由游玩 AI patch；源内容包和世界互不同步。

因此人物文件直接写：

```yaml
衣着: 白色运动背心，运动短裤，拖鞋
修为: 金丹初期
```

不要写 `初始衣着`、`initialState`，也不要再创建一份 record 等待 Runtime 物化。`opening.md` 是唯一专门描述玩家如何进入行动的根级叙事文件，不是另一份状态 seed 或 genesis DTO；Runtime 把它与完整复制结果一起作为世界初始权威端点发布。

### 写好 `opening.md`

每个可用内容包必须有且只有一份根级 `opening.md`。它是普通 UTF-8 Markdown 原文，不带 `$document` 头，不能为空，最大 64 KiB。例如：

```markdown
雨水沿着廊檐砸在你脚边。紧闭的药铺门内传来第二声撞击，街角巡夜人的灯正朝这里靠近。你只有片刻决定如何回应。
```

开场白应做到：

- 只写玩家此刻立即可见、可听或可感知的局面；
- 与当前情境及自然所有者中已经成立的事实一致；
- 给出具体压力、人物反应或行动钩子，并在玩家可以回应的位置停下；
- 不替玩家移动、说话、选择或下内心结论；
- 不写 Runtime、文件、工具或“请开始游戏”等界面说明。

创建世界时，Runtime 会逐字把它写成第一条已提交 narrator 历史消息。它不会伪造一条玩家“开始游戏”，也不会让模型临场改写；生产游玩的全新上下文也不会把玩家已经看到的 genesis 再发给模型。之后修改源内容包的开场白不会改变既有世界；从旧端点创建分叉时继承现有历史，不再增加第二份开场白。

## 3. 一份文档承担一个自然职责

默认选择：

- 人物、地点、当前情境、轻量关键物品等开放结构用受限 YAML；
- 世界规则、文化、长背景和提示政策用 Markdown；
- 一份文件对应一个自然所有者、独立生命周期或独立长篇主题；
- 不把“秦龙”拆成“秦龙.身高”“秦龙.衣着”“秦龙.性格”三个文件；
- 也不把所有人物、地点、物品塞进一份巨型世界 JSON。

YAML 让 AI 能按路径更新一小块，Markdown 让长篇语义保持自然可读。Runtime 会把两者确定性渲染成 Markdown 发送给模型；模型不会看到 JSON 转义后的 YAML，也不会看到内部版本和 material DTO。

## 4. 最小文档身份

每份可引用 YAML 文档都带 `$document`：

```yaml
$document:
  id: character.qinlong
  ref: qinlong
  title: 秦龙
  summary: 篮球队前锋，直率护短，不擅长把担心说得好听。
  aliases: [老秦]

身高: 186 厘米
体重: 82 公斤
性格: 直率，护短，不擅长解释自己的担心
衣着: 白色运动背心，运动短裤，拖鞋
修为: 金丹初期
```

Markdown 文档使用同样的身份头：

```markdown
---
$document:
  id: rule.cultivation
  ref: cultivation
  title: 修炼境界
  summary: 解释炼气、筑基、金丹、元婴的顺序、含义和突破原则。
  aliases: [境界规则]
---

# 修炼境界

境界顺序：炼气 → 筑基 → 金丹 → 元婴。

## 金丹

修士凝聚稳定金丹，灵力容量和控制远高于筑基，但仍受肉身与心境限制。

## 元婴

修士孕化元婴，神识与生命形态发生质变；通常不能只靠普通数量优势跨越。

## 突破原则

突破需要灵力、心境与契机共同成熟，不是经验值达到阈值就自动发生。
```

五项职责：

- `id`：世界内不可变身份；复制和创建分叉时保留；
- `ref`：模型工具使用的稳定短句柄，例如 `@qinlong`；
- `title`：可修改、可重名的人类显示名称；
- `summary`：1～240 字符的一句话稳定简介，不是当前状态摘要；
- `aliases`：改名、外号或检索别名。

Runtime 路径、hash、内部 version、operation 和宿主 ID 不写进这里，也不发送给模型。改名只改 `title`／aliases，不改 `id`／`ref`。

## 5. 裸文字与机械引用必须分开

只有下面的单键 map 是机械文档引用：

```yaml
人物:
  - $ref: character.qiming
  - $ref: character.qinlong
地点:
  $ref: location.dormitory-302
```

以下都只是文字：

```yaml
地点: 男生宿舍 302
暗号: location.dormitory-302
提到的人: 秦龙
工具提示: "@qinlong"
```

使用原则：

- 需要稳定身份、跨文档完整性或精确读取时才用 `$ref`；
- 自然语言关系不必为了“结构化”强行升级成引用；
- `$ref` 只指整份文档，不指 YAML 子路径或 Markdown 标题；
- 局部选择用文档 ID 加 locator；Runtime 不沿 `$ref` 自动展开；
- 持久化 locator 不使用列表下标，容易长期选择的条目改用 map key 或独立文档。

例如秦龙自己的关系可以这样写：

```yaml
关系:
  启铭:
    对象:
      $ref: character.qiming
    看法: 可靠的队友和朋友；谈到家事时仍有所保留
    好感度: 70
  赵虎:
    对象:
      $ref: character.zhaohu
    看法: 相处轻松，但不愿让他介入宗门旧事
```

启铭对秦龙的看法写在启铭自己的文档中。两边可以不同；Runtime 不镜像、不创建关系 record，也不猜 `关系` 这个字段的特殊含义。

## 6. 不再设计世界数据 schema

好感度、修为、关系、职业、伤势和声望都只是作者与 AI 理解的世界内容。Runtime 不校验：

- 字段类型与必填项；
- 枚举、范围和受控词表；
- 等级顺序和状态转换；
- 基数、唯一键和主体策略；
- 哪个字段允许 AI 更新。

需要共同含义时写一份自然语言规则。例如：

```markdown
---
$document:
  id: rule.favorability
  ref: favorability
  title: 好感度参考
  summary: 为人物关系中的好感度提供常规解释，不限制可保存值。
  aliases: [关系刻度]
---

# 好感度参考

常规参考刻度为 0～100：超过 50 通常算熟人，60 左右算朋友，70 左右可称兄弟，100 表示极深的关系。

刻度是主持参考，不是世界物理上限。超过 100 可以表示超出常规刻度的特殊关系，必须结合具体叙事解释。
```

如果 AI 写出 `好感度: 150`，Runtime 原样保存和显示。AI 可以在后续普通对话中认为它不符合剧情并继续修改隔离草稿，但不能把这种语义意见伪装成格式错误。

“金丹”和“元婴”的顺序同理：人物只写当前修为，模型通过 `cultivation.md` 理解含义。将来若确实需要可计算的战斗或突破系统，应单独设计确定性玩法模块，而不是恢复一套包罗万象的世界 schema。

## 7. 当前情境只承接短期跨对象局面

每个内容包必须提供一份当前情境文档；字段由世界自己决定：

```yaml
$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 承接没有单一自然所有者的正在进行局面与临时环境。
  aliases: []

地点: 男生宿舍 302
人物:
  - $ref: character.qiming
  - $ref: character.qinlong
  - $ref: character.zhaohu
情况:
  - 启铭正在追问秦龙以前答应过的事情
  - 秦龙刚接过启铭递来的背心，但还没有穿上
  - 宿舍闷热，房门开着
```

Runtime 只知道控制文件把 `situation.current` 绑定为当前情境；它不解析内部的地点、人物或情况，也不从中判断谁“在场”。作者必须在状态维护政策中告诉 AI 怎样理解、清理和提升内容。

当前情境不是状态汇总：

- 秦龙脱掉上衣，应把人物文档改成 `衣着: 光膀子，运动短裤，拖鞋`；
- 三人仍在争论，可以同时留在当前情境；
- 已经结束且不再约束后续的普通动作，只留在已提交叙事；
- 长期承诺、伤势或关系变化写入自然所有者，而不是永远堆进“情况”。

## 8. 物品只追踪到够用

普通上衣搭在椅背通常不值得建文档。下一次行动从床上、衣架、衣柜甚至地上拿起一件衣服都不违和；真正需要保持的是秦龙当前光膀子，避免重复脱衣。

重要物品可以先嵌入人物：

```yaml
重要物品:
  校际赛冠军奖杯:
    意义: 秦龙第一次获得的重要比赛荣誉
  启铭赠送的球衣和球鞋:
    意义: 两人友谊的象征
```

只有奖杯被盗、球鞋转赠或某件物品的能力进入玩法，需要独立引用、归属和生命周期时，才创建独立文档。独立以后也只记录现在真正需要的字段，不自动扩展重量、耐久、精确坐标和所有历史持有者。

## 9. 世界提示框架

`control/frame.yaml` 的 V1 形状：

```yaml
format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world-style.md
  - markdown: blocks/state-maintenance.md
context:
  - slot:
      kind: catalog
      directory: characters
      maxEntries: 24
  - slot:
      kind: current_situation
  - slot:
      kind: reference_targets
      from:
        document: situation.current
        locator:
          yaml: [人物]
      maxEntries: 12
      required: false
  - slot:
      kind: additional_materials
```

必须恰好有一个 `current_situation` 和一个 `additional_materials`。其他 slot 只能确定性选择：

- 精确整份文档；
- 精确 YAML／Markdown 节点；
- 精确 YAML 节点中显式 `$ref` 的一层目标；
- 精确目录的有界 catalog；
- 精确历史消息；
- 当前端点的附加材料清单。

不能写“与秦龙有敌意的人”“跟玩家行动相关的规则”“最近一万 token 历史”等语义 query。Runtime 没有能力判断这些概念；需要临时资料时由游玩 AI 使用 list、字面 search 和精确 read。

世界框架只保存主持政策和材料位置，不能直接写“当前在宿舍”“秦龙光膀子”等实际值。实际值只能从 `world`／复制后的 `state` slot 读取。

`instructions` 和 `context` 都按数组从上到下拼进真实提示词。语义允许时，较稳定的主持规则、文档和目录索引放在前面；频繁变化的当前情境与当前附加材料放在后面。移动 slot 只改变注入顺序，不会推断“相关材料”。如果固定 `document` 与 `reference_targets` 等 slot 恰好选择了同一整份文档，编译器保留第一次出现的位置并只注入一次；这只合并提示材料，不会改变当前情境中的在场引用或其他世界状态。整份文档与其中节点等范围重叠仍会被拒绝。

catalog 的 `directory` 是相对于 `world/`／`state/` 的真实目录路径，并且只匹配该目录的直接子文档。例如候选中的 `world/states/qinming.yaml` 会在创建世界时成为 `state/states/qinming.yaml`，两者都能与 `directory: states` 对应；根级文件 `world/state.qinming.yaml` 不能对应，因为文件名里的点不是目录分隔符。更深的 `world/states/group/qinming.yaml` 需要 `directory: states/group`。

catalog 默认必需且必须至少关联一份直接子文档。只有新建内容包中尚待填充的目录等明确可为空的占位，才写 `required: false`。catalog 只注入 title、summary 和 `@ref` 索引；整份正文使用 `document` slot，局部正文使用 `node` slot。

### 世界文风块

`control/blocks/world-style.md` 可以写：

```markdown
# 本世界的发展方式

以人物关系、训练和校园日常为主。冲突优先来自性格与承诺，不主动升级为阴谋调查。

叙事保持自然口语和具体动作，不替玩家角色决定未声明的台词、行动或内心。
```

### 状态维护块

`control/blocks/state-maintenance.md` 可以写：

```markdown
# 状态维护政策

先判断忘记某项信息是否会让玩家明显出戏或改变重要选择。

- 短期跨对象局面写入当前情境；场景结束后及时清理。
- 人物衣着、伤势、修为、长期承诺和重要认知写回人物。
- 普通环境物件可以遗忘；关键物件先记录存在、归属和意义，需要独立追踪时再创建文档。
- 不为所有见闻建立认知记录，不为每件物品建立完整档案。
```

内容包 AI 可以修改这些作者资产。创建世界后，玩家只能通过世界外控制编辑、真实 Prompt Preview 和明确应用来修改；正在裁决剧情的 AI 不能自改框架。

## 10. 玩家视图使用精确选择器

`control/player-views.yaml` 示例：

```yaml
format: narraeon.player-views/v1
views:
  - id: player-status
    title: 当前状态
    items:
      - id: qinlong-clothes
        label: 秦龙衣着
        select:
          document: character.qinlong
          locator:
            yaml: [衣着]
      - id: qinlong-relationships
        label: 秦龙关系
        select:
          document: character.qinlong
          locator:
            yaml: [关系]
      - id: jindan-rule
        label: 金丹
        select:
          document: rule.cultivation
          locator:
            markdown: [金丹]
```

选择 scalar 就显示原值；选择 map／list 就递归显示选中子树；选择 Markdown 标题就显示完整标题子树。`$ref` 只显示目标标题和短引用链接，不自动展开。

选择器不表达权限、秘密、角色认知或条件逻辑。节点不存在时 UI 略过并在作者诊断中报告 unresolved；Runtime 不伪造默认值，也不模糊迁移改名后的 key／标题。

## 11. AI 设定完善怎样工作

AI 设定完善只编辑内容包，不修改已经创建世界的当前状态、已提交叙事或人物认知。一次会话维护：

1. 用户与 AI 的 append-only 创作对话；
2. 从固定内容包当前树取得、可持续修订的隔离草稿；
3. 会话开始时冻结的玩法预设 revision，以及其中实际启用的主持／叙事语义只读参考；
4. 每个精确草稿版本的真实 Prompt Preview、机械诊断、完整差异和草稿游玩读取覆盖；
5. 完整模型响应、Provider 原生续传、失败与应用结果。

流程：

1. 用户像普通对话一样直接说明当前想做什么；内容包正文不预先塞入消息，AI 通过固定工具从隔离草稿按需读取。固定提示先说明内容包会怎样成为独立的世界 state／control／genesis、未来游玩怎样读取和更新它，并给出冻结预设实际启用的主持／叙事规则作为只读创作参考。
2. AI 从第一条消息开始就可以 list／search／read／write／patch／move 隔离草稿，并根据用户消息决定讨论、提问或修改；“先讨论计划”只是普通用户要求，不是 Runtime 阶段。
3. 修改前先完整读取既有文件；涉及结构、发现路径或未来更新位置时，还要先读 frame、它引用的世界指令、绑定的当前情境与开场白。由 AI 创建或已经成功修改过的完整文件视为已读。
4. 一个完整模型响应中的全部写工具形成一个原子草稿修订，任一写调用失败则整批不生效；不完整 Provider 响应不执行工具。
5. 开场白缺失时创建；开局地点、人物、局面、语气或行动钩子变化时，完整读取后更新；不受影响时保留。
6. 小修改用 YAML 路径 patch；Markdown 通过完整文件重写；新增自然对象才创建新文档。
7. 每次草稿修订后，Runtime 自动检查开场白、文件安全、身份、引用、控制格式、必需当前情境、持久 selector 和真实 Prompt Preview，并把改动材料在全新游玩中属于全文／节点注入、目录摘要、直接引用还是仅按需发现，以及控制块是否真正启用的确定性覆盖反馈给 AI；上下文是否可容纳请求由 Provider 判断。
8. 模型返回无工具调用的完整回复时，本轮普通对话结束；草稿仍可继续修订，不需要预览或终态工具。
9. 用户只能应用一个无生成进行、精确版本匹配、检查通过且基础树未变化的草稿版本；否则继续对话修订或整批放弃。

Runtime 不检查人物字段是否完整、好感度是否在范围内、金丹是否比元婴低或某段设定是否有趣。这些是创作审阅和真实模型评测的责任。

AI 修改文件前必须先读完整目标；`replace` 只改已存在路径，`add` 只加不存在的 key，`remove` 只删已存在路径。这样把“衣着”误写成“穿着”不会静默留下两个相似字段；真正扩展人物时再显式 `add`。

候选应用是整批替换，不做静默 merge、rebase 或部分勾选。创作期间若另有编辑改变了内容包当前树，本次应用必须拒绝并保留隔离草稿；当前版本不承诺自动合并。

## 12. 实用创作顺序

1. 用一两句话写清主要体验、次要体验和不要出现的方向。
2. 列出反复游玩循环，以及每个循环最需要稳定的自然对象与规则。
3. 创建最小 `world` 树：当前情境、必要人物／地点和少量长规则。
4. 写 `opening.md`，让玩家一进入世界就面对与当前情境一致的可行动局面。
5. 让人物直接带衣着、性格、修为、关系和出生时取值，不建初始 record。
6. 用自然语言规则解释模型可能误解的专属概念，不用 enum／range 约束 Runtime。
7. 检查哪些普通物品可以忘记，哪些只需嵌入，哪些必须独立。
8. 写世界文风与状态维护政策，再用精确 slot 组织材料。
9. 只为确实需要常驻显示的原值添加玩家视图 selector。
10. 运行真实 Prompt Preview，确认开场白不进入模型上下文、玩家预览原文只作为一条普通 user 追加、role 正确。
11. 审阅完整文件差异后整批确认。

## 13. 最终检查表

体验与连续性：

- [ ] 主要体验明确，次要内容没有抢走主循环。
- [ ] 明确哪些事情忘记会出戏，哪些普通细节可以合理补全。
- [ ] 当前情境只承接短期跨对象局面，不充当完整状态摘要。
- [ ] 人物衣着、修为、长期关系和重要认知写回自然所有者。
- [ ] 普通物品没有被过度实体化，关键道具只追踪够用字段。

文件与引用：

- [ ] 根级 `opening.md` 唯一、非空、可行动，不替玩家做决定，并与初始当前情境一致。
- [ ] 内容只有受限 `.yaml`／`.md`，不存在七字段 JSON、schema 或初始 record。
- [ ] 每份可引用文档都有唯一稳定 `id`／`ref` 和有意义的标题／简介。
- [ ] 裸字符串没有被误当引用；需要机械关联时显式使用单键 `$ref`。
- [ ] 持久 locator 不使用 list index、wildcard、filter 或语义 query。
- [ ] 长篇规则使用 Markdown，开放可变状态使用自然 YAML 文档。

提示与界面：

- [ ] 世界框架恰有一个当前情境 slot 和一个附加材料 slot。
- [ ] 世界实际值没有重复写进 frame 或提示块。
- [ ] 状态维护政策明确告诉 AI 怎样保存、提升、清理和按重要性取舍。
- [ ] 玩家视图只用精确 selector；未显示没有被误写成秘密或权限。
- [ ] 真实生产 Prompt Preview 不把开场白注入模型上下文，只把预览玩家原文列为一条普通 user 追加，且没有内部 ID／version／DTO 泄漏或材料重复。

应用：

- [ ] AI 已检查开场白，并完整读取要更新的既有开场白和其他目标文件；小改使用局部 patch。
- [ ] 候选通过文件、身份、引用、控制和预算检查。
- [ ] 已审阅完整差异与最终模型 Markdown，不只看一句 AI 摘要。
- [ ] 接受整批替换语义；不接受时继续修订或整批放弃。
