# Phase 1A-09：后台任务、失败、取消与重试

Status: ready-for-agent
Implementation: completed

Blocked by: [02](./02-format-adapters-and-parse-recovery.md), [06](./06-capacity-boundaries.md), [08](./08-case-revisions-and-version-lifecycle.md)

## Outcome

解析、Candidate materialization 和 publication 作为可观察的 PostgreSQL-backed Job 运行。用户可以查看进度、取消或重试；Worker crash、PostgreSQL/MinIO 故障和响应丢失不会产生可见半成品、重复领域对象或版本号空洞。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Background jobs、G-01、G-12
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-07、场景 H、14.1
- [Architecture jobs](../../../docs/architecture/phase1a-architecture.md#7-后台任务取消与重试)
- [ADR-0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)
- [ADR-0004](../../../docs/adr/0004-postgres-coordination-for-jobs-and-draft-leases.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 E. 故障注入矩阵

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Job state/stage/progress/error/result、lease、attempt/backoff、idempotency key、correlation ID、cancel request 和 orphan metadata |
| Domain | claim/renew/reclaim、错误分类、有限重试、取消边界、发布幂等和孤立对象安全回收 |
| Public interface | Job 查询、取消、手工重试、publication outcome 和稳定错误的 S-HTTP |
| UI | 可离开/返回的 Job 状态、进度、错误、取消/重试动作和场景 H 恢复 |
| Tests | 真实 `SKIP LOCKED`/PG/MinIO、可控 Clock、Worker crash 与每个提交点故障注入 |

## Gap closure and established upload contract

1. G-12：冻结最大尝试、backoff、Job lease、heartbeat、timeout 和 retryable error families；参数保持运行配置。
2. G-01：冻结 orphan grace/scan cadence，并证明宽限期大于所有 lease/retry window。
3. 消费并验证既定 TP-G03，不再决定产品语义：同作用域同键同请求返回原 Data Asset，同键异指纹返回 `idempotency_conflict`，并发同键返回 `idempotency_in_progress`，新键同字节保持来源身份独立，删除后原键返回 `idempotency_resource_gone`。

## Acceptance Criteria

1. Job row 与触发它的领域命令/审计在同一 PostgreSQL transaction 提交，不增加 broker、Redis 或第二 outbox。
2. Worker 使用短事务和 `FOR UPDATE SKIP LOCKED` claim 到期 Job；两个 Worker 不会同时完成同一个逻辑作业。
3. Job 公共状态包含 queued、running、retry_wait、failed、cancel_requested、cancelled、succeeded 及适用产品状态。
4. 永久业务/授权错误立即失败；可重试 PostgreSQL、MinIO 和进程错误只按有限策略重试。
5. expired Worker lease 可被重领；client retry、Worker recovery 和 manual retry 经唯一 idempotency key 收敛到同一逻辑结果。
6. 上传对象提交后响应丢失的 S-HTTP 故障注入验证既定 TP-G03；不得覆盖/合并 Source Attribution，不得以内容哈希代替客户端逻辑上传身份。Ticket 01 已实现的基本合同在本票扩展为完整提交前/后、并发和冲突矩阵；删除后的 `idempotency_resource_gone` 由 Ticket 14 在真实删除传播中集成验证。
7. parse/materialization 在批次间及 commit marker/数据库可见性前检查取消；取消后原件、草稿和已发布版本保留。
8. publication 在最终锁事务前可取消；进入事务后不再取消，并返回最终 committed/failed outcome。
9. Candidate publish 的对象 PUT、marker、事务和响应丢失故障均不产生第二版本、重复 membership 或版本号空洞。
10. publish failure 保留 immutable Candidate 为 `publish_failed`；恢复后同 Candidate 重试才产生下一个无空洞版本号。
11. staging 和 unreferenced marker 只有在无数据库引用、无有效 lease 且超过安全宽限后才能回收；referenced artifact 永不回收。
12. UI 展示 stage、progress、counts、stable error、attempt 和 correlation ID，不要求用户修改后台状态。
13. 场景 H 浏览器 E2E 和完整故障注入断言不可变输入、可见状态、审计、orphan outcome 与幂等收敛。

PRD trace: AC-03 的安全解析重试、AC-04 的完整上传幂等故障矩阵、AC-20、AC-46 的失败/取消/重试部分，以及场景 H。

## Out of scope

- Redis、消息代理、工作流引擎、分布式调度或水平扩展保证。
- Package 与 Controlled Deletion 的专属故障矩阵；分别由 Ticket 11/14 补充，但复用本票 Job 协议。

## Definition of Done

- 所有故障点在真实 PostgreSQL/MinIO 上有公共 seam 证据。
- G-01/G-12 参数被 Fixture/配置固定；既定 TP-G03 的适用故障矩阵完成，删除后的结果明确交由 Ticket 14 集成验证，无重新决策。
- 浏览器可独立演示失败、恢复重试和最终取消。

## Comments

- 2026-08-22：Project Owner 授权后完成 Ticket 09，实现提交固定为 `5f6a7ec`（初始实现 `f01afc7`，closure findings 修复包含在 `5f6a7ec`）。本票把 parse、Candidate materialization 和 publication 迁移到 PostgreSQL-backed Job：状态/stage/progress/attempt/counts/correlationId/idempotencyKey、lease/backoff/nextRun、失败与取消状态及结果进入 `job`；迁移为 `ticket09-job-coordination-v1`，保留历史并把 legacy key 安全改写为 `legacy:<job id>`。
- 协调行为：上传、解析、物化与发布的领域状态变化和 Job row 在同一 PostgreSQL transaction 提交；初始物化/发布命令也同事务写入 command audit。Worker 使用短事务 `FOR UPDATE SKIP LOCKED` claim、单次递增 attempt、续租、重领过期 lease、有限 exponential backoff、永久业务错误立即失败、基础设施错误有限重试；manual retry/requeue 复用原 Job 和 authoritative key，避免第二逻辑作业或领域对象。
- 取消与发布边界：parse/materialization 在批次推进、staging 完成后、commit marker 前和数据库可见前检查取消；publication 在进入最终事务前可取消，进入 `publication_transaction` 后拒绝取消并收敛到 committed/failed outcome。PostgreSQL rollback、Manifest PUT failure、package marker mismatch/read-back、响应丢失、重试与并发 replay 均不产生重复版本或版本号空洞。
- 上传幂等与 orphan：请求指纹覆盖 exact bytes hash/size/filename/声明格式/初始 attribution，committed replay 返回原 Data Asset、原 Source Attribution、原 Parsed View/parse job receipt 和 `replayed:true`；同 key 异指纹冲突、同 key 并发、断流重试、同字节新 key 独立身份均由 S-HTTP 覆盖，删除后的 `idempotency_resource_gone` 继续明确交给 Ticket 14。Worker 扫描 staging 与 marker，按活跃 upload/job lease、数据库引用和安全宽限回收 aged orphan，并分页处理完整 1000-key 页面。
- UI：持久 Job panel 显示 status/stage/progress/counts/attempt/maxAttempts/correlationId/stable error，提供取消与可重试 infrastructure failure 的手工重试，终端状态停止轮询。Scenario H 浏览器测试覆盖 MinIO 故障恢复、手工重试、materialization 取消、publication 取消、immutable draft 保留和可见状态。
- 公共测试 seam：`tests/integration/job-coordination.test.ts`（15 个真实 PostgreSQL/MinIO/S-HTTP/S-Worker job coordination tests）、`tests/integration/upload.test.ts`（完整适用 TP-G03 matrix 与 revision 后原 receipt replay）、`tests/unit/job-policy.test.ts`（G-01/G-12 defaults、关系校验、非有限 backoff 拒绝和可控 Clock schedule）、`tests/e2e/scenario-h.spec.ts`（真实浏览器故障恢复与取消）。marker mismatch 测试在真实 MinIO 中破坏最终 package marker，断言同 Job bounded failure、唯一既有 v1、恢复后同 version convergence。
- 验证 at implementation `5f6a7ec`：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run docs:check`、`git diff --check` 通过；`npm test` 为 13 个文件 / 83 个测试通过；`docker compose run --build --rm test sh -lc 'npm run db:migrate && npm run test:integration'` 为 10 个文件 / 84 个测试通过；独立 Compose E2E 为 17/17 通过；固定 Node.js 24 容器 `npm run build` 通过；全新空 PostgreSQL DB 迁移记录 `ticket09-job-coordination-v1`，11 个新增 job columns 和 4 个 due/lease/idempotency indexes 均存在。一次 E2E 首轮因共享持久开发卷状态出现 1 个未创建 Candidate 的偶发前置失败；该单测复跑和完整 E2E 复跑均通过，未作为产品回归证据。
- Closure Review：固定 HEAD `5f6a7ec` 的 Standards 与 Spec 双轴完整 Closure Matrix 均为 `Ticket Closure Review P0/P1 cleared at 5f6a7ec`。初始审查发现的 replay receipt 漂移、可控 Clock 证据缺失、初始 command audit 缺失和 marker mismatch 证据缺失均已在 `5f6a7ec` 关闭。
- 接受的 P2 / 未测试声明：upload 原 receipt 通过最早 immutable revision/job 顺序恢复而非额外持久化 IDs（同 timestamp 依赖稳定 id ordering）；orphan 1000-key 分页与 referenced marker 保留逻辑已实现但无专项超大对象列表测试；marker mismatch 复用共享 `job_failed` 审计路径但测试未独立查询该 event；failed materialization 的 requeue/recovery 未做专项 public test；`src/worker/main.ts` 仍有较大 job-kind 分支；`JOB_MAX_ATTEMPTS` 缺少实际上限校验；`storeImmutable` 的 optional `operationId` 参数当前未由生产 caller 使用。上述均为记录性 residual risk，不改变本票合同。
- 2026-08-23：在最终 Closure Matrix 复审中发现并修复最后一个 P1：当解析 Job 的最后一次 Worker lease 到期时，`failExpiredJobs` 现在在同一 PostgreSQL 故障收尾事务内把仍处于 `queued`/`parsing` 的 Parsed View 置为 `parse_failed`，并清空不可信的计数/摘要；新增真实 PostgreSQL/HTTP 回归测试 `marks a parse view failed when its final Worker lease expires`。修复提交为 `a5489b0`（前置取消/崩溃修复提交为 `e959021`）。
- 最终验证（implementation HEAD `a5489b0`）：`npm test` 13 个文件/84 个测试、Ticket 09 定向 Compose 集成 21/21、全量 Compose 集成 10 个文件/90 个测试、Compose E2E 17/17、`npm run build`、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run docs:check`、`git diff --check` 均通过；重建部署后的 `/health` 返回 `git_sha: a5489b0`。本票最终公共测试 seam 为 21 个 job coordination 测试（此前记录的 15 个为旧计数）。
- Closure Review（固定 HEAD `a5489b0`，基线 `c07f6a1`）：Standards 与 Spec 双轴以及完整 Closure Matrix 均为 `Ticket Closure Review P0/P1 cleared at a5489b0`。矩阵覆盖 AC/DoD、Spec/PRD/Architecture/ADR/Test Plan/AGENTS、S-HTTP/S-PARSER、成功/失败/取消/重试/权限/持久化、双 Worker `SKIP LOCKED`、lease reclaim、JSONL 流式取消、marker 后与 DB commit 后崩溃、响应丢失、publication rollback/marker mismatch/orphan、Ticket 02/06/08 交互、测试/构建/部署证据。接受的 P2 与未测试声明沿用上一条记录，未发现新的 P0/P1/P2。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 10 未开始，不自动推进。
