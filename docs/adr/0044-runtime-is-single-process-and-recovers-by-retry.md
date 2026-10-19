---
status: accepted
---

# 运行时假定单进程、按世界串行，崩溃以重试恢复

维护者于 2026-10-19 确认了四个产品前提：一个数据目录同一时间只有一个服务进程；一个世界同一时间只在一个页面上游玩；被修改或重新生成替换掉的历史不需要保留；生成中途进程崩溃后重新调用一次模型、跑团判定重新掷骰都可以接受。此前的运行时按相反的前提设计：三套带 pid 存活检测与心跳的跨进程文件锁、为"不重调模型"持久化 Provider 返回与随机种子、97 处 fsync、把模型读取授权连同整棵 `state/` 指纹一起写盘并在恢复时要求逐字节一致。这些机制防的场景在本产品里不存在，自身却持续出错（#73）。本 ADR 记录新的不变量；各步实现与迁移由 #74、#75、#76、#77 跟踪。

**并发**：服务启动时在数据根目录持有一个排他启动锁，已有存活进程时拒绝启动。所有改变某个世界的操作在进程内按世界串行；读操作不排队，只依赖"写临时文件再 rename"的原子发布。不再有跨进程世界锁、pid 存活检测、心跳和过期回收。世界修订 epoch 仍持久保存，因为它是跨重启的编辑模式状态，不是并发锁；连续性修正的候选只存在于进程内存，进程退出即丢弃。删除世界先中止该世界的进行中生成，再删除目录。

**崩溃恢复**：原子 rename 是唯一的持久化保证，不为断电做 fsync。启动时凡处于进行中的生成一律标记为中断，由玩家重试，重试重新调用模型、重新掷骰。不保存 Provider 返回、结算事实和随机种子用于重放，也不为重放保留 operation 回执与请求指纹；客户端重复提交由进程内按 exchange 身份去重。

**修改玩家消息**：修改等于先把世界和模型上下文回退到被修改消息之前并删除其后的派生数据，再走一次普通发送（沿原上下文追加，或开启全新上下文）。回退之后的发送失败与普通发送失败同样处理，玩家重试即可。被替换的历史不保留，也不提供从被替换分支分叉。

**读取授权**："读过才能改"由提交时逐文件校验前像哈希保证。模型的读集合只放内存，进程重启、回退和开启全新上下文都从 bootstrap 授权重新开始；不再持久化授权检查点，也不以整棵 `state/` 树的指纹作为授权有效性的条件。

**存储**：不可变事实链剩余的用途只有回退和从故事事件分叉，二者都只需要每轮快照。是否用"当前文件 + 每轮快照"取代 [ADR-0033](0033-long-timelines-use-immutable-facts-and-rebuildable-projections.md) 与 [ADR-0036](0036-authority-facts-are-world-neutral-and-forks-retain-physical-closures.md) 的存储模型在 #77 评估，结论另立 ADR；在此之前二者关于存储布局的决定仍然有效。

被拒绝的方案：

- **保留跨进程锁"以防万一"**。锁本身有竞态（空 `owner.json` 使整个世界不可用），每个请求付出额外文件 IO 与加锁顺序约束，而被防的场景产品明确不支持。
- **保留 Provider 结果重放、只修复出错的路径**。重放要求每一步都有可恢复的幂等证据，正是回执、请求指纹、34 个崩溃注入点和大部分 fsync 的来源；重新调用一次模型的代价远低于维护这些证据。
- **保留授权检查点、指纹不符时退回 bootstrap**。这样可以止血，但检查点在解决的是缓存失效问题，逐文件前像哈希已经提供写入安全，整棵树指纹是脆弱的第二道门。

本 ADR 取代 [ADR-0032](0032-player-edits-append-current-world-timeline-revisions.md) 的时间线修订机制，但保留其"修改在当前世界进行、不创建新世界"的产品决定；取代 [ADR-0033](0033-long-timelines-use-immutable-facts-and-rebuildable-projections.md) 关于持久推进与 Provider 重放的部分、[ADR-0036](0036-authority-facts-are-world-neutral-and-forks-retain-physical-closures.md)、[ADR-0038](0038-world-revision-uses-one-locked-worktree.md)、[ADR-0042](0042-world-archives-reuse-fork-closures-through-a-quarantine.md) 中关于跨进程锁与 operation 幂等回执的部分、[ADR-0025](0025-prompts-compile-into-append-only-model-sessions.md) 中关于授权持久化的部分，以及 [ADR-0043](0043-tabletop-gameplay-is-world-identity-and-runtime-derives-resolution.md) 中"同一执行恢复时不重新抽样"的部分。[ADR-0034](0034-released-storage-formats-require-atomic-migrations.md) 继续约束已发布格式的迁移。
