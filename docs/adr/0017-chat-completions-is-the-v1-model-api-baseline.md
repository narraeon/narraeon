# Chat Completions 是 v1 的模型 API 兼容基线

V1 在本地保存可手动切换的模型连接，以 OpenAI-compatible Chat Completions 作为默认兼容适配器，并同时提供 OpenAI Responses、原生 Anthropic Messages 和 Google Interactions 适配器；产品不固定供应商、模型或自动故障转移。连接必须通过显式能力测试，配置中的推理强度、流式、工具调用和续传信息由对应 adapter 原样映射；远程 conversation、缓存和私有推理只能加速 ModelHost，不能成为世界连续性或恢复来源。

Google Interactions 使用手工输入的模型 ID 和标准方言，能力设置保持 Provider 默认；没有任何具体模型或服务版本已经通过真实四入口验收。适配器编码和合成传输测试不证明服务支持该模型、工具 schema、签名或 token 续接。System、绑定和恢复边界见 [ADR-0035](0035-provider-continuation-is-opaque-and-bound.md) 与 [ADR-0038](0038-world-revision-uses-one-locked-worktree.md)。
