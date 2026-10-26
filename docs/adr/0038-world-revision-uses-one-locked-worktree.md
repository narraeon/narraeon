---
status: accepted
---

# 世界修订使用一份持久锁定工作树

> 按 [ADR-0044](0044-runtime-is-single-process-and-recovers-by-retry.md)，epoch 的"独占锁"是跨重启的编辑模式标记，由进程内按世界串行保证互斥，不再是跨进程锁；Apply 各阶段的 operation 幂等回执随之撤销。按 [ADR-0045](0045-world-history-is-current-files-plus-a-turn-ledger.md)（#106），Apply 把 state 与 control 的改动作为同一轮 `revision_apply` 提交，下文的 correction 加独立 control 发布及其 prepared／state committed／control published 阶段不再适用。

运行中世界的手动编辑和 AI 创作统一进入一份 `state/*`／`control/*` 修订工作树。进入修订页面只读取内容与历史；首次实际编辑或发送修订消息才从固定 Authority 端点和控制指纹创建一个持久 epoch，已有活动 epoch 则直接恢复，并以非过期独占锁阻止游玩及其他世界语义写入；本地名称不属于世界语义，因此仍可修改。`opening.md` 已经提交为 genesis 叙事，没有可供世界修订覆盖的当前文件。

手动保存和完整 AI 工具响应按顺序向同一 revision 发布，并共同追加逐文件 before／after 历史。活动 epoch 中的回滚直接恢复所选历史变化的 before-image，覆盖该文件此刻的值，同时追加一笔新的 rollback 变化；它不删除旧历史，也不要求整批回到某个快照。界面复用内容包设定完善的文件、对话、历史与 diff 交互，不另设手动／AI 模式。修订对话可用 history_list／history_search／history_read 只读导航这个 epoch 固定的已提交历史；这些调用不产生 revision 变化或逐文件历史，历史也不能被修订改写。

只有玩家执行 Apply 或 Discard 才结束 epoch。Apply 用一个稳定 operation ID 将 state 作为单笔 correction 提交，再以确定的 staging／previous 路径幂等发布 control；prepared、state committed 和 control published 阶段都持久保存，锁在 applied 已可恢复之前不会释放。Discard 不改变世界。封存后的历史只读，不再提供回滚。继续原 AI 对话会建立新的 epoch、追加高优先级边界并清空旧读取授权，要求模型重新读取。

修订工作树中的既有状态文档沿用 [ADR-0037](0037-setting-improvement-is-one-model-directed-conversation.md) 的物理删除与移动规则：删除要求目标已完整读取，且 currentSituation、frame slot、player-view selector 与其他文档 `$ref` 均未指向它，否则列出全部阻挡位置；移动保留文档身份与内容，且不覆盖已有路径。检查层以文档身份而非路径判断既有文档是否被改写。Apply 把删除作为同一轮 `revision_apply` 的前像变化提交（[ADR-0045](0045-world-history-is-current-files-plus-a-turn-ledger.md)），回退到应用前的端点即可恢复被删文件。

这项决定刻意不引入运行时 diff／merge／rebase：锁会暂时牺牲一边游玩一边改世界的能力，却使工作树始终只有一个基线，让回滚、崩溃恢复、Authority 幂等和控制发布都保持可证明。若未来需要多人或并行创作，应另行设计冲突模型，不能让活动世界在本契约下静默漂移。

世界修订复用预设独立作者编排，每次主动发送重编译，按目标解析世界修订机械说明与 epoch 数据；工具循环内固定请求快照。旧 schema 1 会话可精确读取，下一次新发送原子升级到 schema 2 并追加请求快照，原 bootstrap 和 Provider 历史不变。编排变化不会创建或结束 epoch、放宽读取授权或自动应用世界。每次发送的 bootstrap 另行预载当前工作树的目录、控制文档全文与世界框架注入的文档全文，这些预载文档只在该次编译所用的 revision 内视为已完整读取。
