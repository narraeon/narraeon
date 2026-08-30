---
status: accepted
---

# 玩家消息修改追加当前世界时间线修订

> 身份、恢复快照与分叉复制机制已由 [ADR-0036](0036-authority-facts-are-world-neutral-and-forks-retain-physical-closures.md) 取代；本 ADR 保留“修改在当前世界追加修订而不创建新世界”的产品决定。

世界 Authority 继续保持单一、不可改写的提交总顺序，但当前时间线不再被限定为从 genesis 简单累加到最新 head。玩家确认修改一条已提交玩家消息时，Runtime 在同一 world ID 的当前 head 上追加一笔 timeline revision：该提交保存所选消息逻辑父端点的完整 state、history 与材料恢复快照，并原子追加修改稿；原消息及其后续提交仍可由旧 head 恢复，只是不再进入当前投影。调用链同时换用新 chain ID，避免后续模型响应与被替换链上的 operation 身份冲突。

“创建分叉”保留为唯一创建新世界的历史操作：它复制所选 head 的完整 Authority 前缀，重分配世界、operation 与历史消息身份，发布后不依赖来源世界。我们拒绝直接删除旧提交或移动 head，因为那会破坏恢复与幂等证据；也拒绝继续让“修改”自动创建新世界，因为编辑当前对话与显式复制世界是两种不同的用户授权。
