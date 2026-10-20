---
status: accepted
---

# 产物随世界目录保存，记录自带状态，没有事件日志

玩法产物（[ADR-0028](0028-artifacts-project-through-a-trusted-frontend-host.md)）保存在 `worlds-file-native/<worldId>/artifacts/` 中，与世界的 `state/`、`control/`、`history/` 同处一个目录。每条产物一个文件 `records/<sequence>.json`，记录自带 `status`（`pending`、`active`、`superseded`、`cleared`）、绑定的核心端点 `head`，以及被清除时的清除来源；状态变化通过临时文件加 rename 就地更新。operation 生命周期文件保留在 `artifacts/operations/<sha256(operationId)>.json`，供扩展状态显示与冷恢复使用。

**不再有事件日志。** 投影事件（activate、supersede、bind_head、clear）、幂等事件追加、`ignored_call` 身份账本、`core_materialization_pending` 状态和由事件补写记录的修复路径全部删除。读取不再重放事件：读取目录、校验每条记录，就得到当前状态。

**分叉与备份是目录复制。** 复制世界目录后，`forkArtifactClosure` 只在暂存副本上工作：保留已提交、已附着于回复、通过频道投影选中、绑定端点不晚于分叉端点的记录，删除其余记录与 operation 文件，并改写身份——记录的 `worldId`、`operationId` 与 operation 文件的 `context`，其中 `operationId` 为 `artifact-fork:<targetWorldId>:<sha256(原 operationId)>`，与 v0.6.0 的命名一致。`FileNativeWorldStore.deriveWorld` 在回退到分叉端点之后调用它。`stageFork`、`runtime/artifact-fork.json` 与 `fork-restored.json` 删除，分叉不再有延迟展开。

**回退按文件删除。** `discardAfterHead` 删除端点序号大于回退点的记录与 operation 文件。

**清除直接写状态，并记录清除它的尝试。** 清除把匹配记录改为 `cleared`，并在记录上保存 `clearedBy`（operation、request、attempt 与清除前的状态）。同一 operation 中同一请求的更高 attempt 注册时，把这些记录恢复为清除前状态。这保留了 v0.6.0 中"失败的尝试不能留下清除"的语义，而不需要事件日志。清除不做幂等身份检查：过期清除只返回忽略结果，不写任何账本。

**旧布局一次性迁移。** v0.6.0 的 `artifact-store/` 布局（[ADR-0034](0034-released-storage-formats-require-atomic-migrations.md)）由 `LegacyArtifactStoreMigration` 在世界首次访问时折叠：在同一份事件回放规则下算出每条记录的状态与端点，写入 `artifacts/`，然后删除旧记录、事件与 operation 文件。`runtime/artifact-fork.json` 未展开的分叉快照同样作为迁移来源。所有世界迁走后删除 `artifact-store/`。迁移是可重入的：源在输出完整写入之前不删除。夹具 `tests/runtime/fixtures/artifact-store-v060/` 由 v0.6.0（`34b97c0`）的代码生成，迁移后的读取结果必须与它逐项一致。

**依据。** [ADR-0044](0044-runtime-is-single-process-and-recovers-by-retry.md) 删除了 Provider 结果重放，事件日志唯一的用途——重放派生状态与幂等地补写事件——随之消失。[ADR-0045](0045-world-history-is-current-files-plus-a-turn-ledger.md) 把世界定义为一个目录，产物外置只是为了让分叉需要暂存。产物跟随目录后，分叉与备份不再需要特殊路径。

被拒绝的方案：

- **保留事件日志，只把它搬进世界目录。** 事件只在重放时有用，而重放已经删除；保留它只会留下两份需要同步的状态。
- **把产物纳入轮账本的前像。** 玩法产物由提交之后运行的后置请求生成，不属于任何一轮的提交；把它们放进轮账本会把后置请求的写入与轮的回退耦合。
- **清除保持为事件，以保留跨尝试回滚。** 回滚需要知道清除来源，把来源记在记录上与记在事件上信息相同，而前者不需要读取整个日志。

本 ADR 取代 [ADR-0028](0028-artifacts-project-through-a-trusted-frontend-host.md) 与 [ADR-0036](0036-authority-facts-are-world-neutral-and-forks-retain-physical-closures.md) 中关于产物持久化位置、事件模型与分叉暂存的决定；频道投影、可信前端宿主与权威提交的边界保持 ADR-0028 的决定。
