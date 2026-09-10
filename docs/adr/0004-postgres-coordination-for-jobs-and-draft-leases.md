# 使用 PostgreSQL 协调后台作业与草稿租约

- Status: Accepted
- Date: 2026-08-18
- Decision role: Project Owner / Sole Developer

Phase 1A 使用 PostgreSQL 作业表、行锁和租约协调 Worker：Worker 通过 `FOR UPDATE SKIP LOCKED` 领取作业，作业以不可变输入构造唯一幂等键，并用租约过期、有限重试和 `cancel_requested` 支持崩溃恢复与安全取消。同一数据库事务同时提交领域命令、审计和作业行，不增加 Redis、消息代理或第二套 outbox。

工作草稿也使用 PostgreSQL 租约，但租约不替代项目边界；每个写命令必须同时通过内部 Owner 绑定、lease token 和 expected draft revision。发布进入最终事务以及永久删除确认提交之后不再允许取消。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#7-内部作业幂等与错误)。
