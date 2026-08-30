---
status: accepted
---

# Authority 事实世界中立，分叉保留物理闭包

世界所有权、不可变连续性事实、operation 幂等和活动模型会话是四种不同身份。`worldId` 只属于世界本地外壳与可变投影；历史消息使用 Authority 内局部身份，不可变提交不保存 `worldId` 或 `operationId`。operation receipt 单独把一次请求绑定到已接受事实；`commit:N` 继续作为 V1 世界内端点别名，事实父关系同时携带内容摘要，genesis 摘要是第一笔提交的真实锚点。

每笔 Authority 提交分别保存不可改写的 audit parent、当前时间线的 timeline parent 和直接结果 root。普通游玩与修正的两个父关系相同；玩家修改在当前 audit head 追加 timeline revision，但以被修改消息的逻辑父端点作为 timeline parent。修订事实只保存双父关系、修改请求指纹与直接结果引用，不嵌入完整 replacement state/history，也不从 genesis 逐笔重放提交。当前 head 的分叉直接采用已接受小 root 中的结果引用，不解码或重算该 Authority 事实；完整链校验只属于显式审计。

结果 root 引用不可变 state manifest、history segment、材料集合和内容 blob。恢复旧端点直接读取该 root；`state`、`history`、材料清单和页面时间线仍只是可重建的世界本地投影。接受顺序先写不可变对象，再写 prepared receipt，再切换小 continuity head，最后幂等物化；未被 receipt 接受的下一 epoch 可以安全丢弃并由请求重建。

创建分叉在统一的来源 snapshot lease 下读取 Authority、当前 control 与安全页面／模型轨迹前缀，在同一目标 staging 中保留所选物理闭包，再一次性发布世界目录；删除、控制变更和 Authority 推进不能切断这个快照。不可变文件优先 hardlink，失败后尝试 reflink，最后逐字节复制；可变 state、control、history、事件摘要、上下文状态和小 head 只能 reflink 或复制，绝不 hardlink。分叉不解析、改写、重算或逐笔物化祖先 Authority 事实，也不调用 Provider 或重新执行工具；删除来源后，目标的物理闭包仍可冷恢复、继续、修改和再次分叉。

已发布 Authority v1/v2 与页面时间线 v3 按 [ADR-0034](0034-released-storage-formats-require-atomic-migrations.md) 精确迁移：旧源保持只读，旧世界前缀身份确定性归一为局部身份，所有端点与不透明 Provider／工具证据验证完成后才最后发布 `continuity-head.json`。不认识或无法证明等价的来源 fail closed。

本 ADR 保留 [ADR-0032](0032-player-edits-append-current-world-timeline-revisions.md) 的“修改仍在当前世界追加修订”决定，以及 [ADR-0033](0033-long-timelines-use-immutable-facts-and-rebuildable-projections.md) 的“小 head 与惰性页面投影”决定；它取代二者关于完整 replacement snapshot、世界／operation／消息身份重映射、分叉逐笔遍历提交和逐笔重建投影的实现机制。
