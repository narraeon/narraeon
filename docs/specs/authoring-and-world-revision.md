# 内容包创作、主角模板、设定完善与世界修订规格

本规格定义内容包持久形状与便携交换、创建世界时的应用级主角模板定制、内容包设定完善会话与当前树事务，以及运行中世界的世界修订工作区与跨 epoch 会话，对应代码模块 `src/runtime/content/`、`src/runtime/setting/`、`src/runtime/world-revision/`、`src/runtime/authoring/` 与 `src/runtime/config/`，并承接 [ADR-0029](../adr/0029-author-prompt-layers-split-by-capability.md)、[ADR-0034](../adr/0034-released-storage-formats-require-atomic-migrations.md)、[ADR-0037](../adr/0037-setting-improvement-is-one-model-directed-conversation.md)、[ADR-0038](../adr/0038-world-revision-uses-one-locked-worktree.md) 与 [ADR-0045](../adr/0045-world-history-is-current-files-plus-a-turn-ledger.md)。

## 1. 内容包本地身份、便携 ZIP 与新建脚手架

### 1.1 持久形状与独立标题

- 内容包以**本地身份**、**独立标题**与**当前文件树**（最少包含 `opening.md`、`world/`、`control/`）为完整持久形状，不另设业务 manifest、安装身份、content digest 或包级历史版本。
- 导入、复制与新建一律分配新的本地身份，同标题变体可并存。独立标题保存在 Runtime 拥有的本地外壳中，绝不从 `current-situation` 或其他文档的 `$document.title` 动态推导；新建取得本地化默认标题，复制保留来源标题，浏览器导入以 ZIP 文件名为初始标题，之后均可独立重命名而不修改当前树。
- 升级前尚无独立标题的旧包在第一次读取时持有包级互斥权，将旧显示值原子固化到本地外壳。
- 手动编辑以浏览器未保存缓冲区整批替换当前树；AI 设定完善直接面向当前树逐响应原子发布，不维护第二棵持久草稿树。

### 1.2 便携 ZIP 与安全校验

- 导入与导出使用同一种便携 ZIP：浏览器上传 ZIP 内容，不提交本机目录路径；便携包**只携带业务文件**，不携带本地身份、标题、机器路径、来源身份、发布身份或历史版本；导出文件名仅将本地标题用作外部标签。
- 导入依次校验路径安全、资源限制、UTF-8 文本编码、文档身份、显式引用、控制格式与必需绑定：危险输入直接拒绝；安全但尚不完整的内容保存为**待修复包**（可继续编辑，但禁止用于创建世界或导出）。

### 1.3 新建包脚手架、第一方示例与玩法文件

- **新建包默认三份 YAML 结构边界**（按 [ADR-0029](../adr/0029-author-prompt-layers-split-by-capability.md) 仅约束结构与发现位置，不锁死具体提示正文或保存时机文案）：正常新建与第一方示例新建的中英文内容包均预置「重要事件」「人物关系」「未了事项」三份普通 YAML 文档。重要事件按稳定事件键组织、人物关系按稳定人物键组织，默认以 `catalog` 目录摘要提供并按需精读；未了事项与当前情境直接进入游玩材料。已有内容包与世界不自动迁移。
- **第一方示例（`content.create-sample`）**：首次启动空内容包区提供「从示例开始」，新建内容包旁始终提供「从示例新建」。`content.create-sample` 接受明确语言参数 `en` 或 `zh-CN`，将随应用发布的雨夜旅店普通文件树与示例标题复制为拥有新本地身份的普通内容包，随后打开新建世界页。每次复制均完全独立，不随应用升级或界面语言切换同步；复制与展示开场不调用模型，无模型连接时提示配置入口。
- **玩法文件校验**：`control/gameplay.json`（`narraeon.gameplay/v1`）缺失即为互动式小说。内容包创建时选定玩法模式（互动式小说／跑团）后不可切换；跑团包的判定方案（`d20`、`d100`、`bag`）可在内容包玩法区域或经设定完善 AI 改写。导入、复制与导出均保留玩法；试图切换模式或写入非法方案的保存与工具调用均被拒绝。

### 1.4 SillyTavern 内容迁移

- 支持 SillyTavern V1／V2／V3 共有字段的 JSON／PNG 角色卡、独立世界书 JSON 与卡内世界书。
- 导入向导提供独立目录／详情浏览与勾选交互（转换结果可返回来源修改），由作者逐项映射为角色文档、当前情境、开场白、世界控制参考或惰性迁移附件，并总是创建新的独立内容包。
- 世界书关键词、概率、递归、冷却与插入位置不成为 Narraeon 执行规则；禁用条目、未绑定宏与不等价提示位置不自动成为世界事实或指令；缺少开场或当前情境可保存为待完善态（修复前不可创建世界）；头像、外部世界书、脚本与远程资源不执行、不自动下载；惰性附件不进入世界索引或提示编译。

## 2. 创建世界时的应用级主角模板选择与定制契约

Narraeon 不为内容包增设主角绑定字段或人物字段 schema，而是通过**应用级主角模板 + 显式世界修订**支持跨世界复用主角设定：

- **应用级存储**：保存在配置根 `protagonist-templates-v1.json`（`schemaVersion: 1`），由 `ProtagonistTemplateStore` 串行读写并原子 `rename` 持久化。每条模板包含 `id`、1–80 字符单行 `name`、1–16 KiB Markdown `body` 与 `updatedAt`。提供 Runtime 命令 `protagonist-templates.read`、`protagonist-templates.save`、`protagonist-templates.copy`、`protagonist-templates.delete`；模板归工作区本机所有，不进入内容包便携 ZIP 或世界 `control/`。
- **创建世界与定制流程**：
  1. 玩家在新建世界页（`#/create`）选择可用内容包时，可同时选择一项应用级主角模板（或选择「不使用」），也可原地管理模板。
  2. 提交创建后，Runtime 先按常规机械复制并原子发布独立世界（初始 `state/` 为内容包默认主角）。
  3. 若创建时选择了主角模板，前端随即打开新世界并自动进入一次显式的**世界修订**对话，提交针对主角定制的初始修订消息（要求找到玩家主角文档、按模板改写并按本世界规则协调冲突、仅改主角文档、找不到明确主角文档时先询问而不擅自新建）。
  4. **权威边界**：只有玩家审查差异并确认「应用」世界修订后，定制后的主角才作为 `revision_apply` 轮提交入世界权威；若玩家选择「放弃」世界修订，世界完整保留内容包默认主角，权威历史不受影响。
- **作者约定边界**：支持自定义主角的内容包通常在 `opening.md` 中避免写死主角姓名／外貌，并为主角文档写清 `title` 与 `summary` 以利识别；这些属于作者创作实践（见 [内容包设定创作教程](../content-package-setting-authoring.md)），Runtime 不做机械校验。

## 3. 设定完善会话与当前树事务

设定完善只面向内容包当前树，不修改运行中世界的状态、已提交叙事或历史（[ADR-0037](../adr/0037-setting-improvement-is-one-model-directed-conversation.md)）。

### 3.1 对话模型与编排冻结

- 内容包正文不预先塞入首条消息，AI 通过固定工具从当前树按需读取。默认追加至当前所选对话（历史对话全部保留可随时继续），作者亦可显式选择「全新上下文」从当时当前树重新编译。
- 每次作者主动发送读取当前已应用编排方案的 `authorPrompts`（含只读「未来游玩参考」），冻结该次发送及完整工具循环的配置与资源，使用当前模型连接与内容包当前标题；协议与已有原生续传不兼容时阻止发送，要求切回兼容连接或开启全新上下文。
- 模型始终持有稳定的读写工具全集，由用户消息语义决定讨论、提问或直接修改；「先讨论计划」仅为普通语义请求，不形成 Runtime 阶段或读写模式切换。

### 3.2 工具全集、读取授权与 `setting_patch` 规则

AI 使用受管工具（`setting_list` / `setting_search` / `setting_read` / `setting_create` / `setting_write_file` / `setting_patch` / `setting_move` / `setting_delete`）操作内容包：

- **Revision 级写前读取授权**：修改或删除既有文件前必须先完整读取；由 AI 本次新建或已成功修改过的完整文件视为已读。读取授权严格绑定产生它的精确当前树 revision；其他对话或手动编辑发布新树后旧授权立即失效，必须重新读取。
- **`setting_patch` 单操作语义（与游玩 `world_patch` 严格区分）**：
  - `setting_patch` 单次工具调用**只接收单个 `op`**（`add`、`replace`、`append`、`remove`、`set_metadata`），**不接受 `edits` 数组**（`SettingAuthoringTransaction.ts:436`）；其中 `op: "set_metadata"` 只传需改动的 `title`、`summary` 或 `aliases`（至少一项），省略字段由 Runtime 保留。
  - 批量修改通过模型在**同一完整响应中连续发出多条工具调用**完成，由 Runtime 顺序执行并在响应结束时统一原子发布。
  - 路径不存在时的写入规则与游玩 `world_patch` 共用：`add` 与 `replace` 均为 upsert（缺失父级 map 自动创建，数组下标越界追加至末尾），`remove` 删除已存在路径、不存在时为 no-op 并在回执中注明；YAML locator 支持 map key 与从 `0` 开始的数组下标。
- **新建、移动、物理删除与字符安全**：
  - 新建文档时 AI 提供唯一 `ref`、标题、摘要、别名、路径与正文，Runtime 生成并隐藏 `$document.id`；模型读取、引用与控制选择器一律使用 `@ref`，内部 ID 自动投影回 `@ref`。
  - 疑似重复 JSON 转义遗留的字面 `\uXXXX` 内容直接拒绝该次调用，Runtime 不猜测解码。
  - `setting_delete` 为物理删除，仅当目标已完整读取，且不被 `bindings.currentSituation`、frame slot、player-view selector 或其他文档 `$ref` 指向时接受；否则拒绝并列出全部阻挡位置。`ref` 不可改，`setting_move` 拒绝覆盖已有路径。

### 3.3 逐响应原子发布、写后检查与游玩读取覆盖

- **顺序执行与整响应原子发布**：一份完整 Provider 工具响应中的调用在内容包进程内租约（`acquireOperationLease`）保护下按序执行——成功调用对同响应后续调用立即可见，失败调用仅在其自身工具结果中返回原因而不回滚同级成功调用；整份响应结算时，所有成功变化**一次原子发布到内容包当前树**。不完整流式片段绝不执行工具或修改当前树。
- **自动机械检查与确定性「游玩读取覆盖」**：写响应发布后，Runtime 自动计算逐调用统一 diff，并执行机械检查（开场白唯一性／文本／大小、文件安全、身份、引用、控制格式、必需 slot、玩家选择器与真实生产等价 Prompt Preview），同时确定性产出**游玩读取覆盖**报告，标注每份改动材料在全新游玩中的路径（全文／节点注入、仅目录摘要、由已注入材料直接引用、仅按需发现、genesis、控制投影或未启用控制块）。
  - 附在最后一个成功写调用结果中返回给模型的覆盖与整理报告，仅逐条列出本次响应改动的文件及超建议体积项，本次用户请求的累计改动只报数量；持久保存的检查结果仍按整次用户请求累计。
  - 机械检查失败不回滚已原子发布的安全文件树，模型可在后续响应中修复；Runtime 不做世界语义校验。无工具调用的完整回复仅结束当次推进，不宣告设定终态。

### 3.4 回滚、消息修改、恢复与会话 Schema 演进

- **单文件前像直接回滚**：每条成功且非空的历史工具差异拥有稳定改动集身份。作者可在工具结果下的红绿 diff 中逐份文件独立选择恢复为该次记录的前像（create→删除、delete→重建、move 来源与目标独立可选）；覆盖当前值（即使已有后续修改），已等于前像时幂等成功；不调用模型、不改写对话历史。
- **历史用户消息修改**：替换目标用户消息及其后对话、保留其前原生前缀并以修改稿继续。作者可选「保留文件改动」或「撤回文件改动」（仅逆序撤回被截断部分中由本对话结算的 AI 差异；任一受影响文件后像不匹配、差异链不连续或撤回引入新内容树错误则整次拒绝，保留原文件、对话与编辑稿）。树恢复与对话替换共享持久恢复意图，下次内容包访问先收敛。
- **64 步暂停与失败恢复**：单次运行上限 64 次模型调用，达上限暂停并保留已结算改动，支持「继续」沿用冻结编排再跑一批。普通请求失败提供「重新发送」（先恢复未完成的结算意图——在「完整响应与原树指纹已保存／当前树已发布／收据已追加」三态间收敛，绝不从流片段或变化后的树猜测）；发生文件冲突、证据缺失或续传损坏时提供「用新上下文」。
- **会话 Schema 演进**（[ADR-0037](../adr/0037-setting-improvement-is-one-model-directed-conversation.md)）：
  - 当前会话对所有非 opaque 字段使用完整 codec，未知或损坏结构 fail closed。
  - 旧隔离草稿 schema 迁移严格验证旧结构并保留不可变旧源，未应用草稿绝不静默写树，旧 Apply 收据在包租约内按 base／draft／当前树指纹定类记账但不写树；迁移后于 Runtime-system 层追加当前树写入契约并换用当前工具定义，保留原 Provider 续传。
  - 当前树会话 schema 2→3（追加逐次请求快照）→4（派发重发证据）→5（消息修改意图）→6→7（单文件内共享编译／方案／长正文与工具定义表）均在下次写入时先保留逐字节一致旧源并原子升级，删会话时一并清理备份；悬空、类型不符或无引用表项读取失败。

## 4. 世界修订工作区与跨 Epoch 会话

运行中世界的世界修订（`world.revision.*`）是官方主路径与演进目标（[ADR-0038](../adr/0038-world-revision-uses-one-locked-worktree.md)），与控制编辑的边界对照见 [游玩与世界生命周期规格 §6.3](play-history-and-world-lifecycle.md#63-世界外修改机制对照)。

### 4.1 独占 Epoch 与共享工作树

- 进入修订页面（`world.revision.open`／`overview`）仅读取当前世界与修订历史，**不创建 epoch、不锁定世界**。
- 首次实际文件编辑（`world.revision.files.replace`）或发送首条修订消息（`world.revision.message`）时，Runtime 从固定当前端点和控制指纹创建唯一 `state/*` + `control/*` 工作树，并持久化非过期独占锁。`opening.md` 已提交为 genesis 叙事，无可写当前文件；`control/gameplay.json` 禁止更改。
- 锁有效期间排斥游玩、时间线修订、控制草稿保存与应用、分叉、导出与删除世界；只读检查、故事导出与本地世界名称修改仍可用。浏览器关闭与 Runtime 重启恢复同一活动 epoch，不释放锁，也不重基工作树。
- 手动保存与每份完整 AI 工具响应串行结算至同一工作树 revision，并共同追加精确逐文件 before／after 至同一改动历史（无独立手动／AI 模式）。物理删除与移动沿用设定完善规则（删除需已完整读取且无任何引用阻挡，以文档身份判断既有文档改写）。
- 活动 epoch 内支持按文件独立回滚为任一历史改动的 before-image（追加新的 rollback 改动，不删对话或旧差异）。

### 4.2 原子应用、放弃与崩溃恢复

- **应用（`world.revision.apply`）**：校验整棵工作树及生产等价 Prompt Preview → 将全部 `state/`（含物理删除前像）与 `control/` 变化作为同一轮 `revision_apply` 推进 Authority（[ADR-0045](../adr/0045-world-history-is-current-files-plus-a-turn-ledger.md)） → epoch 标记 `applied` 后释放独占锁。推进途中崩溃时，打开世界的轮账本恢复使该轮要么完整成立、要么完全不存在（未成立时 epoch 保持活动，可再次应用）。回退至应用前端点即可恢复被删除的文档。
- **放弃（`world.revision.discard`）**：将 epoch 标记 `discarded` 并释放锁，不改变 Authority、`state/` 或 `control/`。
- 应用与放弃均封存当前 epoch：历史继续只读可查，全部回滚入口失效。

### 4.3 跨 Epoch 对话、预载授权、历史只读导航与消息修改

- **编排复用与预载授权**：复用当前编排方案的 `authorPrompts`（无后置请求），替换为世界修订机械说明与 epoch 目标。每次发送的 bootstrap 在全部作者提示之后预载工作树目录、控制文档全文与世界框架注入的文档全文——这些预载文档在该次编译所属 revision 内视为已完整读取，无需再读即可修改。
- **只读历史导航**：修订对话支持调用 `history_list`、`history_search`、`history_read` 只读导航该 epoch 固定端点处的已提交历史（与游玩共用 `HistoryQuery` 与渲染）；不产生 revision 变更、改动历史或写入授权，不可改写历史。
- **跨 Epoch 边界**：应用或放弃后可继续原对话；下一条新消息从届时最新世界建立新 epoch，在 Runtime-system 层追加明确 epoch 边界（Google Interactions 将可信当前边界提升至 `system_instruction` 并在原位留 Runtime 通知），同时清空此前 list／search 游标与读取授权，保留旧 Provider 续传，要求 AI 重新读取后再写。
- **历史用户消息修改与恢复**：支持保留文件 vs 撤回文件（仅逆序撤回当前活动 epoch 中被替换部分的本对话 AI 变化，跨已封存改动时拒绝撤回并提示保留文件继续；工作树、rollback 历史与对话替换共享持久恢复意图；修改本身不提交 Authority）。支持 64 步暂停继续（仅同活动 epoch）与普通失败重发（要求同活动 epoch、冻结请求与续传可用、连接兼容且文件未被他方改动）。旧 schema 1 会话可精确读取，下次新发送原子升级至 schema 2 并保留原 bootstrap 与历史。

## 相关文档

- [产品基础](../product-foundation.md)
- [提示词编排、编排方案与世界控制框架规格](prompt-orchestration-and-presets.md)
- [游玩调用链、历史导航与世界生命周期规格](play-history-and-world-lifecycle.md)
- [内容包设定创作教程](../content-package-setting-authoring.md)
