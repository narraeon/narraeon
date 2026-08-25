# Chat Completions 是 v1 的模型 API 兼容基线

V1 在本地保存可手动切换的模型连接，以 OpenAI-compatible Chat Completions 作为默认兼容适配器，并同时提供 OpenAI Responses 与原生 Anthropic Messages 适配器；产品不固定供应商、模型或自动故障转移。连接必须通过显式能力测试，配置中的推理强度、流式、工具调用和续传信息由对应 adapter 原样映射；远程 conversation、缓存和私有推理只能加速 ModelHost，不能成为世界连续性或恢复来源。
