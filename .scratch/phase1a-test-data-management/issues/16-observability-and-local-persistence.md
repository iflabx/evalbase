# Phase 1A-16：可观测性与本地持久化

Status: ready-for-agent
Implementation: completed

Blocked by: [09](./09-job-failure-cancel-and-retry.md), [13](./13-structured-lists-and-audit.md), [14](./14-controlled-deletion.md), [15](./15-security-hardening.md)

## Outcome

Web、Worker 和用户可通过结构化 Job/日志/指标/健康状态诊断 Phase 1A 数据路径；一致性巡检能发现跨 PostgreSQL/MinIO 失配并 fail closed。正常进程/容器重启和正常重新部署后，元数据与不可变对象仍存在，但系统不声称有备份或灾难恢复。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Observability/durability、G-15
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 14.1、14.4、Definition of Done
- [Decision record B-4](../../../docs/reviews/phase1a-solo-owner-decision-record.md#5-b-4数据耐久性与恢复)
- [Architecture observability](../../../docs/architecture/phase1a-architecture.md#15-可观测性与恢复边界)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F.7 和 F-PERSISTENCE

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | 结构化 operation/job measurement、health result、consistency finding、persistent volume configuration 和不含业务正文的 labels |
| Domain | consistency check、referenced artifact fail-closed、orphan observation 和不覆盖旧哈希的处理规则 |
| Public interface | liveness/readiness、Job/error/correlation 查询和适用的非敏感 status |
| UI | Job 诊断、非生产/无备份边界、依赖不可用和 integrity-blocked 状态 |
| Tests | 日志/metric schema、PG/MinIO readiness、失配故障注入、进程/容器/Compose 正常重启与重部署持久化 |

## Gap closure

关闭 G-15：汇总各 owning Ticket 已使用的 stable error/event/metric 名称，冻结 data-free label policy 和非生产 alert defaults。不得把阈值描述为 SLA。

## Acceptance Criteria

1. Web/Worker 结构化日志至少带 correlation ID、适用 job ID、project ID、opaque object ID、stage、duration 和 stable error。
2. 日志/metric label 不含原始记录、Prompt、password、session、对象存储 credential 或未来连接密钥。
3. minimum metrics 覆盖 queue depth、oldest queued age、job success/failure/retry、stage duration、PostgreSQL/MinIO health、disk use、hash mismatch 和 orphan count。
4. Web/Worker 暴露 liveness/readiness；readiness 分别反映 PostgreSQL 和 MinIO，短暂依赖失败不被写成数据业务失败。
5. consistency scan 检查数据库引用/marker、marker/object hash、Version member/Manifest count 和 aged orphan。
6. 发现缺对象、hash mismatch 或 count mismatch 时告警并阻断受影响 publication/download；不得重算覆盖 published hash 或自动重建 Version。
7. 分别重启 Web、Worker、PostgreSQL、MinIO 和完整 Compose 后，Data Asset、Working Draft、Candidate、Version 和 Delivery 仍可通过公共接口访问且哈希不变。
8. 按正常部署程序重建应用容器后 PostgreSQL/MinIO volume 数据仍存在；测试不直接修复后台状态。
9. UI/文档明确：Phase 1A 无备份、无 off-host copy、无 RPO/RTO/SLA、无 host-loss/误删恢复保证。
10. 不执行磁盘损坏、整机丢失或 backup restore 测试，也不把正常重启称为灾难恢复。

PRD trace: AC-38/39 的可诊断且不泄密部分，以及耐久性、可观测性和无备份 Definition of Done。

## Out of scope

- Backup、replication、HA、RPO、RTO、SLA、生产监控、事件响应和恢复演练。
- 自动重写或修复已发布哈希。

## Definition of Done

- G-15 catalog 与无数据 label policy 固化。
- readiness、consistency fault 和 F-PERSISTENCE 测试通过。
- 所有恢复措辞准确限定为正常重启/重部署的本地持久化。

## Comments

### 2026-08-27 implementation closure

- Implemented Web/Worker liveness and dependency-specific readiness, data-free minimum metrics, structured Web/Worker logs, persisted stage-duration observations, and restart-safe PostgreSQL pooling.
- Added the read-only consistency scanner and `consistency_finding` ledger. It verifies active object references and markers, hashes storage objects, checks Manifest/member counts, pages staged objects, and fail-closes affected publication/download paths without rewriting published hashes.
- Added the G-15 diagnostic/event/metric catalog, non-production defaults, and no-data label policy.
- Added the public persistence fixture/verify commands and UI persistence-boundary wording.
- Local implementation commit: `b569d4c`.

Validation:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run format:check` and explicit Prettier checks for new files — passed.
- `npm test` — 117/117 unit tests passed.
- `docker compose run --build --rm test sh -lc 'npm run db:migrate && npm run test:integration'` — 174/174 tests in 19 files passed.
- `docker compose run --build --rm e2e npm run test:e2e` — 25/25 tests passed.
- `docker compose run --build --rm test npm run build` — passed in the pinned Node.js 24 image.
- `npm run docs:check` and `git diff --check` — passed after closure records.
- Standards/Spec dual review completed; all P0/P1 findings were closed.

F-PERSISTENCE evidence used public S-HTTP only. Fixture: Data Asset `asset_17fcb6b995404e0a8696065e6520c962`, Draft `draft_af9309ad87424a1db366b87251f24648`, Test Set `testset_667a6ffdc5004fdc9663387f33a6ef0d`, Candidate `candidate_8d47e71a21964c09b89d58ea049763bf`, Version `version_11c38c6953ec498a875d8eef02290ae1`. Public raw-asset hash: `b59f07eaeee1748cb1f8354ab25e4f66e15b5e18a108be3225cd6c4c30b39bcc`; Candidate payload/evidence and Version payload/evidence/Manifest hashes stayed unchanged; item count remained 1; Delivery count remained 1; Standard Package hash remained `aee900198e12e05d4335975f822178bf63dd65f9b7cec90a5d30c5b4dc39997b`.

The same fixture remained `unchanged` after Web restart, Worker restart, PostgreSQL restart, MinIO restart, complete application-stack restart, and normal rebuild/recreate. This verifies local persistence only; it is not backup, disaster recovery, RPO/RTO, or SLA evidence.

### 2026-08-27 repair and fixed-head closure review

- Repair baseline: `f2005946fc4ffd2fb8ca3561a507c3f134df943e`; fixed implementation HEAD: `eb6d594f073d444159bf1c5912023af39232f7b0` (`eb6d594`). The repair diff is limited to `src/server/app.ts` and `tests/integration/package-delivery.test.ts`.
- `9ce823c` makes candidate integrity checks read the frozen Candidate snapshot first (with a legacy draft-revision fallback), so a Source or finding added to a later Working Draft cannot incorrectly block publication of an already-frozen Candidate. `eb6d594` gives the Langfuse integration test its own Full Provenance fixture instead of relying on test ordering. Neither repair changes product scope, permissions, capacity, allowed data, Phase 1B, or Production Gate behavior.
- Standards review: `0` hard violations, `0` Fowler baseline smell findings. Spec review: `0` P0, `0` P1, `0` P2. The review checked the final repair diff against this Ticket's Spec, PRD, architecture, ADRs, test plan, and repository standards.
- Static and documentation checks at the fixed implementation HEAD passed: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, and `git diff --check`.
- Test evidence at the fixed implementation HEAD: `npm test` passed (`15` files / `118` tests); the clean dedicated integration run passed (`19` files / `181` tests; `/tmp/agentbench-ticket16-integration-final-clean.log`); focused package-delivery passed (`15/15`; `/tmp/agentbench-ticket16-package-delivery-final-head.log`); focused observability passed (`17/17`; `/tmp/agentbench-ticket16-observability-final-head.log`).
- The clean E2E run passed `24/25`; `tests/e2e/scenario-c.spec.ts` remains the single failure (`expected itemCount 15`, received `16`). This is an existing Ticket 08 Scenario C cross-Ticket residual outside the Ticket 16 repair diff; it is not represented as a Ticket 16 pass and requires a separate owner decision/Ticket repair.
- Node.js 24.6.0 persistence evidence was refreshed through the public S-HTTP seam using the pinned image `public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff`: fixture state `/tmp/agentbench-ticket16-persistence-node24-final.json`, redacted transcript `/tmp/agentbench-ticket16-persistence-node24-final.json.transcript.jsonl`, create log `/tmp/agentbench-ticket16-persistence-node24-create.log`, and verify log `/tmp/agentbench-ticket16-persistence-node24-verify.log`. The transcript records `v24.6.0`, status `created` then `unchanged`, stable asset/candidate/version/package hashes, and only synthetic opaque IDs. The previously recorded Web/Worker/PostgreSQL/MinIO/Compose restart and normal redeploy logs remain the restart evidence; the persistence claim is limited to local normal restart/redeploy and does not include backup, host-loss, disaster recovery, RPO/RTO, or SLA.

#### Fixed-head Closure Matrix

| Matrix area | Public seam / evidence | Result and residual |
| --- | --- | --- |
| AC-1 structured Web/Worker diagnostics | HTTP/Worker logs, job queries, correlation/job/project/opaque-object fields; observability integration suite | Pass; stable fields and error names are present without business payloads. |
| AC-2 data-free diagnostics | metrics catalog, log/audit canary scans, security and observability suites | Pass; bounded labels and escaping keep records, credentials, sessions, prompts, URLs, and filenames out. |
| AC-3 minimum metrics | `/metrics`, health/consistency tests, `docs/agents/g-15-observability-catalog.md` | Pass; queue, age, job outcomes/retries, stage duration, dependency health, disk, mismatch, and orphan observations are covered. |
| AC-4 readiness | Web and Worker liveness/readiness endpoints and dependency-failure tests | Pass; PostgreSQL and MinIO are reported independently and transient dependency failure is not a business failure. |
| AC-5 consistency scan | public health/metrics seam plus narrow synthetic PostgreSQL/MinIO fault injection | Pass; references, markers, object hashes, manifest/member counts, and aged orphans are checked. |
| AC-6 fail-closed integrity | publication/download HTTP seam and candidate integrity regression test | Pass; missing object, hash/count mismatch blocks only affected publication/download and never rewrites published hashes. |
| AC-7 restart durability | public persistence create/verify plus Web/Worker/PostgreSQL/MinIO/Compose restart logs | Pass for normal local restart; hashes/counts and public resources remain unchanged. |
| AC-8 normal redeploy durability | public persistence create/verify after application rebuild/recreate | Pass for normal local redeploy; no direct database repair was used. |
| AC-9 boundary wording | UI, Ticket comments, PRD/architecture/test-plan references | Pass; no-backup/off-host/RPO/RTO/SLA and non-production limits are explicit. |
| AC-10 excluded recovery claims | persistence procedure and test-plan inspection | Pass; no disk-loss, host-loss, backup-restore, or disaster-recovery test is claimed. |
| Definition of Done / Spec §23 and G-15 | G-15 catalog, all validation above, fixed-head dual review | Pass; catalog and label policy are frozen, with the E2E Scenario C residual explicitly retained. |
| PRD 14.1/14.4 and DoD | PRD trace and implementation inspection | Pass for the Ticket 16 observability/local-durability scope; no production approval implied. |
| CONTEXT / architecture §15 and §17.4 | domain and architecture inspection | Pass; local persistence and diagnostic boundaries are preserved. |
| ADR-0002 and test plan F.7/F-PERSISTENCE | ADR/test-plan inspection and real-stack evidence | Pass for the stated non-production seams; no backup or host-loss guarantee. |
| Public seam, negative/error/retry/cancel paths | 19-file integration suite, focused package/observability suites, failure-injection tests | Pass for Ticket 16 paths; E2E Scenario C residual is cross-Ticket and remains open. |
| Concurrency and cross-Ticket interactions | candidate freeze regression, Langfuse fixture isolation, existing failure/retry/cancel suites | Pass for repaired Ticket 16 interactions; no new cross-Ticket behavior introduced. |
| Lifecycle evidence | this entry, `docs/agents/phase1a-progress.md`, implementation commits | Pass after progress ledger update; triage `Status` remains `ready-for-agent` by design and `Implementation` remains `completed`. |

Closure conclusion at the fixed implementation HEAD: **Ticket Closure Review P0/P1 cleared at `eb6d594`**. Accepted residuals are the pre-existing Scenario C E2E mismatch and the explicitly limited local-persistence evidence; no P2 finding was accepted as a Ticket 16 defect. Non-production Server Development Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`. Ticket 17 is not started and is not authorized by this closure review.
