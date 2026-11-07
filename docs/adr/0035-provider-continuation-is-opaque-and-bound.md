---
status: accepted
---

# Provider 续传载荷必须原样保留并绑定会话

Provider 响应同时承担两种职责：Runtime 需要解析可见正文、返回推理、工具调用与 usage，下一次模型请求又需要重放协议规定的原生 assistant 片段。把前者重新序列化成后者会丢失签名、加密推理、redacted block、未知扩展字段和 Provider 要求的顺序；保存整个 HTTP response 又会把 ID、usage 与传输外壳误当成可追加消息。Claude thinking 尤其不是应从正文切割出的文本，而是带协议身份与签名约束的结构化块。

因此 Runtime 将二者分离：模型调用投影只供工具执行、诊断、界面呈现和 Authority 结算分类；Provider 续传载荷是不透明但可校验的协议原生 append fragment。Chat Completions 保存完整 assistant message，OpenAI Responses 保存完整 `output` items，Anthropic Messages 保存完整 assistant `content` blocks，Google Interactions 保存完整有序 `steps`，包括签名和未知扩展字段。下一次请求直接追加该载荷，不从 `text`、`reasoningContent` 或 `toolCalls` 重建，也不追加完整 HTTP response。流式解码器在完成事件上形成同一种载荷，并保留解析器不认识的协议字段。

Google Interactions 的 bootstrap 仅接受文本；前置 System 合并成一个 `system_instruction`，普通编排中 User／Assistant 之后出现 System 会明确拒绝。后置请求提示作为带来源标记的追加用户输入编码。世界修订唯一例外是经过同一世界持久 epoch 和来源校验的 Runtime 边界：当前边界进入 System，历史原位置保留 Runtime 通知，见 [ADR-0038](0038-world-revision-uses-one-locked-worktree.md)。`requires_continuation` 在同一逻辑 exchange 中使用冻结的 `store:false` 输入与配置和内存中的 token 续接，最多 16 跳、总时限一小时。续接前及其后的每一跳均须具有完整生命周期；缺失 token、重复 token、中断、超时或非完成终态安全停止。所有 steps 保持原序，只有最终完整响应可结算工具或正文。普通单跳保留原有兼容规则。

新上下文的 Runtime 初始材料预加载属于 bootstrap，独立于上述 Provider 续传。encoder 可以为真实读取的初始材料生成一组调用／结果消息，但必须标明 Runtime 来源，不伪造模型推理或签名，不把它保存成模型响应、实际工具执行或 Authority 事实。追加上下文复用这份初始材料，后续真实 Provider 返回仍严格原样续传。

Authority 结算只查看完整投影是否含工具调用，不改写续传载荷：含任何工具调用的响应一律是工具中间步，其 text 只留作诊断投影；工具状态变化仍可独立提交，随后把原生 assistant 片段和 Runtime 工具结果继续交给 Provider。不含工具调用且 text 非空的完整响应才成为主持叙事。流式 text 在完成前保持待定，不能因先于工具调用片段到达就提前晋升为故事。

每次用户主动发送、修改后发送或重发，Runtime 解析当前选中的连接并冻结本次发送及工具往返的 endpoint、模型与编码参数。历史绑定只作为诊断和原生续传兼容证据；协议不兼容或载荷缺失、损坏时阻止发送并指引全新上下文，不伪造原生续传。修改历史消息先验证保留的前缀，再改写时间线。

包括 Google Interactions 在内，派发后断线、取消、进程中断或不完整终态只丢弃未结算片段；用户可显式从本地最后完整结算的步骤继续。已持久的工具结果和状态不重复执行，不重复提交原文或叙事。冻结的提示材料和原生上下文保留，新的主动重发使用当前兼容连接；同一次发送内不会切换配置。

返回推理只作为 Provider 明示的诊断投影保存，不被宣称为隐藏思维，也不进入玩家正文、已提交叙事或世界 Authority；签名、redacted 或加密推理可以为了续传留在不透明载荷中，但不向玩家投影。Chat Completions 代理若只暴露 `reasoning_content`，就不能保证 Claude 签名 thinking 的无损续传；需要该能力时选择 Anthropic Messages，或选择能返回 `reasoning.encrypted_content` 的 OpenAI Responses 兼容路径。

工具结果是 Runtime 事实，不属于 Provider 续传载荷。encoder 按目标协议生成对应结果项；其中 Anthropic 要求同一轮并行调用的全部 `tool_result` blocks 位于紧随 assistant 的同一个 `user` message，并对失败结果携带 `is_error`。这层协议分组不能反过来改变 Runtime 中逐调用的工具记录、执行顺序或 Authority 边界。

这个决定增加了按协议维护 codec 与持久格式的成本，但让请求、Provider 返回推理、工具调用、叙事边界和缓存 usage 都有单一诚实来源：请求由生产 encoder 生成，续传由原生载荷生成，界面由解析投影生成，Authority 只由成功结算的玩家原文、工具步骤产生的世界变化和终态无工具叙事生成。Anthropic 原生块和 CLIProxyAPI 明示的 `cache_control` 扩展可以标记真实稳定前缀；标准协议没有等价能力时保持 provider-managed，任何估算都只报告字节而不冒充 Provider token 命中。CLIProxyAPI 还把 `prompt_cache_key` 当成执行会话身份，所以 Runtime 为每条冻结模型调用链生成不泄露原始 ID 的稳定散列，既保留同链 affinity，也阻止不同会话共享代理重放状态。
