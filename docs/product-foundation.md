# Narraeon 产品基础

Narraeon 是一个本地优先的开放式角色扮演工作区，核心定位不是「把存档 JSON 发给模型」，而是 **提示词编排器 + Runtime 权威连续性层**。作者与 AI 用人类可读的 YAML／Markdown 文件表达世界语义，Runtime 在模型上下文之外保存当前世界、精确叙事与按轮前像账本；任何模型会话都可以丢弃或重建。

本文件是 V1 产品的顶层架构宪法，只定义产品原则、核心不变量、边界划分与导航索引。协议编码、存储布局、并发细节与前端同步契约收敛于 [`docs/specs/`](specs/) 下的六篇专题规格；作者写作实践与实模评测位于维护中的指南；实施进度、缺陷、研究与验收状态由 GitHub Issues 跟踪，不在本文件维护第二份状态。

---

## 1. 产品定位与核心原则

1. **重要性分级连续性**：尽量不让玩家出戏，越重要的事情越不能前后冲突；不追求宿舍里每件普通衣物的位置都可查询。
2. **模型读语义，Runtime 管机械**：模型看到保留逻辑职责和编排顺序的 Markdown；Runtime 只校验文件、身份、引用、patch、端点、协议边界和原子提交。
3. **只有内容包有设定**：创建世界后，复制来的虚构文件就是世界当前状态，不再保留世界设定副本、初始记录和 current record 三层含义。
4. **状态与叙事互补**：会约束后续选择的持续结果写入当前文档；没有结构化但已经发生的细节由已提交叙事精确保留并按需追溯。
5. **提示词是产品表面**：编排方案中的游玩／作者提示、世界提示框架、材料位置、role、Provider 参数和真实 request 必须可以查看和编辑，不能藏在临时 DTO 拼装中。
6. **Runtime 不伪装成语义 AI**：它不判断谁有敌意、什么最重要、哪段历史相关、好感度是否越界或叙事是否泄露悬念。

---

## 2. 工作区表面与核心边界

### 2.1 四个内容任务入口与模型连接

普通工作区保留四个内容任务入口：

1. **内容编辑**：编辑内容包当前树中的 YAML／Markdown 设定与控制资产，并进行设定完善对话。
2. **编排方案**（路由 `#/orchestrations`）：管理跨世界复用的游玩编排、作者编排、后置请求与纯界面扩展。
3. **新建世界**：从可用内容包机械复制创建独立世界（可选应用级主角模板并经显式世界修订定制主角）。创建、保存、重开和阅读开场白都可以在未配置模型时完成。
4. **提示词预览**：调用真实生产编译器，只读检查逻辑 role、Markdown、工具、材料、Provider 参数与缓存边界。

- **模型连接是工作区设置，不是第五个内容任务**。页头展示当前连接并支持原地切换；在途请求沿用发送时捕获的连接，新选择从下次主动发送生效。
- **世界列表与世界页**面向已有世界，提供游玩、当前文档、世界修订、高级控制编辑、已提交叙事、重命名、修改、分叉、导出与备份，不把运行中世界重新叫作「设定」。
- **内容包标题 vs 世界名称**：二者均为本地外壳中可改、可重名的显示标签，不是身份、世界内事实或当前情境文档的 `$document.title`；重命名不改动文件树、端点或 Authority。

### 2.2 故事／详细双视图与 V1 非目标

- 世界页默认**故事模式**（保留正文、玩家视图、玩法产物、待定输出与待处理错误，隐藏调用详情与机制说明），经本机持久化开关即时切入**详细模式**；首屏以「故事可读」为边界，仅拉取当前端点、玩家视图与最近 40 项时间线摘要。
- **V1 非目标**：不提供多用户协同、内置 Web 认证或跨进程共享同一数据目录（[ADR-0004](adr/0004-v1-is-local-first-and-single-user.md)、[ADR-0044](adr/0044-runtime-is-single-process-and-recovers-by-retry.md)）；不支持直接把另一份内容包合并进运行中世界；不提供自定义世界 schema、字段权限系统或 Runtime 自动摘要／截断历史。

路由、草稿保护、SSE 观察与前端同步细则见 [`docs/specs/web-workspace-and-observation.md`](specs/web-workspace-and-observation.md)。

---

## 3. 内容包、世界四固定表面与文档模型

### 3.1 内容包与世界四固定表面

内容包是一棵可复制、可便携 ZIP 交换的当前文件树（最少含 `opening.md`、`world/`、`control/`），以「本地身份 + 本地外壳独立标题 + 当前树」为完整持久形状，无业务 manifest 或包级历史版本。创建世界是一次机械复制与原子发布：

```text
content-package/world/*    -> world/state/*
content-package/control/*  -> world/control/*
content-package/opening.md -> world/history 的 genesis 首条主持原文
content-package 的本地标题 -> 新世界的初始本地名称
```

发布后新世界与源内容包彻底脱离，固定由四个表面构成：

- **`state/`**：全部虚构当前文档（唯一世界当前树）；游玩 AI 仅经受管工具提出候选变化。
- **`control/`**：本世界的提示框架、创作块、玩家视图及可选后置／玩法文件，**不保存虚构实际值**；游玩 AI 不可改，`control/gameplay.json` 创建后永久固定。
- **`history/`**：从 `opening.md`（genesis 主持原文）起按顺序追加的玩家原文与最终主持原文，Runtime 不伪造「开始游戏」玩家消息。
- **`runtime/`**：轮账本、端点头、索引、恢复状态与本地缓存，永不进入普通模型正文。

### 3.2 `opening.md`、`bindings.currentSituation` 与文档模型

- **`opening.md`**：根级唯一非空 UTF-8 Markdown（无 `$document` 头）。故事逻辑起点的首次游玩 bootstrap 直接携带完整原文一次并标明玩家已读；后期全新上下文不自动注入，且始终排除于 `recent` 与附加材料。
- **`bindings.currentSituation`**：每个世界必须精确绑定一份开放的**当前情境**文档承接短期局面，职责不由路径、ref 或标题猜测。受限 YAML 当前情境可选用精确顶层 `背景` 或 `background` 字段供 Runtime 随叙事不可变采集。两键并存时以 `背景` 为准（[ADR-0041](adr/0041-history-captures-optional-situation-background.md)）。
- **受限 YAML／MD 与 `$document` 五项头**：开放对象默认受限 YAML，长篇规则与块默认 Markdown，一文一自然所有者；模型始终阅读确定性 Markdown 渲染结果。可引用文档仅保留五项 `$document` 技术头：世界内不可变 `id`（模型侧隐藏）、唯一公开短引用 `ref`（模型侧写 `@ref`）、`title`、`summary`、`aliases`。
- **`$ref` 与逻辑节点**：单键 `{ $ref: ... }` 是唯一机械文档引用且只指整份文档，裸字符串永远只是文字。局部读写使用「文档 + YAML 路径／Markdown 标题路径」的逻辑节点；`frame.yaml`／`player-views.yaml` 持久选择器不得依赖数组下标，单次 patch 可用 0 起下标精确改删。
- **无世界数据 Schema**：Runtime 严格校验解析安全、深度、容量、技术头、引用完整性与 patch 路径，绝不校验好感度范围、修为顺序、关系对称或角色认知正确性（[ADR-0006](adr/0006-character-knowledge-is-not-world-truth.md)）。

---

## 4. 提示词分层与编译机制契约

提示词按各层的**实际作用域与写入能力**分三层（[ADR-0029](adr/0029-author-prompt-layers-split-by-capability.md)）：

1. **编排方案（外层跨世界框架）**：承载游玩编排（`playPrompts`）、作者编排（`authorPrompts`）、后置请求编排与纯界面扩展；设定完善与游玩 AI 均不可改。采用叠加格式（`orchestration.yaml` 中的 `narraeon.orchestration/v1`）：系统正文与默认顺序归应用目录，用户文件只存用户正文与覆盖；不绑定玩法模式或判定方案。
2. **世界提示框架（内层本世界框架）**：位于 `control/frame.yaml` 与 `control/blocks/*.md`，承载本世界特有规则、保存位置约定、确定性材料 slot（恰含一个 `current_situation` 与一个 `additional_materials`）及可选 `maintenance` 建议体积与时钟声明；严禁内嵌状态实际值或语义查询。
3. **Runtime 必选机械说明**：应用内置、固定 `System` 且不可停用，仅解释当前请求真实工具与句柄、读取覆盖与写入资格、patch／元数据／退役语义、回执含义、工具中间步与终态提交规则、检查点边界与历史工具使用约定；绝不在机械层暗加作者语义。

### 4.1 编排原语（与默认提示词文案解绑）

本宪法、专题规格与词表只约束机械原语，**不锁死内置提示词正文、选项组枚举或写作案例**：

- **块类型与选项组互斥**：支持必选块、互斥**选项组**（启用一项自动关闭同组其余项，允许全停用）、独立政策块、可叠加文风块与用户块；分类只影响编辑器，编译严格按列表顺序输出。
- **动态占位**：支持「完整世界提示占位」与连接级「模型提示词占位」（游玩／作者独立，空正文不发消息）。
- **本轮提示（`turn_guide`）**：游玩主链每次派发按序拼装启用条目的尾部行（内置默认／覆盖、用户块、独立尾部条目、世界 `instructions[].turnGuide`）并末尾接玩家单行「本轮临时要求」（`player:turn`），带固定 Runtime 抬头发送；仅属本次派发与冻结请求，不入 transcript、Authority 或历史。
- **逻辑 Role 与 Prompt Preview**：编译产出稳定逻辑 role（`runtime_system`、`author_instruction`、`world_context`、`player_input`、`assistant`、`tool`），正文用 Markdown，条目可自选 `System`／`User`／`Assistant` 发送角色与相邻合并开关。Prompt Preview 必须复用真实编译器与协议编码器，展示脱敏真实请求与 DTO 泄漏扫描，不调模型、不改世界。

本地库 `file-native-orchestrations.json`、便携导出 `.orchestration.json`、旧 v1–v3 一次性迁移、旧四块退役映射与维护 schema 见 [`docs/specs/prompt-orchestration-and-presets.md`](specs/prompt-orchestration-and-presets.md)。

---

## 5. 游玩调用链、按需读取与跑团／扩展边界

### 5.1 单一调用链、机械读取与检查点

- **单调用链与两动作**（[ADR-0030](adr/0030-production-play-is-one-model-directed-call-chain.md)）：生产游玩只有一套模型／工具循环，「全新上下文」与「追加上下文」（含空输入重试／续写）均为单次动作。无整链事务——玩家原文、有实际变化的工具步骤、终态无工具非空叙事各自推进轮账本，后续失败不回滚已成立前序步骤；含工具调用响应的 text 只作工具中间步留轨迹与续传，绝不晋升故事。
- **三种机械读取面**：`state_list`（含空 catalog 目录 `@dir-*` 句柄）、`context_search`（当前状态字面搜索）、`context_read`（精确全文／节点读取），以及当前时间线专用的 `history_list`／`history_search`／`history_read`（签名游标，[ADR-0040](adr/0040-history-navigation-shares-an-ordered-snapshot.md)）。
- **写前精读授权与写工具**：游玩写入授权仅存内存，续发保留既有精读与写后授权而不重绑初始 bootstrap。重启或回退时，从 bootstrap 按保留对话重放精读、已生效编辑对精读范围的变化与已提交的创建，并在当前快照上重新解析；提交时逐文件校验前像哈希（[ADR-0044](adr/0044-runtime-is-single-process-and-recovers-by-retry.md)）。顶层文档写工具为 `world_patch`（1–32 `edits` 整批通过授权检查后逐条处理，含 `op: "set_metadata"` 元数据更新）、`world_create` 与可恢复退役 `world_retire`（不物理删文档；另有 `world_checkpoint`）。
- **检查点**（[ADR-0039](adr/0039-narrative-checkpoints-bound-complete-history-replay.md)）：`world_checkpoint {}` 仅在随后非空无工具正文提交后生效，作为新上下文完整补入边界后已提交原文与浏览器本地预选新上下文的依据，不自动切换或认证事件结束。

### 5.2 不透明续传、预算与容错边界

- **双轨分离**（[ADR-0035](adr/0035-provider-continuation-is-opaque-and-bound.md)）：完整响应拆分为**模型调用投影**与不透明 **Provider 续传载荷**（原样追加下一次同协议请求，不从投影重建、不存整份 HTTP response、不向玩家投影签名／加密推理）。
- **预算与缓存诚实**：直传 `maxOutputTokens`，不做 token 估算、上下文准入或自动摘要；缓存键与断点不泄内部 ID；7 项 usage 逐项保留 provenance，未报告不计零。
- **有界容错**：主动生成上限 64 步（达限暂停可继续）；结构错误最多自纠 1 次；仅 429 与未建连超时自动退避（≤3 次、总计 ≤30s）；其余中断保留冻结请求与部分正文供显式重发或续写。细节见 [`docs/specs/model-providers-and-resilience.md`](specs/model-providers-and-resilience.md)。

### 5.3 跑团判定、玩家视图与玩法扩展

- **跑团机械判定**（[ADR-0043](adr/0043-tabletop-gameplay-is-world-identity-and-runtime-derives-resolution.md)）：`control/gameplay.json` 固定玩法模式与判定方案（`d20`/`d100`/`bag`），Runtime 派生判定工具与只读规则块；随机种子仅单次结算内存现生、不持久化（未结算遇崩溃重试重掷，已结算保留；[ADR-0044](adr/0044-runtime-is-single-process-and-recovers-by-retry.md)）；结构化判定回执随 `tool_result` 保存。
- **玩家视图与玩法扩展**（[ADR-0028](adr/0028-artifacts-project-through-a-trusted-frontend-host.md)、[ADR-0046](adr/0046-artifacts-live-in-the-world-directory-as-stateful-records.md)）：`control/player-views.yaml` 用精确选择器只读展示原值，不展开 `$ref`、非权限系统。主叙事后串行派发后置请求（互不可见、不推进 Authority）；产物作为带状态记录存于世界目录 `artifacts/`（无事件日志），分叉经 `forkArtifactClosure` 随目录发布；`extension-controls.json` 管世界级开关与代际失效；来源脚本授权按内容指纹本地绑定、默认关闭、互不传染、撤权即生效。

游玩细则见 [`docs/specs/play-history-and-world-lifecycle.md`](specs/play-history-and-world-lifecycle.md)；扩展与产物见 [`docs/specs/extensions-and-player-views.md`](specs/extensions-and-player-views.md)。

---

## 6. 权威提交、世界外操作与创作会话

### 6.1 按轮前像账本与崩溃恢复

Runtime 是唯一提交者（[ADR-0001](adr/0001-runtime-is-the-sole-committer.md)）。`state/`、`control/`、`history/` 即当前端点；每次推进先写 `runtime/turns/` 轮前像记录，再逐文件原子替换当前文件，最后推进 `runtime/head.json`（[ADR-0045](adr/0045-world-history-is-current-files-plus-a-turn-ledger.md)）。轮号自 `1` 递增不重用，`commit:N` 为别名，`genesis` 为第 0 轮。打开世界时，轮号大于 `head` 的未完成记录由前像回滚并删除，这是唯一恢复路径（原子 `rename` 无断电 `fsync`）。单进程按世界进程内串行；新建、分叉、归档导入经 `publication.json` 持久去重（含旧指纹兼容），游玩重复发送由持久玩家事件跨重启识别。

### 6.2 历史操作与世界外修改机制定位

| 机制 | 官方定位 | 核心语义与并发边界 |
| --- | --- | --- |
| **时间线修订（修改消息）** | 核心历史操作（[ADR-0032](adr/0032-player-edits-append-current-world-timeline-revisions.md)） | 当前世界追加 `rewind` 轮回到父端点、删后续轨迹与产物，以修改稿提交（续原或新开上下文）；不保留被替换分支 |
| **创建分叉** | 唯一新建独立世界的历史操作 | 复制目标端点所需文件至 staging、用前像恢复所选轮、裁剪产物并重分配身份后原子 `rename` 发布；与来源完全独立 |
| **世界修订（`world.revision.*`）** | **世界外修改主路径与演进目标**（[ADR-0038](adr/0038-world-revision-uses-one-locked-worktree.md)） | 首次编辑／发消息建跨重启持久独占 epoch，手动+AI 共享 `state/*`+`control/*` 工作树，支持单文件回滚与只读历史导航；`apply` 以同一轮 `revision_apply` 提交，`discard` 不改世界 |
| **控制编辑（`world.control-draft.*`）** | **保留的高级人工修改入口**（「世界控制 · 高级编辑」） | 手动整批编辑并预览 `control/*` 后应用为 `control_apply` 轮（不可改 `gameplay.json`）；仅单次调用串行，草稿留盘但无跨重启互斥锁 |
| **世界归档（`.narraeon-world.zip`）** | 便携完整备份与迁移（[ADR-0042](adr/0042-world-archives-reuse-fork-closures-through-a-quarantine.md)） | 空闲且无活动修订时分叉打包导出；经隔离区校验以分叉发布，清脚本授权并禁旧 Provider 续传 |

旧 `correction.*` 命令已退役，V1 Runtime 对其返回 `invalid_request`。已存在的 `correction` 轮及冻结记录继续按历史格式读取。

### 6.3 设定完善单对话边界

设定完善仅面向内容包当前树，不维护第二棵持久草稿树（[ADR-0037](adr/0037-setting-improvement-is-one-model-directed-conversation.md)）。AI 按需读取、每份完整工具响应在包租约内按序执行并一次原子发布全部成功变化，附带自动机械检查与确定性「游玩读取覆盖」报告；`setting_patch` 单次只接单个 `op`，支持单文件前像回滚与历史用户消息修改。详见 [`docs/specs/authoring-and-world-revision.md`](specs/authoring-and-world-revision.md)。

---

## 7. 模块职责边界与持久格式升级原则

| 模块 | 核心职责 |
| --- | --- |
| `ContentWorkspace` | 内容包身份、独立标题、当前树、安全便携导入／导出与原子替换 |
| `WorldDocumentStore` | 文档身份、受限 codec、精确读取、候选 patch／create／retire 与引用索引 |
| `PromptCompiler` | 编排方案与世界框架编译、机械说明、slot 绑定、Markdown 渲染、缓存报告与预览 |
| `SettingImprovementSession` / `Store` | 设定完善对话、逐响应当前树结算、单文件回滚、写后检查与恢复 |
| `ModelToolConversation` | 作者型 Provider／工具交换、流式观察、取消与请求幂等 |
| `WorldRevisionWorkspace` / `Session` / `Store` | 独占 epoch、共享工作树、统一改动历史、逐文件回滚与跨 epoch 对话 |
| `PlayCallChain` / `PlayTraceRetention` / `Timeline` & `Advance` Store | 游玩两动作、模型／工具循环、中断标记、轨迹保留与有界分页时间线（[ADR-0048](adr/0048-play-contexts-keep-one-request-and-reference-prompt-snapshots.md)） |
| `WorldTurnLedger` / `Authority` / `WorldStore` / `OperationCoordinator` | 轮账本、未完成轮恢复、世界外壳、回退、分叉、控制应用与进程内按世界串行 |
| `FileNativeArtifactStore` | 世界目录内状态化产物记录、清除恢复、分叉闭包与活动投影 |
| `ModelHost` & Adapters / `Runtime` | 协议编码、流式与续传 / 协调全部深模块的唯一业务权威 |

**持久格式升级原则（[ADR-0034](adr/0034-released-storage-formats-require-atomic-migrations.md)）**：已发布格式在首次访问时执行一次性幂等原子迁移，保留旧源直至完成标记发布，完成后只读写当前格式、拒绝长期双读／双写。v0.3.0–v0.6.0 世界自动升级至当前格式；v0.1.x（V1）与 v0.2.0（V2）已停止直接迁移（须经 v0.3.0–v0.6.0 中转）；未知、损坏或不可升级记录一律 **fail closed** 且不改写原数据。

---

## 8. 专题规格与 ADR 导航索引

### 8.1 专题规格（权威工程与协议契约）

| 专题规格 | 对应代码模块 | 核心契约范围 |
| --- | --- | --- |
| [模型 Provider 协议、容错与可观测性](specs/model-providers-and-resilience.md) | `runtime/model/`、`runtime/play/` | 四协议编码、不透明续传、三正交推理意图、参数／后缀修复、`allowed_tools`、缓存与 7 项 usage、64 步暂停、429 退避、续写矩阵、Prompt Preview 与「AI 读取」 |
| [提示词编排、编排方案与世界控制框架](specs/prompt-orchestration-and-presets.md) | `runtime/prompt/`、`runtime/config/` | `narraeon.orchestration/v1` 叠加与种子所有权、旧四块退役映射、旧库迁移、`playPrompts`/`authorPrompts`、选项组与本轮提示、`frame.yaml` 与 `maintenance` schema、SillyTavern 导入 |
| [游玩调用链、历史导航与世界生命周期](specs/play-history-and-world-lifecycle.md) | `runtime/play/`、`history/`、`world/`、`archive/` | 调用链时序、内存精读授权与重启重放、`world_patch`（1–32 `edits`）、`history_*` 与历史背景、检查点、跑团内存种子与重掷、四类去重、三种世界外修改对照、世界归档与故事导出 |
| [玩法扩展、后置请求、玩家视图与产物持久化](specs/extensions-and-player-views.md) | `runtime/artifact/`、`runtime/extension/` | 后置编排与 `followups.yaml`、`extension-controls.json`、来源脚本授权、世界目录产物与 `forkArtifactClosure` 分叉发布（含旧迁移）、资源闭包与正则／JSON 校验、玩家视图与预览 |
| [内容包创作、主角模板、设定完善与世界修订](specs/authoring-and-world-revision.md) | `runtime/content/`、`setting/`、`world-revision/`、`authoring/`、`config/` | 内容包身份／ZIP／脚手架／示例、应用级主角模板（`protagonist-templates-v1.json`）定制契约、设定完善当前树事务与 `setting_patch`（单 `op`）、游玩读取覆盖、世界修订独占 epoch 与跨 epoch 会话 |
| [Web 工作区、路由、对话观察与前端状态同步](specs/web-workspace-and-observation.md) | `src/web/`、`src/server/` | Hash 路由与草稿保护、双视图与首屏 40 项边界、`runtime/activity.json`、统一 SSE 观察与 90s 提示、「本段调用详情」与 85% 窗口提示、快捷键与命令／读取同步 |

### 8.2 维护中的作者指南与领域词表

- [领域词表](../GLOSSARY.md) —— 统一领域术语与 _Avoid_ 辨析
- [内容包设定创作教程](content-package-setting-authoring.md) —— 面向作者的内容包设计、文档划分与设定完善实践
- [世界状态维护与上下文衔接指南](world-state-maintenance.md) —— 面向作者的状态维护写作实践、典型案例与合成场景实模验证
- [SillyTavern 宏阅读参考](sillytavern-macro-notes.md) —— SillyTavern 常见宏类别与静态阅读边界

### 8.3 核心 ADR

- 权威与基础：[ADR-0001](adr/0001-runtime-is-the-sole-committer.md)、[ADR-0006](adr/0006-character-knowledge-is-not-world-truth.md)、[ADR-0024](adr/0024-world-state-is-a-file-native-current-tree.md)、[ADR-0025](adr/0025-prompts-compile-into-append-only-model-sessions.md)
- 提示词与游玩：[ADR-0029](adr/0029-author-prompt-layers-split-by-capability.md)、[ADR-0030](adr/0030-production-play-is-one-model-directed-call-chain.md)、[ADR-0035](adr/0035-provider-continuation-is-opaque-and-bound.md)、[ADR-0039](adr/0039-narrative-checkpoints-bound-complete-history-replay.md)、[ADR-0040](adr/0040-history-navigation-shares-an-ordered-snapshot.md)、[ADR-0041](adr/0041-history-captures-optional-situation-background.md)、[ADR-0043](adr/0043-tabletop-gameplay-is-world-identity-and-runtime-derives-resolution.md)、[ADR-0048](adr/0048-play-contexts-keep-one-request-and-reference-prompt-snapshots.md)
- 历史、存储与并发：[ADR-0032](adr/0032-player-edits-append-current-world-timeline-revisions.md)、[ADR-0034](adr/0034-released-storage-formats-require-atomic-migrations.md)、[ADR-0042](adr/0042-world-archives-reuse-fork-closures-through-a-quarantine.md)、[ADR-0044](adr/0044-runtime-is-single-process-and-recovers-by-retry.md)、[ADR-0045](adr/0045-world-history-is-current-files-plus-a-turn-ledger.md)
- 创作、扩展与前端：[ADR-0028](adr/0028-artifacts-project-through-a-trusted-frontend-host.md)、[ADR-0037](adr/0037-setting-improvement-is-one-model-directed-conversation.md)、[ADR-0038](adr/0038-world-revision-uses-one-locked-worktree.md)、[ADR-0046](adr/0046-artifacts-live-in-the-world-directory-as-stateful-records.md)、[ADR-0049](adr/0049-frontend-command-results-and-projections.md)
