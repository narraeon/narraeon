# 提示词编译为稳定的逻辑模型上下文

`PromptCompiler` 把主持预设、世界提示框架、精确 slot 和玩法叙事规则确定性编译为 `runtime_system`、`author_instruction`、`world_context`、`player_input` 等逻辑 role 的 Markdown，再由 provider adapter 映射真实协议。Runtime 不执行语义选材、不把内部 DTO 塞进正文，也不让调用方绕过编译器自行拼接生产提示；Prompt Preview 必须复用同一编译结果。

全新上下文从当前端点建立稳定 bootstrap，玩家原文、完整模型响应和工具交换随后按顺序追加；Provider conversation、缓存、续传项和私有推理可以提高连续性与效率，但都不是世界权威或唯一恢复来源。输出能力以当前模型绑定的真实配置为准，不使用脱离模型的固定产品预算。
