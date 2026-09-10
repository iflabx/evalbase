# PostgreSQL 与 MinIO 的持久化职责

- Status: Accepted
- Date: 2026-08-18
- Decision role: Project Owner / Sole Developer

PostgreSQL 是 Phase 1A 的结构化控制与查询真源，保存身份、状态、关系、Source Record 查询面、事务、租约、作业、血缘和审计；MinIO 是不可变字节与产物真源，保存原始 blob、候选/版本文件、交付包和 staging。数据库只能引用带完整 commit marker 的对象集合，MinIO key 不承载领域状态，bucket 列表也不能决定对象是否对用户可见。

两者使用服务器本地持久化卷且不做系统备份；MinIO 不启用会保留在线旧对象版本的版本保留或 Object Lock。选择对象先完成、数据库后引用，使跨存储失败最多产生可回收孤立对象，而不会产生内容缺失的可见领域对象。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#4-数据职责)。
