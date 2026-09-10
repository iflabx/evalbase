# 原子发布与分支版本标签分配

- Status: Accepted
- Date: 2026-08-18
- Amended: 2026-08-31
- Decision role: Project Owner / Sole Developer

测试集版本只在一个 PostgreSQL 事务提交时变为可见：候选载荷和证据必须先作为不可变对象集合提交；发布事务锁定 `test_set`、复检全部内部安全条件、分配发布顺序与版本标签、写入小型最终 Manifest/commit marker，并原子插入版本、成员关系、内部初始指针和审计。冻结原型中的数据核对只提供警告；它不得被这些内部条件扩张成额外表单或用户可见阻断。

每个版本保存不可变的 `publication_order`、`generation`、可空 `branch_number`、唯一 `version_label` 和最多一个 `parent_version_id`。首版标签为 `v1`。父版本没有既有子版本时，新版本继续该路径：主路径显示 `v<generation>`，已有分支继续显示 `v<generation>-b<branch_number>`。父版本已有子版本时，新版本分配测试集内下一个从未使用的分支号并显示为 `v<generation>-b<branch_number>`；分支号和版本标签发布后永不复用。这样，从 `v1` 先发布 `v2`、`v3`，再回到 `v1` 派生时可得到 `v2-b1`，继续派生得到 `v3-b1`；再次从同一父版本派生会取得新的全局分支号。

`publication_order` 由已提交最大值加一得到，只表示发布时间顺序，不作为用户可见版本标签。发布失败不消耗发布顺序、代数或分支号；版本标签不能由客户端指定、重命名或覆盖。版本图只读取已提交的父子关系，不支持合并、rebase 或改挂父版本。

同一 `candidate_snapshot_id` 是发布幂等键并具有唯一约束；响应丢失或 Worker 重试只返回既有版本。对象成功但数据库回滚时留下的未引用对象由孤立对象回收器清理，PostgreSQL commit 始终是唯一可见性边界。Manifest 与导出证据同时保存稳定版本标签、发布顺序和父版本 ID，避免把标签代数误解为实际发布时间。

`default` 指针只可作为兼容既有数据与确定初始版本的内部事实；当前产品不提供“设为默认”、归档、重命名版本或任意版本比较操作。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#56-version-graph)和[数据与版本不变量](../architecture/phase1a-architecture.md#6-数据与版本不变量)。
