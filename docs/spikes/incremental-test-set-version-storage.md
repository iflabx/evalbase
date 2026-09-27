# 测试集增量版本存储 Spike

- 日期：2026-09-18
- 状态：已完成隔离技术验证；不是正式功能实现或发布批准
- 方案：[测试集增量版本存储技术方案](../proposals/incremental-test-set-version-storage.md)
- 原始结果：[JSON 报告](./incremental-test-set-version-storage.json)
- 运行基线：`3f1c725`

## 1. 目的与范围

本 Spike 用尽量小的同构 PostgreSQL 表和 MinIO bucket，验证下列内部存储策略能否保留完整版本语义：

```text
普通派生版本 = 本次 add / update / delete 的稀疏变更
周期 Checkpoint = 完整 case_id / revision_id / position 指针
读取版本 = 最近 Checkpoint + 后续 Delta
```

实验使用 10,000 条小型合成记录。它不修改正式表、正式 Web/API、前端、部署容器、部署卷或真实数据；也不实现位图、DVC、Dolt、lakeFS、Delta Lake 等替代基础设施。

“旧方案”模拟每次派生都写入 10,000 条成员指针及完整 records 对象；“Delta”模拟只写本次变更和小型 manifest。两个方案都继续复用未变记录的正文修订。

## 2. 实验环境与方法

- 通过独立 Compose project `evalbase-incremental-storage-spike-run1` 启动仅供实验使用的 PostgreSQL 与 MinIO；网络是 internal，二者没有宿主机端口映射。运行必须显式设置 `SPIKE_ISOLATED=1`，且脚本只接受该 Compose 中名为 `spike` 的数据库和专用 bucket。
- 运行前执行 `DROP SCHEMA IF EXISTS spike CASCADE`，只重置该实验 schema；bucket 使用 `evalbase-incremental-storage-spike`，内容均为运行时生成的合成文本。
- PostgreSQL 与 MinIO 均使用 Compose 文件中固定 digest 的镜像；Spike 以现有固定 Node 镜像、挂载工作树运行。
- 每个场景只运行一次；`elapsedMs` 受本机和 MinIO 往返影响，只作为方向性证据。`walBytes` 由前后 `pg_current_wal_lsn()` 差值测得。
- 记录对象大小包含 MinIO 的不可变 payload 和 commit marker；测试使用随机运行 ID，避免内容寻址去重掩盖一次发布应写入的数据量。

## 3. 真实结果

本次结果来自 [JSON 报告](./incremental-test-set-version-storage.json) 中 10,000 条记录的运行。

| 场景                | 成员/变更行 | PG WAL bytes | MinIO 总 bytes |  发布耗时 |
| ------------------- | ----------: | -----------: | -------------: | --------: |
| 旧方案：修改 1 条   | 10,000 成员 |    2,118,152 |      1,287,050 | 221.93 ms |
| Delta：修改 1 条    |      1 变更 |          624 |            459 |  43.08 ms |
| 旧方案：修改 100 条 | 10,000 成员 |    2,122,952 |      1,290,530 | 237.41 ms |
| Delta：修改 100 条  |    100 变更 |       22,752 |          7,075 |  86.09 ms |

在这一次运行中：

- 修改 1 条时，Delta 相比完整成员写入少约 3,394 倍 WAL，少约 2,804 倍 MinIO 字节；
- 修改 100 条时，Delta 少约 93 倍 WAL，少约 182 倍 MinIO 字节；
- 耗时同样下降，但只测量一次，不能作为稳定性能承诺或容量预测。

实验结束时，旧方案表包含初始版与两个派生版共 30,000 条成员行；Delta 侧包含 122 条变更行（1 条、100 条、18 条主链变化、1 条 Checkpoint 后变化和两条分支变化）以及两个各 10,000 条成员的 Checkpoint。关系表总分配大小不能直接用于方案空间对比：它累积了多个版本和两个完整 Checkpoint，且 PostgreSQL 页与索引存在固定开销。

## 4. 正确性验证

以下断言均为 `true`，失败会让运行直接退出：

| 验证                                                               | 结果             |
| ------------------------------------------------------------------ | ---------------- |
| 修改 1 条后，旧完整成员结果与 Delta 解析结果一致                   | 通过             |
| 修改 100 条后，旧完整成员结果与 Delta 解析结果一致                 | 通过             |
| 从 `v1` 到 `v20` 的小 Delta 链物化为 Checkpoint 后，成员和顺序不变 | 通过             |
| 以 `v20` 为 Checkpoint 重放其后 `v21` 变化，与从 `v1` 完整回放一致 | 通过             |
| 从 `v1` 并行派生两条分支，均不污染主路径或彼此                     | 通过             |
| 删除最后一条、追加一条后，逻辑顺序和总数正确                       | 通过             |
| Resolver 拒绝同位置冲突                                            | 通过（单元测试） |

## 5. 结论

该方向通过最小可行性验证：对于少量变更，稀疏 Delta 能避免每次派生重复写入 10,000 条成员关系和完整 records 对象；普通关系表 Checkpoint 可以恢复完整、稳定顺序的逻辑快照。它符合 EvalBase 的“用户看到完整不可变版本，底层允许增量存储”的既定约束。

这不是“已完成增量版本功能”的证明，也不应据此修改正式数据。正式实现前仍须将解析器收敛在一个内部模块，并覆盖双格式读取、分页/筛选、完整 hash 与数据核对、来源、下载缓存、幂等发布、Checkpoint 调度及永久删除时切断后代存储依赖。

## 6. 未覆盖项与下一步

本 Spike 没有测量峰值内存、冷热缓存、重复运行分布、真实 100 MB 内容、完整 hash/核对的 O(N) 扫描、真实分页/筛选/CSV 延迟，也没有验证幂等重试、Worker 停止或深度上限、正式 API、浏览器、下载缓存、失败恢复、来源或墓碑删除生命周期。`writeChanges` 为逐条 INSERT，正式实现应在确认公共协议后再评估批量写入，不能把本次实现当作最终写入路径。

本结果已由 [ADR-0011](../adr/0011-incremental-test-set-version-storage.md) 接受并固定 schema、manifest、Checkpoint 阈值与删除依赖切断策略。[Spec](../../.scratch/phase1a-test-data-management/spec.md) 与 [Test Plan §H](../test-plan-phase1a.md#h-增量版本存储-tickets-3338) 已同步，Tickets 33–38 已创建且均未开始。只有相应 Tickets 完成迁移与全生命周期验证后，才允许正式版本写入 Delta。
