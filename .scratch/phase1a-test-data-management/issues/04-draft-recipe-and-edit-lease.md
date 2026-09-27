# Phase 1A-04：Working Draft、Curation Recipe 与编辑租约

Status: ready-for-agent
Implementation: completed

Blocked by: [01](./01-utf8-csv-to-validated-v1.md)

## Outcome

用户可以创建或重新打开一个 Test Set 的唯一活跃 Working Draft，在连续工作台中执行完整 P0 结构化筛选、确定性抽样和人工取舍。租约与 expected revision 阻止陈旧覆盖；自动保存、确认接管和放弃草稿都有可见且可审计的结果。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Working Draft/Curation Recipe、G-06、G-07
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-04、FR-05
- [Domain language](../../../CONTEXT.md)
- [Architecture draft module](../../../docs/architecture/phase1a-architecture.md#63-working-draft--curation-recipe)
- [ADR-0004](../../../docs/adr/0004-postgres-coordination-for-jobs-and-draft-leases.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-DRAFT-*、F-FILTER-*、F-SAMPLE-*

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Test Set partial unique active draft、lease token/holder/expiry、draft revision、ordered Recipe steps、manual decisions、step counts 和审计 |
| Domain | open/apply/freeze/abandon、租约 acquire/renew/takeover、乐观 revision、筛选/抽样/人工包含排除确定性 |
| Public interface | 创建/打开草稿、续租/接管、保存命令、evaluate Recipe、冻结 revision、放弃的 S-HTTP |
| UI | 连续 Curation Workbench、自动保存状态、当前写者、接管确认、筛选/抽样编辑、每步计数和放弃动作 |
| Tests | Recipe S-MODULE conformance、可控 Clock、真实 PostgreSQL 并发/唯一约束、HTTP 和浏览器恢复测试 |

## Gap closure

1. G-06：冻结 missing/null、scalar/array contains、numeric comparison/coercion、range endpoint、boolean precedence、稳定 pre-sample order、ratio rounding 和类型解释失败语义。
2. G-07：冻结非生产 lease duration、renew interval 和 takeover grace；值保持运行配置，不成为领域含义。

## Acceptance Criteria

1. 新 Test Set 的 Working Draft 没有父版本；现有 Test Set 的草稿最多固定一个父版本。
2. 数据库约束保证每个 Test Set 最多一个 active Working Draft；并发创建只成功一次。
3. 每个写命令同时验证项目 capability、lease token 和 expected revision；任一不匹配都不能修改草稿。
4. 过期接管和明确确认接管保留已保存内容并写审计，不伪装为多人审批。
5. 自动保存记录 actor/time；关闭并重新打开浏览器可恢复 Recipe、人工取舍、映射引用、未映射确认和版本说明。
6. 支持等于、不等于、包含、范围、空值及布尔组合；不支持任意表达式或脚本。
7. 数量/比例抽样必须存储 seed；相同上游、Recipe 和 seed 产生相同记录集合与顺序。
8. 每个步骤显示 input、output、excluded、error counts，并可解释记录在哪一步退出。
9. 手工包含/排除保存 actor 和可选 reason；不得改变 Data Asset 或 Parsed View。
10. 在 Candidate ready 后继续编辑会 supersede 旧 Candidate，但不删除其不可变证据。
11. 放弃草稿不产生版本，不改变父版本、Data Asset 或历史；不提供草稿复制/分支。

PRD trace: AC-12 至 AC-15、AC-43 的单草稿/租约部分。

## Out of scope

- 多个并行草稿、协同编辑、分支/合并、自动去重和任意代码执行。
- 草稿附件总容量；由 Ticket 06 完整实现。
- 多资产映射和 `v2`；由 Ticket 07 实现。

## Definition of Done

- G-06/G-07 contract Fixture 固化并由公共模块与 HTTP 测试消费。
- 租约/陈旧写使用真实 PostgreSQL 并发测试，不以最后写入覆盖。
- 浏览器可独立演示自动保存、重新打开、接管和放弃。

## Comments

- 2026-08-19：Project Owner 授权后完成本 Ticket 的最小纵向闭环。实现 Working Draft 唯一性、编辑租约、续租/接管、expected revision 防陈旧覆盖、完整 Recipe 筛选/抽样/人工取舍、自动保存/恢复/放弃和 Candidate supersede；未实现 Ticket 06、Ticket 07、Phase 1B 或 Production Gate。
- 验证：相关 Recipe/租约单元、真实 PostgreSQL 集成、Tracer 集成和 `draft-workbench` 浏览器场景通过；类型检查、Lint、格式检查和构建通过。完整最终验证结果以当前后续 Ticket 的回归套件为准。
- Code Review：Standards 与 Spec 双轴复审无 P0/P1；保留的非阻断 P2 不改变当前 Ticket 范围。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成生产、安全、隐私、法务或合规批准。Commit：`d996d3b`。Ticket 05 随后在单独授权下完成。
