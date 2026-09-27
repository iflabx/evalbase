# Phase 1A-06：全流程容量边界

Status: ready-for-agent
Implementation: completed

Blocked by: [02](./02-format-adapters-and-parse-recovery.md), [04](./04-draft-recipe-and-edit-lease.md), [05](./05-mapping-and-formal-schema.md)

## Outcome

上传、解析、草稿附件、Candidate materialization 和 publication transaction 在各自权威阶段执行精确容量检查。边界值允许，超限值明确阻断；被拒绝的操作不破坏 Data Asset 或 Working Draft。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Capacity contract、G-02
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为容量决定、FR-01、FR-04、FR-07
- [Decision record B-1](../../../docs/reviews/phase1a-solo-owner-decision-record.md#2-b-1容量边界)
- [Architecture](../../../docs/architecture/phase1a-architecture.md)，重点为 5、6.5、8 和 17.4
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 C.2 和性能口径

## Vertical slice

| Layer            | Deliverable                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Data             | 权威 byte/record counters、draft aggregate、Candidate exact size/count、capacity-block audit/event 和发布复检输入 |
| Domain           | 分阶段 limit policy、原子 attachment decision、oversized projection、streaming exact checks 和稳定业务错误        |
| Public interface | 上传/解析/追加/物化/发布的容量结果，以及保留状态查询                                                              |
| UI               | 显示限制、当前累计、实际阻断阶段、修正动作；超限 Recipe 仍可保存                                                  |
| Tests            | 确定性边界生成器、真实流式上传/解析/PG/MinIO、+1 boundary 和发布漂移故障注入                                      |

## Established contract and remaining Gap

1. 消费既定 TP-G02：`1 MB = 1,000,000 bytes`，因此 50 MB = 50,000,000 bytes、100 MB = 100,000,000 bytes；等于上限允许，+1 byte 阻断。UI 同时使用人类可读值和精确上限。本票不得重新决定该口径。
2. G-02：冻结单条 `input` 的非敏感性能/安全上限，不提高任何已确认 aggregate limit。
3. 生成器记录 seed/version、精确 size、record count 和 SHA-256；大型 Fixture 不提交仓库。

## Acceptance Criteria

1. 单 Data Asset 恰好 50,000,000 bytes 可存储，50,000,001 bytes 不产生 stored Data Asset；上传中断不产生可解析资产。
2. 单 Parsed View 恰好 10,000 条可加入草稿；10,001 条仍可下载但 draft-ineligible。
3. Working Draft 恰好 5 个追加资产、100,000,000 原始 bytes 合计和 10,000 条 Source Record 合计可保存。
4. 第 6 个资产、aggregate +1 byte 或 +1 record 在 attachment transaction 原子拒绝；旧附件集合不变，被拒绝资产独立保留。
5. Candidate 恰好 10,000 条和规范化 `items.jsonl` 恰好 100,000,000 bytes 可 materialize。
6. 0 条、10,001 条、`items.jsonl` +1 byte 或单条 `input` 超限不能形成 `ready_to_publish` Candidate。
7. 用户可保存预计会生成超限 Candidate 的 Recipe；系统显示阻断但保留 Working Draft 配置。
8. materialization 使用 projection 和 exact final check；不得截断或 best effort 继续。
9. publication transaction 复检单资产、草稿 aggregate、Candidate count/bytes 和单 item cap；观察到漂移时回滚且不分配版本号。
10. 所有错误说明对象、限制、实际值、阻断阶段和可执行的下一步。

PRD trace: AC-40 的容量部分、AC-43 的附件容量部分、AC-46 的 Candidate/`items.jsonl`/发布复检部分。

## Out of scope

- 分块/断点续传、更大限制、后台索引、Arrow/Parquet、水平 Worker 扩展。
- 通过放宽限制修复性能。

## Definition of Done

- 所有 exact/+1 Fixture 在 S-HTTP 和真实基础设施上通过。
- 发布复检不能由陈旧 projection 或并发绕过。
- 既定 TP-G02 口径由权威常量/Fixture 消费并验证；仅 G-02 仍在本票按约束关闭，不修改 PRD 产品边界。

## Comments

- 2026-08-20：Project Owner 授权后完成本 Ticket 的最小纵向闭环。实现权威 `capacity-contract-v1` 常量/Fixture（含 G-02 单条 canonical `input` 上限 10,000,000 bytes）、`draft_source` 附件账本与迁移回填、S-HTTP 原子追加、5 资产 / 100,000,000 bytes / 10,000 Source Records 精确边界、上传中断同键重试、Parsed View 记录边界、Candidate 空 / 记录数 / `items.jsonl` / 单条 input 预检与最终实测、发布事务内 Candidate、草稿聚合、单资产和单条 input 复检，以及 UI 的单资产上限、当前累计、追加和结构化阻断报告。多资产 Candidate 组合与独立 mapping 仍按 Ticket 07 边界处理。
- 验证：固定 Node.js 24.6.0 镜像中 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 通过；`npm test` 为 74/74；专用 Compose 中 `npm run db:migrate && npm run test:integration` 为 7 个文件 / 43 个测试通过（含 50,000,000 / 50,000,001、100,000,000 / 100,000,001、10,000 / 10,001、空 Candidate、10,000 Candidate、100,000,000 / 100,000,001 `items.jsonl`、G-02 input 上限和发布漂移）；`npm run test:e2e` 为 8/8 通过；宿主机 `npm run docs:check` 与 `git diff --check` 通过。
- Code Review：Standards 与 Spec 双轴复审发现的原 P1（UI raw JSON、重复容量聚合 SQL、projection 发生在 case binding 之后、发布复检缺口、错误详情不足）均已修复并复验为 P0=0、P1=0。保留非阻断 P2：完整结构化日志/指标目录等待 Ticket 16；当前 JSON/JSONL 与 Candidate 序列化仍按已验证的内存路径执行，最终性能与资源峰值由 Ticket 17 收口。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成生产、安全、隐私、法务或合规批准。Commit：`5f2212a`。Ticket 07 的依赖已满足，但不会自动开始。
- 2026-08-20 返修：关闭后续审查 P1/P2——AGENTS/README 改为引用 progress ledger 并由 `docs:check` 阻断硬编码 Ticket 范围；`failed` 上传键使用 PostgreSQL 原子 `failed -> receiving` claim，并发重试只有一个 Data Asset；Candidate 在 case binding 前复检 Working Draft aggregate 与单资产上限；`items.jsonl` 逐条流式写入 `staging/<operation_id>/`、边写边精确计量 SHA-256/bytes，超限立即阻断，等于 100,000,000 bytes 才提交 immutable marker；容量阻断写入 draft/candidate audit；发布前和事务内复检 MinIO 对象大小，`+1 byte` 漂移映射 `publication_capacity_exceeded` 且 Candidate 保持 `publish_failed` 可重试；UI 安全区分对象级/记录级错误并显示 MB+精确 bytes；G-02 增加 10,000,000-byte 等于上限测试，并清理 Parsed View 硬编码。
- 返修验证：固定 Node.js 24.6.0 中 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（74/74）、`npm run build` 通过；专用 Compose 中 `npm run db:migrate && npm run test:integration` 为 7 个文件 / 45 个测试通过；`npm run test:e2e` 为 10/10 通过；`npm run docs:check` 与 `git diff --check` 通过。Standards/Spec 复审所有 P0/P1 均关闭；保留 P2 为 package/evidence 构建阶段仍存在已验证内存缓冲，最终资源峰值由 Ticket 17 收口。
- 返修 Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。返修 Commit：`c735427`。Ticket 07 未开始。
- 2026-08-20 第二轮返修：Candidate aggregate 与空 Candidate 顶层报告均含 `errorCode/capacityBlock/object/blockingPhase/actual/limit/retry/errors`，UI 按 `valid === false` 显示并区分对象级/记录级错误；`publishing` Candidate 幂等复用既有 Job；发布事务按 item count、object bytes、draft aggregate、单资产与单 input 输出精确 exceeded dimension，并以同一结构化 measurement 写入 validation report 与审计；独立 Candidate 完成精确 100,000,000-byte `items.jsonl` 物化与默认 `v1` 发布；failed 上传重试使用新的 operation ID 作为 ownership token；materialization 通过独立 `createStandardEvidence` 生成 evidence/hash，不再构造随后丢弃的 ZIP。新增四类发布漂移、真实 exact-100MB 发布、并发 publishing replay、空 Candidate 审计/UI、aggregate Candidate 浏览器验收和上传 operation ownership 断言。
- 第二轮返修验证：固定 Node.js 24.6.0 中 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（74/74）、`npm run build` 通过；专用 Compose 中 `npm run db:migrate && npm run test:integration` 为 7 个文件 / 51 个测试通过；`npm run test:e2e` 为 12/12 通过；`npm run docs:check` 与 `git diff --check` 通过。Standards/Spec 第二轮复审 P0=0、P1=0；保留非阻断 P2：发布路径仍需完整读取 items/package，资源峰值由 Ticket 17 收口；exact-boundary fixture 生成代码存在可后续合并的重复。
- 第二轮返修 Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。返修 Commit：`9b7a80d`。Ticket 07 未开始。
- 2026-08-20 最终返修：关闭最终复审发现的容量报告与重放 P1——publication scalar measurement 与 Working Draft aggregate 在 UI 中安全区分；item-count drift 使用真实超限 `actual` 并显示 `10,001/10,000`；空 Candidate 报告补齐 `actual=0`、`limit=1`、`minimumItems=1` 和 `candidate_minimum_items`；publication replay 只复用最新 `queued/running` Job，无活动 Job 返回稳定 `publication_job_not_active`。新增真实 HTTP 集成覆盖旧 failed/current running replay 和三次并发 replay，并新增 publication scalar 失败、空 Candidate 最小边界浏览器验收。
- 最终返修验证：`npm test` 为 74/74；真实 PostgreSQL/MinIO 集成测试为 51/51；Ticket 06 capacity 集成测试为 14/14；`npm run test:e2e` 为 13/13；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 均通过。Standards/Spec 复审 P0=0、P1=0；保留非阻断 P2：`recordedItems` 与 payload 数量均未超限时仍使用 capacity error 表达完整性漂移，完整结构化日志/指标与最终资源峰值继续由 Ticket 16/17 收口。
- 最终返修 Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。实现 Commit：`c966668`。Ticket 07 未开始，不自动推进。
- 2026-08-20 最终复审修复：锁定 Candidate 后同时比较 `evidence_object_ref` 与 `evidence_hash`，阻断预检后 evidence 身份漂移；Parsed View 超量时顶部状态改为减少或替换资产，并集中复用两个 HTTP 路径的阻断报告 helper。新增 evidence 漂移竞态回归和 UI 状态断言，测试竞态同步流程抽取为带明确 PostgreSQL 锁观测 seam 的 helper。
- 最终复审验证：固定 Node.js 24.6.0 中 `npm test` 为 74/74；专用 Compose 中完整集成为 7 个文件 / 55 个测试通过，Ticket 06 capacity 集成为 18/18；`npm run test:e2e` 为 14/14；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 均通过。Standards/Spec 复审 P0=0、P1=0；保留非阻断 P2：发布预检仍读取完整 `items.jsonl` 并构造 evidence 内存对象，最终资源峰值由 Ticket 17 收口；并发回归使用 `pg_stat_activity` 作为明确的测试同步 seam。
- 最终复审 Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。实现 Commit：`3ac607a`。Ticket 07 未开始，不自动推进。
- 2026-08-20 Fixture 返修：将大型 exact/+1 边界输入集中到版本化 `capacity-boundary-manifest-v1` 与确定性生成器，记录 generator version、seed、精确 bytes、record count 和 SHA-256；测试通过独立 Node.js `crypto` oracle 校验 manifest，并统一接入上传、Parsed View、Working Draft、Candidate、G-02 及浏览器边界路径。未改变产品行为、容量限制或 Ticket 07 范围。
- Fixture 返修验证：`npm test` 为 75/75；专用 Compose 中完整集成为 7 个文件 / 55 个测试通过，Ticket 06 capacity 集成为 18/18；`npm run test:e2e` 为 14/14；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 均通过。独立 manifest/oracle 校验通过；此前发现的 Fixture P1 以及 3 个非阻断 Fixture P2（ID 类型收窄、overflow fixture 接入、G-02 重复生成）均已关闭。
- Fixture 返修 Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。实现 Commit：`afbec74`。Ticket 07 未开始，不自动推进。
- 2026-08-21 Closure repair：发布容量复检改为只计算 Candidate 冻结的 `sources` 快照，并在 Candidate 行锁前后比较规范化 `sourcesHash`，防止来源集合锁间漂移；Candidate API 不再暴露内部对象引用；新增新增先提交、先移除再追加和来源锁间漂移的真实 HTTP 回归，成功路径统一使用 Candidate/Job/Version/package 公共 seam 与独立解压/hash oracle。未改变 PRD、容量、权限、数据范围、Production Gate 或 Ticket 07 产品行为。
- Closure repair validation at implementation `921654e`：固定 Node.js 24.6.0 容器中 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check`、`git diff --check` 通过；`npm test` 为 11 个文件 / 76 个测试通过；专用临时 PostgreSQL/MinIO/network/volume 中 `npm run db:migrate && npm run test:integration` 为 8 个文件 / 62 个测试通过。临时资源已删除，原始日志保存在 `/tmp/agentbench-ticket06-review/integration-closure-921654e.log`。部署持久化、最终性能/资源峰值、取消延迟和 Project Owner 浏览器验收未在本轮执行。
- Closure Review residuals：P0/P1 代码与 Spec/Standards finding 已清零；保留 P2 为上传中断重试前缺少公共半成品不可见 oracle、发布最大 `items.jsonl` 仍存在已知内存峰值，以及少量测试 seam/容量行类型维护项。最终固定 HEAD 的完整矩阵结论须在本 progress-record 提交后复跑确认。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 07 已按其自身记录完成，但本次仅收尾 Ticket 06，不自动开始 Ticket 08。
