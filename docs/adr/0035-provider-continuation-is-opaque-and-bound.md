---
status: accepted
---

# Provider 续传载荷必须原样保留并绑定会话

Provider 响应同时承担两种职责：Runtime 需要解析可见正文、返回推理、工具调用与 usage，下一次模型请求又需要重放协议规定的原生 assistant 片段。把前者重新序列化成后者会丢失签名、加密推理、redacted block、未知扩展字段和 Provider 要求的顺序；保存整个 HTTP response 又会把 ID、usage 与传输外壳误当成可追加消息。Claude thinking 尤其不是应从正文切割出的文本，而是带协议身份与签名约束的结构化块。

因此 Runtime 将二者分离：模型调用投影只供工具执行、诊断和界面呈现；Provider 续传载荷是不透明但可校验的协议原生 append fragment。Chat Completions 保存完整 assistant message，OpenAI Responses 保存完整 `output` items，Anthropic Messages 保存完整 assistant `content` blocks。下一次请求直接追加该载荷，不从 `text`、`reasoningContent` 或 `toolCalls` 重建，也不追加完整 HTTP response。流式解码器在完成事件上形成同一种载荷，并保留解析器不认识的协议字段。

每条模型会话同时冻结完整续传兼容绑定：endpoint、协议与方言、模型、续传 codec、推理／摘要配置、输出能力、工具策略和缓存策略。凭据与传输超时可以在语义绑定不变时更新；其余字段变化、载荷缺失、载荷损坏或 codec 不兼容都 fail closed，要求从当前 Authority 开始全新上下文，不能静默降级为投影重建。

请求已派发但没有完整结果时同样 fail closed。传输中断、无法确认的响应或进程在“派发可能已经开始”之后退出，都不能用旧请求重试，因为模型可能已经产生工具调用或其他外部可见结果；只有 Provider 在生成前明确拒绝，或持久状态能证明派发尚未发生，才允许原样重试冻结请求。

返回推理只作为 Provider 明示的诊断投影保存，不被宣称为隐藏思维，也不进入玩家正文、已提交叙事或世界 Authority；签名、redacted 或加密推理可以为了续传留在不透明载荷中，但不向玩家投影。Chat Completions 代理若只暴露 `reasoning_content`，就不能保证 Claude 签名 thinking 的无损续传；需要该能力时选择 Anthropic Messages，或选择能返回 `reasoning.encrypted_content` 的 OpenAI Responses 兼容路径。

工具结果是 Runtime 事实，不属于 Provider 续传载荷。encoder 按目标协议生成对应结果项；其中 Anthropic 要求同一轮并行调用的全部 `tool_result` blocks 位于紧随 assistant 的同一个 `user` message，并对失败结果携带 `is_error`。这层协议分组不能反过来改变 Runtime 中逐调用的工具记录、执行顺序或 Authority 边界。

这个决定增加了按协议维护 codec 与持久格式的成本，但让请求、Provider 返回推理、工具调用、叙事边界和缓存 usage 都有单一诚实来源：请求由生产 encoder 生成，续传由原生载荷生成，界面由解析投影生成，Authority 只由成功结算的玩家原文、可见叙事与世界变化生成。Anthropic 原生块和 CLIProxyAPI 明示的 `cache_control` 扩展可以标记真实稳定前缀；标准协议没有等价能力时保持 provider-managed，任何估算都只报告字节而不冒充 Provider token 命中。CLIProxyAPI 还把 `prompt_cache_key` 当成执行会话身份，所以 Runtime 为每条冻结模型调用链生成不泄露原始 ID 的稳定散列，既保留同链 affinity，也阻止不同会话共享代理重放状态。
