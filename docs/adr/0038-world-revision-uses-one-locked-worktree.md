---
status: accepted
---

# 世界修订使用一份持久锁定工作树

运行中世界的手动编辑和 AI 创作统一进入一份 `state/*`／`control/*` 修订工作树。进入修订页面只读取内容与历史；首次实际编辑或发送修订消息才从固定 Authority 端点和控制指纹创建一个持久 epoch，已有活动 epoch 则直接恢复，并以非过期独占锁阻止游玩及其他世界语义写入；本地名称不属于世界语义，因此仍可修改。`opening.md` 已经提交为 genesis 叙事，没有可供世界修订覆盖的当前文件。

手动保存和完整 AI 工具响应按顺序向同一 revision 发布，并共同追加逐文件 before／after 历史。活动 epoch 中的回滚直接恢复所选历史变化的 before-image，覆盖该文件此刻的值，同时追加一笔新的 rollback 变化；它不删除旧历史，也不要求整批回到某个快照。界面复用内容包设定完善的文件、对话、历史与 diff 交互，不另设手动／AI 模式。

只有玩家执行 Apply 或 Discard 才结束 epoch。Apply 用一个稳定 operation ID 将 state 作为单笔 correction 提交，再以确定的 staging／previous 路径幂等发布 control；prepared、state committed 和 control published 阶段都持久保存，锁在 applied 已可恢复之前不会释放。Discard 不改变世界。封存后的历史只读，不再提供回滚。继续原 AI 对话会建立新的 epoch、追加高优先级边界并清空旧读取授权，要求模型重新读取。

这项决定刻意不引入运行时 diff／merge／rebase：锁会暂时牺牲一边游玩一边改世界的能力，却使工作树始终只有一个基线，让回滚、崩溃恢复、Authority 幂等和控制发布都保持可证明。若未来需要多人或并行创作，应另行设计冲突模型，不能让活动世界在本契约下静默漂移。
