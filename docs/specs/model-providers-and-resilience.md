# 模型 Provider 协议、容错与可观测性规格

本规格定义 Narraeon 的模型调用传输层契约，对应代码模块 `src/runtime/model/` 与 `src/runtime/play/`（派发与恢复层），并承接 [ADR-0017](../adr/0017-chat-completions-is-the-v1-model-api-baseline.md)、[ADR-0035](../adr/0035-provider-continuation-is-opaque-and-bound.md)、[ADR-0044](../adr/0044-runtime-is-single-process-and-recovers-by-retry.md) 与 [ADR-0048](../adr/0048-play-contexts-keep-one-request-and-reference-prompt-snapshots.md)。顶层产品定位与能力分层见 [产品基础](../product-foundation.md)。

## 1. 逻辑 Role 与四种协议编码

模型请求统一使用稳定的逻辑 role：bootstrap 中的 `runtime_system`、`author_instruction`、`world_context`，以及随后追加的 `player_input`、`assistant`、`tool`。

- 逻辑 role 表达消息职责，不作为全局排序键；Provider adapter 必须保留编译后的有序前部，并在编码中保留逐项职责标记。
- 世界材料即使编码在 system 容器内，仍然只是引用数据，不因此获得作者指令权限。
- 输入正文使用 Markdown；只有 Provider 传输外壳和原生工具参数使用 JSON，不得把内部上下文对象序列化后塞进单条 `user.content`。
- Prompt Preview 与生产派发必须复用同一套协议编码器。Provider 的初始世界材料预载说明由编排编译语言决定，同一上下文保留首次发送的说明与材料原文。工具名、调用 ID、参数与原生签名保持原样。

### 1.1 OpenAI 兼容 Chat Completions

- 保留有序前部编码为 system 前缀；工具结果编码为逐项 `tool` message。
- 支持标准端点与 CLIProxyAPI 方言。
- 模型列表与生成请求默认使用 API Key，旧连接缺少鉴权字段时沿用此默认值。只有 HTTP(S) 回环端点（`localhost`、IPv4 `127.0.0.0/8` 或 IPv6 `[::1]`）可显式选择「无需 API Key」。保存时记录鉴权方式并移除该连接原有的 Key；克隆和重新打开保持已保存的选择。免 Key 的模型列表、流式生成和工具续传均省略鉴权头，并继续限制重定向只能留在同源。切回 Key 模式时须提供新凭据。局域网端点和其他协议仍须配置 API Key。
- 发往 `https://api.openai.com/v1/chat/completions` 的 o 系列请求将 `maxOutputTokens` 编码为 `max_completion_tokens`。其余 Chat 请求（包括兼容代理）继续使用 `max_tokens`。每次请求只发送一个输出上限字段。[OpenAI Chat Completions 参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- 通过 Chat Completions 代理调用 Claude 时通常只能获得 `reasoning_content`，协议本身不能保证携带签名 thinking；需要可验证无损续传时必须使用 Anthropic Messages 或支持 `reasoning.encrypted_content` 的 OpenAI Responses 兼容路径，不得切割正文猜测 thinking。

### 1.2 OpenAI Responses

- 保留编排方案的条目顺序，将「工具与响应结算（必选）」等 System 正文编码为 `input` 中的 `developer` 消息；显式 User／Assistant 编排条目收到各自角色。
- 预加载的世界材料编码为原生工具调用与结果；后续玩家行动、作者消息、原生模型输出及逐项 `function_call_output` 按原顺序进入 `input`。
- 游玩编排方案与世界 frame 的固定本轮提示进入顶层 `instructions`（仅在存在内容时发送）。
- 连接高级选项中的 **GPT-6.2 开关**默认关闭：
  - 关闭时，玩家「本轮临时要求」作为 `input` 最后一条带来源标注的 `user` 消息；后置请求自己的任务与产物规则进入末尾 `developer` 消息。
  - 开启时，玩家「本轮临时要求」与固定本轮提示一同进入顶层 `instructions`；后置请求自己的任务与产物规则进入该请求的 `instructions`。
  - 顶层 `instructions` 在 GPT-6.2 路径下按未缓存输入计费，因此仅适合短小的本轮提示，长期复用的规则正文留在有序 `developer` 消息中。
  - 设定完善与世界修订的用户任务及对话保留在 `input`。
  - 模型名或代理别名不自动决定该开关，必须由连接配置显式选择。参考：[OpenAI GPT-6.2 指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.2-astra)、[前缀匹配说明](https://developers.openai.com/api/docs/guides/prompt-caching#how-prefix-matching-works)。

#### 本地 ChatGPT 套餐连接

订阅连接使用 OpenAI 的开源客户端授权流程。本机 Runtime 以 Narraeon 的名义发起授权，按账号及工作区对应的注册保存并刷新凭据。只有已授予套餐使用权限的连接能派发。模型列表来自所选账号。OAuth 凭据仅用于官方服务；Web 接口、请求预览、故障记录和世界归档均不得携带凭据。账号退出后，该连接停止派发。[动态注册](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

套餐派发使用公开的 Responses 端点，开启流式传输，设置 `store: false`，每次携带本轮所需的完整输入。按订阅通道支持的形式传送工具定义及原生回执，系统材料用开发者消息或 `instructions` 表达。请求省略 `max_output_tokens`。需收到成功完成事件才结算本步，额度不足或授权失效由用户处理。试发只发一次；自动后置请求须经单独同意。[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [订阅通道限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

### 1.3 Anthropic Messages

- 有序前部编码为有序 text blocks。
- 当前适配器要求编排中的所有 System 项位于 User／Assistant 之前；不支持的排列在编译／编码阶段明确报错。
- 同一 assistant 响应触发的并行工具调用结果，全部合并在紧随其后的同一个 `user` message 的 `tool_result` blocks 中，并对失败结果显式标注 `is_error`。该协议分组不改变 Runtime 中逐调用的工具记录、执行顺序或 Authority 边界。

### 1.4 Google Interactions

- 支持从端点拉取模型列表或手工输入模型 ID，可选标准或 CLIProxyAPI 方言。目前尚无具体模型或协议版本通过真实四入口验收。
- [标准 Interactions 请求](https://aistudio.google.com/api-reference/interactions-api)用 `generation_config.thinking_level` 设置推理强度，用 `generation_config.thinking_summaries` 设置摘要。[Google 的模型支持表](https://aistudio.google.com/docs/thinking#thinking-levels)列出 Gemini 4 Neon 与 Gemini 4 Hydrogen 的等级为 `low`、`medium`、`high` 和 `xhigh`。这两个模型已保存的 `minimal` 可在编辑时查看，须改为支持的等级或 Provider 默认才能保存、预览或派发。其他模型支持的等级请查 Google 的模型支持表。
- CLIProxyAPI 方言保留 `generation_config.thinking_budget`，其中 `adaptive` 发送 `-1`，`disabled` 发送 `0`，手动预算发送已保存的非负整数。旧标准连接的预算仍可查看，保存、预览或派发前须明确选择 Provider 默认或模型支持的等级。实际使用兼容代理时，可以切换至 CLIProxyAPI 方言保留预算。已记录的旧请求预览仍可读取。
- 文本 bootstrap 的前置 System 合并为单个 `system_instruction`；普通编排在 User／Assistant 之后出现 System 明确拒绝。
- 世界修订的唯一例外：经同一世界持久 epoch 与来源校验的可信当前 epoch 边界可提升进入 `system_instruction`，历史原位置保留明确标注 Runtime 来源的通知（[ADR-0038](../adr/0038-world-revision-uses-one-locked-worktree.md)）；旧边界不提升，用户内容和其他中途 System 均不提升。
- 后置请求提示作为带来源标记的追加用户输入编码，使用冻结主链与声明工具。
- `requires_continuation` 在同一逻辑 exchange 内使用冻结的 `store: false` 输入、配置与内存中的 token 有界续接，最多 **16 跳**、总时限 **1 小时**。每一跳均须具有完整生命周期；缺失 token、重复 token、中断、超时或非完成终态均安全停止。所有 `steps` 保持原序，仅在最终完整响应到达后才结算工具或正文。
- Google usage 仅保留已知数值字段与缺失值，不把未报告字段计为零，逐跳计量按 Provider 报告聚合。

## 2. Provider 续传载荷与模型调用投影

Provider 完整响应进入 Runtime 后拆分为两条不可互替的轨道（[ADR-0035](../adr/0035-provider-continuation-is-opaque-and-bound.md)）：

| 轨道 | 职责 | 协议原生形态 / 约束 |
| --- | --- | --- |
| **模型调用投影** | 解析可见正文、返回推理、工具调用、usage 与错误，供工具执行、诊断、界面呈现与 Authority 结算分类 | 协议中立；不得用作下一次请求的续传来源；返回推理不进入玩家正文、已提交叙事或世界 Authority |
| **Provider 续传载荷** | 供下一次同协议请求原样追加的不透明协议原生片段 | Chat Completions：完整 `assistant` message；Responses：完整 `output` items；Anthropic Messages：完整 `assistant` `content` blocks；Google Interactions：完整有序 `steps`（含签名与未知扩展字段） |

- 不得保存完整 HTTP response 外壳作为续传载荷，也不得从解析投影（`text`、`reasoningContent`、`toolCalls`）重新拼装消息。
- 签名 thinking、redacted thinking 与 Responses `reasoning.encrypted_content` 必须原样保留在续传载荷中，且不得向玩家投影。
- 工具结果由各协议编码器从 Runtime 工具事实直接生成，不从 assistant 投影反推。
- Provider wire 上每个自定义工具的输入 schema 必须是没有顶层 `oneOf`／`allOf`／`anyOf` 的单一对象；状态目录枚举与已提交历史枚举分别使用 `state_list` 与 `history_list`。若旧调用链冻结了合并式 `context_list` 及不兼容 schema，仅在该调用链的 Provider wire 投影处兼容转换，且仅在冻结工具全集确实包含它时继续执行，不得改写持久 transcript 或替换原工具名。
- 游玩、设定完善与世界修订在每次主动发送、修改后发送或重发时解析当前选中的连接，并在本次工具循环内保持冻结；历史绑定仅作诊断和原生续传兼容证据。协议切换不兼容或续传载荷缺失／损坏时在派发前阻止，允许切回兼容连接或开启全新上下文。每次请求保存不含凭据的编码证据；旧请求缺少编码快照时在原生载荷兼容前提下仍可使用当前连接。

- 游玩页以 Runtime 投影的当前上下文协议与已选连接协议显示发送前提示。当前上下文过期或已知不可恢复时沿用相应恢复规则；同协议可切换不同连接和模型设置。提示不改变持久会话或冻结请求，派发时 Runtime 仍按实际连接校验。
- 三个发送入口通过 `model_protocol_mismatch` 识别已存上下文和当次连接协议不兼容。Anthropic Messages 和 Google Interactions 的新请求在派发前验证前置 System 顺序，使用 `prompt_role_order_unsupported` 返回协议及已知的方案 ID、已用修订和提示列表。能定位到编排条目时还返回第一个可定位的冲突 System 条目 ID。Runtime 生成的作者预载没有可编辑条目身份。Google 游玩检查真实派发的前缀，初始世界材料按工具预载发送。

## 3. Effort、Thinking 与返回推理三正交意图

Effort、Thinking 模式和返回 thinking 内容是三项独立配置意图：

| 协议 / 方言 | Effort | Thinking 模式 | 返回 thinking 内容 |
| --- | --- | --- | --- |
| **OpenAI Responses** | `reasoning.effort` | 无独立请求字段，界面固定 `Provider 默认` | `reasoning.summary` |
| **Chat Completions** | 仅发送协议／方言明确定义的扩展字段 | 无独立请求字段，界面固定 `Provider 默认` | 仅发送协议／方言明确定义的扩展字段 |
| **Anthropic Messages** | `output_config.effort` | 省略 / `adaptive` / `enabled`（`budget_tokens` ≥ 1024 且 `< maxOutputTokens`） / `disabled` | `thinking.display`（`summarized` / `omitted`） |
| **CLIProxyAPI 带后缀模型名** | 模型 ID 含 `(high)`、`(max)` 等 thinking 后缀时须保持 `Provider 默认` | 同左（模型名后缀优先于 body，避免双配置权威） | 正交可见性意图，可随后缀独立传递 |

- Provider 返回的 thinking block 无论是否显示摘要，均原样保留在续传载荷中。
- 目标模型不支持的组合或等级由 Provider 明确拒绝，Runtime 不猜测模型能力或静默换档。

## 4. 工具参数边界修复、代理后缀修复与阶段白名单

### 4.1 工具参数浅层 JSON 解析

当模型把 schema 要求为 `array` 或 `object` 的工具参数以 JSON 字符串发出时，Runtime 在工具参数边界按原始 schema 执行一次浅层解析：

- 仅处理唯一类型为 `array` 或 `object` 的位置；不解析空对象 schema `{}` 与包含 `string` 的联合类型；最多解析两层。
- 游玩 `world_patch` 还会按编辑操作解析单独字符串化的 `edits[i].locator` 对象及其 `yaml` 或 `markdown` 路径数组。只有定位器与路径均明确且合法时才采用解析结果，之后照常检查精读资格与写入规则。`value`、Markdown 正文及其他内容字段保持原值。
- 解析失败或类型不符时按原值失败，并在错误信息中说明该字段必须是 JSON 数组或对象。
- 解析后的值按正常 schema 与业务规则校验，工具结果末尾附一行 Runtime 说明。
- transcript、冻结请求与页面时间线中保留的仍是模型原文。

### 4.2 供应商代理工具名后缀修复

部分代理还原工具名失败时，模型可能只发出带前缀残缺的工具名（如 `margin_world_create`）：

- 对未声明的工具名，若它唯一以 `_<当前请求提供的工具名>` 结尾，Runtime 按该目标工具执行并在工具结果末尾附 Runtime 说明。
- 否则拒绝执行，并在结果中列出当前请求实际提供的工具名列表。
- 已注册工具名之间互不为 `_` 后缀（由单元测试约束）。
- transcript 保留模型原始工具名，页面时间线另记实际执行工具名。

### 4.3 `allowed_tools` 阶段白名单

- 每次新游玩运行冻结一份完整有序工具定义，包含本轮世界工具、跑团玩法工具（如适用）以及 `artifact_emit`、`artifact_clear`；主链与各独立后置请求发送同一份工具定义，由 Runtime 分别授权主链工具与产物工具。
- Google Interactions 与具备该能力的 OpenAI Responses 连接通过原生 `allowed_tools` 白名单表达当前阶段允许调用的工具范围；不支持 `allowed_tools` 的 Responses 连接须在高级选项中关闭该能力。
- 其他端点依靠阶段提示与 Runtime 执行边界检查强制隔离。

## 5. 缓存断点、预算与 Usage Provenance

### 5.1 预算与上下文准入

- 模型连接配置保存 Provider 的 `contextWindowTokens` 与 `maxOutputTokens`。
- 每次新派发直接使用当前连接的固定 `maxOutputTokens`；原样重发使用已持久化的完整原请求。
- Runtime **不估算 token、不做上下文准入、不另设连续交换输出上限、不在响应已完成后复算拒收，也不自动摘要、压缩或截断历史**；请求能否被上下文窗口容纳完全由 Provider 判定。

**连接表单试发**是独立的 `model.test` 命令。它用当前表单的端点、模型、协议和请求参数，由正常适配器流式派发一条固定的短用户消息。已保存的 Key 仅能沿用同一服务来源。回环 Chat Completions 支持免 Key。试发不加入模型提示词、历史、工具或世界材料，不保存、启用或修改连接。

试发最多发送一次请求，禁止重定向、重试和 Google 续接。等待上限为 15 秒，支持设置输出上限的连接最多请求 256 tokens，成功响应读取上限为 1 MiB。ChatGPT 套餐试发保留单次请求和本地读取限制，服务端输出量由套餐通道决定。Google 的显式思考预算从试发输出额度扣除。无法放入额度的显式思考预算在请求前拒绝，不改写表单。Provider 默认或自适应思考仍按 Provider 行为运行。只有收到非空正文才显示成功，正文和推理均不出现在试发回执。回执只返回分类状态，不包含上游原始错误。

### 5.2 稳定前缀、显式缓存标记与 `prompt_cache_key`

- 提示词编译把稳定机械块、编排方案作者块和世界控制块放在稳定前缀，稳定前缀指纹不包含内部 ID、时间戳和 operation 数据。
- **显式缓存断点**：Anthropic Messages 及 CLIProxyAPI 的 Chat Completions 方言在稳定部分编码显式 `cache_control` 标记；Responses 经 CLIProxyAPI 转 Claude 时可在连接高级选项中单独开启 `cache_control`（默认关闭，Codex 路由保持关闭）。带临时尾部提示时，显式断点路径还可在其前方标记最近的 transcript 内容；显式断点总数超过 **4 个**时报错。
- **Anthropic Messages 的提示词缓存时长**按连接保存。原生和自定义端点均可在高级选项选择 **5 分钟（默认）**或 **1 小时**。旧连接和旧快照缺少该字段时按 5 分钟编码。每次主动发送或手动重发使用当前兼容连接，同一次工具循环固定使用发送时选定的时长。稳定前缀、初始世界材料工具结果及临时提示前的对话尾部沿用既有断点位置及数量。Narraeon 写入的内容块级 `cache_control` 默认省略 `ttl`，选 1 小时则统一写入 `ttl: "1h"`。提示词预览和实际派发共用该编码。切换协议后清除该选项。缓存命中会续期，1 小时写入费用更高。[Anthropic 提示词缓存说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration)
- **`prompt_cache_key`**：标准 Responses 按稳定前缀分组；CLIProxyAPI 按冻结模型会话生成稳定散列（同一调用链各轮不变，不同调用链隔离，后置操作同样按操作隔离）。两条路径均不将原始内部身份写入 wire。
- 改变 Thinking 或 Effort 会改变 Provider prompt／cache key 语义并使旧缓存边界失效；缓存 miss 只影响成本与延迟，不得改变请求语义或恢复能力。

### 5.3 七项 Usage 与 Provenance

- Runtime 不把字节估计伪装成 token 命中，必须持久投影 Provider 实际报告的 7 项用量：
  `input`、`uncached input`、`cache read`、`cache write`、`reasoning`、`output`、`total`。
- 每项分别保留 provenance（`ModelUsageField`：`provider` / `derived_provider_fields` / `unavailable`）；未报告字段显示为「未报告」而非 `0`，实际零值保持为 `0`。
- **计量语义区分**：
  - 常规协议下，`cache read` 与 `cache write` 属于 `input` 的构成，`reasoning` 已包含在 `output` 中，界面不得重复相加。
  - **Google Interactions（`accounting: "google_interactions"`）** 的输入、输出、思考（`total_thought_tokens`）、缓存与合计直接采用 Provider 实报字段，**各项包含关系不作推断**；界面直接显示「推理」「输出」，不标注「输出内／含推理」。

## 6. 步数上限、格式自纠、自动退避与中断恢复

### 6.1 64 步上限暂停

- 游玩主链、设定完善与世界修订每次主动生成最多派发 **64 次**模型请求（格式纠错计入同一上限）。
- 达到上限且仍需下一次请求时，Runtime 保存冻结请求并进入暂停态而非失败，已结算的工具结果、文件改动与世界变化全部保留。
- 刷新或重启后，用户可点击「继续生成」／「继续」（游玩亦可空输入提交），沿用冻结请求从最后已结算步骤起获得新的 64 次额度。世界修订仅在暂停所属 epoch 仍为活动态时允许继续。
- 单步的临时拒绝退避与独立后置请求各自遵循独立规则，不计入主链 64 步上限。

### 6.2 格式错误与有限自纠

- 模型生成的工具参数错误在对应工具结果中说明原因，由模型在后续步骤中自行修正。
- 同一批工具调用无法配对或回复结构无效时，Runtime 从最后有效输入携带具体错误自动发回模型请求重生成；单次无效回复**最多自动纠正 1 次**。自纠说明采用被纠正请求的编译语言，已保存的自纠消息按原文重放。
- 用户可随时停止生成；持续失败后可手动重发。任何无效数据都不得发布到文件或世界。

### 6.3 临时拒绝与自动退避重试

游玩主链、独立后置请求、设定完善与活动世界修订共用此模型派发边界：

- **允许自动重发的错误**：仅限临时 **HTTP 429** 与 Undici 明确证实尚未建连的 **`UND_ERR_CONNECT_TIMEOUT`**。
- **重试次数与退避节奏**：初次派发后，临时 429 最多重试 **5 次**，基础等待依次为 **1s、2s、4s、8s、8s**；未建连超时最多重试 **3 次**。两种错误共用同一步的重试序号，每次按本次错误的上限判断，并在基础等待上另加 **0–25%** 随机抖动。
- **`Retry-After` 与总预算**：可解析的 `Retry-After` 秒数或 HTTP 日期作为当次等待下限；单步累计退避等待上限为 **30 秒**，超出预算立即停止，且仅在服务商实际给出建议时说明其建议秒数。
- **严禁自动重发的情况**：明确余额或硬配额耗尽、认证错误、参数错误、上下文超限、用户取消、等待首响应超时、部分流中断，以及缺乏未派发证据的超时（结果未知）。
- **Google 限制与总时限**：Google Interactions 仅允许第一跳临时拒绝或未建连超时自动重发，取得续接进展后的失败保持结果未知；包含退避在内的整个逻辑步骤仍受原 1 小时总时限约束。
- **状态隔离与观察**：重发沿用同一连接、请求正文、工具定义、原生续传和已完成工具结果，不追加用户消息、不重做已成功工具或世界提交。等待期间支持取消；关闭对应后置请求同时取消等待且后续不得派发。刷新继续观察且不重置计数；Runtime 重启把未完成派发恢复为中断，由用户决定恢复。退避状态仅在当前等待期间于原位展示安全原因、预计等待与序号，重发后撤下，不留在公共对话或调用详情历史中，底层诊断保留必要结构化证据。

### 6.4 取消、原样重发与「续写」预填充矩阵

- **显式取消**：按精确身份（world／chain／exchange 或 session）向 Provider 传播 `AbortSignal`。浏览器断流不等同用户取消。未完整结算的片段不进入原生续传、故事或 Authority。
- **原样重发**：进程退出、断流、取消或空响应后，若存在有效冻结请求与兼容原生续传（包括 Google Interactions 已派发但结果未知的步骤、以及达到输入／输出上限的有效原请求），用户可用当前兼容连接重发最后已结算步骤之后的请求；已结算工具、文件改动、玩家原文与叙事均不重复提交。
- **「续写」与预填充模式矩阵**：游玩、设定完善与活动世界修订在生成中断且保存了完整可见正文时提供「续写」。新旧连接默认关闭预填充，严禁按协议名自动推断支持：

| 协议 / 路由 | 允许配置的预填充模式 | 限制条件 |
| --- | --- | --- |
| **Chat Completions** | 普通末尾 `assistant` / `prefix: true`（增量返回） / Mistral `prefix: true`（含前缀返回，校验前缀去重） / `partial: true` | 需用户显式开启；DeepSeek 需 beta 前缀端点；Kimi／千问需对应支持模型与思考配置 |
| **Anthropic Messages** | 末尾 `assistant` 预填充 | 仅对已知支持的旧模型且显式关闭 Thinking 开放；**Claude 4.6 及以后不开放** |
| **OpenAI Responses** | 普通 `assistant`（如 OpenRouter） / `partial: true`（如 Ark） | 仅对明确支持该扩展的路由显式配置，不得宣称原生 OpenAI 支持 |
| **Google Interactions** | 内部续写说明 | 不使用原生 assistant 预填充 |

- 无原生预填充能力时，附上已有正文与要求模型仅返回后续文字的内部指令。内部说明使用中断请求的编译语言，实际发出的说明随原生续传保存。重启或切换界面语言后沿用该原文。缺少语言或说明的旧冻结记录继续使用原有英文默认文案。后续文字接在原文末尾（空白与 Unicode 不改写），完整回复只结算一次；反复中断累计已保存正文；原生签名与推理独立保存；未完成的工具调用片段不得作为正文或执行指令。已保存的部分正文在刷新和重启后可恢复。

### 6.5 冻结请求与编码保留窗口（ADR-0048）

- **冻结请求**：每个游玩上下文在自身目录 `requests/` 仅保留最新 1 份完整冻结请求（以摘要命名），写入新请求时先原子写新文件、再更新续传项与状态、最后清理旧文件。
- **运行快照按引用折叠**：若某次发送的编译结果（编排方案身份、bootstrap、tools、followups、资源文件与脚本开关）与上下文基底（`base.json`/`index.json` 或前一份快照）一致，仅写 `play_prompt_run_reference` 引用与基底摘要，读回时校验摘要重建。
- **请求编码双运行窗口**：每个上下文仅保留最近 **2 次**最大 exchange 的主链请求编码（供「AI 读取」对比）；Google 后置请求进入派发时在同一窗口保存不含凭据且已遮蔽原生续传的诊断预览（其他协议在可安全遮蔽前不可用），并标明派发尝试、完整响应或取消；逐跳证据独立写入并在读取时合并，原生签名、token、未知 usage 扩展与 HTTP 错误正文不进入诊断投影。诊断写入失败不得影响游玩结算。

## 7. Prompt Preview 与「AI 读取」对比诊断

### 7.1 Prompt Preview 校验项

Prompt Preview 必须直接调用生产编译器与协议编码器，不得调用模型、创建会话、写树或维护近似拼装逻辑，并完整展示：

1. provider-neutral 逻辑消息与最终 provider role；
2. 每个 slot 的精确来源及未提供边界；
3. 最终 Markdown 正文与真实工具定义；
4. 附加材料展开与按需读取入口；
5. Provider 窗口／最大输出配置、Runtime 不做上下文准入的状态与缓存报告；
6. 去除凭据后的真实 HTTP method、endpoint path、header 名称与 request body；
7. 内部 DTO 字段泄漏扫描结果。

设定完善与世界修订的生产等价 Preview 复用同一游玩编译入口：处于逻辑起点时展示已提交的完整开场白，并将预览玩家原文单列为紧随 bootstrap 的首条普通 user 追加，不制造权威玩家历史。

### 7.2 「AI 读取」对比诊断

「AI 读取」面向同一时间线上相邻发送的真实运行编译结果，并另列下一次发送候选（候选不代表已发送；旧工具正文不代表当前字段值）：

- **下次编译材料**：`world.play-context.read` 保留原有响应字段 `nextFreshContext`。其 `contextMode` 为 `append` 时，预览包括重新编译的提示和已有的预载世界材料，实际发送还会沿用原生消息和工具往返；为 `fresh` 时，按当前端点编译提示、世界材料及适用的已提交原文。两者都标记 `previewScope: "compiled_materials"`。预览以当前世界和连接为准，未带入输入区草稿、发送方式选择或原样重试请求。对续传的逻辑上下文按次展开游玩轨迹中对应步骤的「本次上下文」。
- **前缀与顺序对比**：比较相邻发送的真实编译来源、顺序和逻辑文本公共前缀，并提示排在较大未变化材料之前的变化来源；仅提供建议，作者须在世界控制中显式调整顺序，Runtime 不自动重排或改变 Provider 会话隔离。
- **变更频次统计**：按叙事上下文分别统计发生真实正文变更与元信息变更的上下文数（同一上下文多次修改只计一次）；分叉与继续原上下文的时间线修订继承原分节身份，不因 Provider 会话改名而重置；缺少可识别上下文的旧提交不伪造计数。
- **编码与实报 Usage 对照**：展示每次运行首次派发的无凭据实际编码、JSON 前缀、内容块、显式缓存断点与 `prompt_cache_key`，以及 Provider 实际返回的 `cache read`、`cache write` 与 `uncached input`（缺失值标未报告）。
- **边界声明**：逻辑文本公共字节与 JSON 公共字节均不等于 Provider 可命中的 token 前缀；相邻请求 usage 并非受控收益实验，不能直接宣称缓存节省比例。

## 相关文档

- [产品基础](../product-foundation.md)
- [提示词编排、编排方案与世界控制框架规格](prompt-orchestration-and-presets.md)
- [游玩调用链、历史导航与世界生命周期规格](play-history-and-world-lifecycle.md)
- [世界状态维护与上下文衔接指南](../world-state-maintenance.md)
