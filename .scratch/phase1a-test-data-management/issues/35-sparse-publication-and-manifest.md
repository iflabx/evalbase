# EvalBase-35：稀疏发布与 Delta manifest

Status: ready-for-agent
Implementation: completed

Blocked by: 无；[Ticket 34](./34-unified-version-resolution.md) 已通过 Owner checkpoint，且本 Ticket 已获授权并完成。

## Outcome

实现只为变化记录写修订、Delta 与正式 manifest 的内部原子发布能力。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 实现 add/update/delete 净操作验证：父 case/revision 匹配、同 case 不重复、来源真实、整版容量与 Metadata 合法；复用旧修订，净零发布合法。
2. 按 ADR-0011 生成含新正文和来源的正式 manifest；固定哈希及序列化 golden fixture，MinIO commit marker 和 PG 引用一致。普通派生无全量成员或 records 复制。
3. 原子复检父状态、分配标签、版本/变化/幂等结果一起提交；同一父版本两次并发发布合法且分支号唯一，同 key 重试只得一个版本。
4. 明确 candidate、manifest、in-flight 引用与孤立回收的兼容，失败后不产生可见半版或标签号洞。
5. 本 Ticket 只接内部测试 seam，公共前端/API 发布仍 legacy；不提前注册第二套试验发布入口。
6. 前端 UI 必须对齐冻结原型；无 UI 修改时保留既有页面，涉及 frontend-v3 时先列明字段、控件顺序、标签、启用状态、空/错状态的 parity 表。禁止新增登录、格式选择、Checkpoint、Job、治理或其他原型外入口。

## Necessary tests

正常：10,000 条小合成记录改 1/100 条，比较完整结果并记录请求/对象字节、变化行、WAL；正式 manifest 包含正文，不能沿用 Spike 字节数。边界：并发派生与同 key 重试、对象成功后事务失败/提交后响应丢失；容量精确边界复用现有 fixture。只跑相关发布集成和静态检查。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint（与 Ticket 36 合批）

本张完成后提交内部 Delta 发布、失败重试和现有 legacy 流程的自动化证据，不建立单独人工 checkpoint，也不占用一套待验收环境。明确本张没有新的浏览器控件。

记录固定 SHA、测试结果、未测项和资源清理情况后停止；Ticket 36 仍须 Owner 单独授权。Ticket 36 完成时再按 [Test Plan §H.3](../../../docs/test-plan-phase1a.md#h3-切换与验收规则) 建立 35+36 的合批 checkpoint；该批通过前不解除 Ticket 37 的依赖。

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。
- 2026-09-27：Owner 授权后在 `codex/ticket-35-sparse-publication` 完成内部稀疏发布，实施提交 `f30a45e`。净 add/update/delete、父 revision 和来源复检、整版容量、路径位置高水位、完整逻辑 hash、正式 Delta manifest 与 MinIO marker、数据库原子提交及幂等结果均已实现；普通派生不复制 `version_member` 或全量 records。`candidate_snapshot.sources` 保留来源资产引用，公开派生写入与前端仍为 legacy。路由盘点：既有派生 API `reused`（本 Ticket 不改其注册与处理）；无 `narrowed`/`retired` 路由，无新增公开入口。
- 验证：`npx vitest run tests/integration/sparse-publication.test.ts` 8/8；`tests/integration/solo-test-set-v1.test.ts` 4/4；`tests/integration/incremental-schema-migration.test.ts` 6/6；`npm run typecheck`、定向 `npx eslint`、`git diff --cached --check` 均通过。合成 10,000 条基线修改 100 条：请求 15,577 B、manifest 83,668 B、WAL 166,896 B、变化行 100、复制成员 0；修改 1 条：请求 160 B、manifest 1,580 B、WAL 4,992 B、变化行 1、复制成员 0。另覆盖 10,001 条拒绝、5/6 资产、100,000,000/100,000,001 B、并发分支、同 key 重试、对象成功后 PG 失败与重试，以及含 64 位位置字符串的固定 golden。首轮 legacy 回归因隔离测试库未迁移而失败，先运行 `npm run db:migrate` 后 4/4 通过；不是实现回归。未跑全仓、浏览器及性能套件：本 Ticket 只有内部 seam，定向发布与旧版回归覆盖实际改动；合批浏览器 checkpoint 留到 Ticket 36。
- Standards/Spec 双轴审查的 3 项 P1 已修复并复核为无未解决 P0/P1；保留 P2 函数职责较多的重构建议，Ticket 36 接入阈值时按实际改动决定。Production Gate 仍为 `Not Evaluated / Not Approved`。本张不建立 Owner checkpoint；其 isolated test Compose 资源在验证后回收。Ticket 36 依据 Owner 已给出的执行指令开展，并在其固定 HEAD 建立 35+36 合批 checkpoint。
- 2026-09-27：Project Owner 明确将 Ticket 35+36 联合 checkpoint 记为通过，验收运行 SHA `5b15133`。本机浏览器经 SSH 隧道核对五个版本的 10 条记录、v3 修改详情、v4 后继、周期分支与 CSV 下载；Ticket 36 的真实 Worker 周期物化已成功。证据、服务日志、健康响应、版本/作业状态与 SHA-256 清单位于 `local-acceptance-evidence/ticket35-36-owner-checkpoint-20260927/`。Production Gate 仍为 `Not Evaluated / Not Approved`。
- 35+36 联合 checkpoint 验收后，已核对 Compose 归属并回收该批专用容器、网络、PostgreSQL/MinIO 卷、合成数据、镜像、4215 端口及本机 SSH 隧道；清理日志和最终资源清单已纳入上述校验清单。未操作其他项目或正式 `evalbase`。
