# Phase 1A-14：Fail-closed 受控删除

Status: ready-for-agent
Implementation: completed

Blocked by: [10](./10-transformation-runs-and-lineage.md), [11](./11-delivery-packages-and-langfuse-csv.md), [12](./12-permissions-and-project-isolation.md), [13](./13-structured-lists-and-audit.md)

## Outcome

Owner 可以预览完整在线依赖闭包，并在独立步骤使用冻结 preview hash 和结构化理由二次确认。系统先阻断受影响内容的读取/导出/新引用，再幂等删除载荷、保留最小 tombstone，并使版本和 Test Set 按合同降级。全过程明确是非生产治理模拟，不是合规认证。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Data Asset upload idempotency、Controlled Deletion、G-14
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 7.6、FR-02、FR-08、场景 I
- [Decision record B-3](../../../docs/reviews/phase1a-solo-owner-decision-record.md#4-b-3受控删除)
- [Architecture deletion](../../../docs/architecture/phase1a-architecture.md#14-受控删除传播)
- [ADR-0008](../../../docs/adr/0008-controlled-deletion-propagation.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-DELETION-* 和删除故障注入

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Deletion preview/event、closure snapshot/hash、fail-closed lock state、minimal deletion tombstone、non-content upload-idempotency tombstone、version/Test Set degradation 和 external-copy disposition |
| Domain | dependency closure、shared blob reference rule、preview drift、confirm/retry、传播顺序和降级不变量 |
| Public interface | Owner preview/confirm/outcome/retry、degraded/tombstone read 和所有受影响 download/reference 拒绝 |
| UI | 影响预览、同一 Owner 独立确认、理由、进度/失败、墓碑、默认指针、外部副本和治理模拟文案 |
| Tests | Owner/Editor/Viewer/anonymous 与跨项目矩阵、Deletion Event IDOR、完整闭包/shared blob/asset-level、preview drift、每阶段故障、幂等重试、默认/全部版本降级和浏览器场景 I |

## Gap closure

关闭 G-14：冻结非敏感 structured reason ID、result/disposition ID 和必要时的“other + note”。不得把值命名为法律依据、合规结论、双人审批或服务器外已验证删除。

## Acceptance Criteria

1. 只有 Owner 可以 preview 和 confirm；Editor/Viewer/匿名均被服务端拒绝。
2. preview 在一致数据库 snapshot 中包含目标字节、Parsed View、临时/派生内容、Candidate、Case Revision、Version、Run、Lineage、Delivery/export、shared blob refs 和 external copies。
3. asset-level Agent Lineage 按完整相关 Derived Asset 范围进入闭包，不伪造 record precision。
4. 同一 Project Owner / Sole Developer 在独立步骤提交 preview ID/hash、reason code 和 note；审计如实显示同一人，不显示不存在的审批人。
5. 相关 revision 漂移使 preview 失效，必须重新预览；确认后不可取消。
6. 第一笔确认 transaction 立即阻断闭包的读取、下载、导出和新引用，并在默认版本受影响时原子清空指针；此状态不伪装成删除完成。
7. Worker 幂等删除规定的 Parsed View、Candidate、Revision payload、Package/CSV 和不再被未受影响注册引用的 blob；missing object 视为已经删除。
8. shared blob 仍有未受影响合法 Data Asset 引用时不得物理删除；若必须删除，全部引用必须在 preview 中。
9. 任一步失败保持闭包不可访问，记录准确阶段并能从同一 event 重试，不自动恢复可用。
10. 最终 deletion tombstone 只保留决策记录允许字段，不含 filename、source URL、Prompt、record value、Business Metadata 或其他载荷。
11. 被删 Data Asset 的上传幂等记录降为独立的非内容 tombstone，只保留作用域/键摘要、操作类型、已删除资源不透明 ID、结果类别和必要时间；相同键重试返回 `idempotency_resource_gone`，不重建资产，也不保留原始哈希或 Source Attribution。
12. 受影响 Version 进入 `degraded_by_deletion`，不能默认、导出或评测；默认指针不自动回退。
13. 全部 Version 降级时 Test Set 进入 `unavailable_by_deletion`，阻断 Working Draft、export 和 evaluation；仍有完整 Version 时只能由 Owner 后续显式设默认。
14. downloaded Delivery 产生 external-copy disposition list；系统不撤回或验证服务器外副本。
15. UI、Audit 和测试报告明确“非生产治理流程模拟”，不声称法律、隐私或合规认证；Phase 1A 无备份删除重放。
16. preview、confirm、outcome 和 retry 公共路由复用 Ticket 12 的统一 capability check 并复检对象项目归属；Editor/Viewer/匿名 preview/confirm 被服务端拒绝，跨项目 Deletion Event opaque ID 不能读取、确认或重试。

PRD trace: AC-04 的删除后上传幂等结果、AC-07、AC-38 的同一 Owner 审计、AC-41、AC-47 的删除降级部分，以及场景 I。

## Out of scope

- 备份删除、生产保留期限、法律依据、外部副本技术撤回、双人审批或合规认证。
- 普通硬删除已发布历史。

## Definition of Done

- 场景 I 和每个传播故障点通过真实 PostgreSQL/MinIO 测试。
- G-14 contract Fixture 固化；最小 tombstone 通过字段 allowlist 测试。
- 默认清空、全部版本降级和 shared blob 行为可独立演示。
- 真实 S-HTTP 覆盖 Owner/Editor/Viewer/匿名 preview/confirm 矩阵，以及 Deletion Event outcome/retry 的跨项目 IDOR；不存在路由的 `404` 不作为权限证据。

## Comments

- **2026-08-26 — Implementation completed at `f2b2cfe` (initial implementation `03fb57e`, race repair `7c575eb`).** Added the Owner-only preview/confirm/outcome/retry S-HTTP seam and non-production governance UI; frozen closure hashes, structured non-sensitive reason codes, same-Owner audit facts, project-scoped opaque event checks, fail-closed deletion locks, preview-drift rejection, idempotent worker execution, minimal content-free tombstones, upload-idempotency resource-gone tombstones, shared-blob protection, Version/Test Set degradation, default-pointer clearing, external-copy dispositions, and parser/candidate/Transformation Run race guards. The final repair preserves transient Parser retry behavior while preventing a deletion race from restoring a locked or tombstoned Parsed View. No production, backup, compliance, external-copy recall, or Phase 1B behavior was added.
- **2026-08-26 — P1 closure repair at `e661d4a`.** Required a non-blank, at-most-500-character reason note for every structured reason code and synchronized the S-HTTP, UI, and Scenario I seams. Shared Data Asset blobs now remain Worker candidates when preview defers deletion; the final transaction takes the global SHA-256 lock, tombstones target assets, rechecks active cross-project references, and only then removes the blob and marker, with a real PostgreSQL/MinIO two-project race test. Upload commit rechecks object existence after acquiring the same blob lock so a concurrent final deletion cannot leave a dangling Data Asset reference. No product scope, Production Gate, or Phase 1B behavior changed.
- Public evidence: `tests/integration/controlled-deletion.test.ts` covers the Owner/Editor/Viewer/anonymous and cross-project event matrix, frozen-preview drift, overlapping confirmations, shared-blob protection, upload idempotency, fail-closed reads and deletion completion; `tests/integration/controlled-deletion-closure.test.ts` covers direct/indirect derived assets, record/asset lineage, Transformation Run consumers, unaffected versions, explicit default selection, and prompt/evidence cleanup; `tests/integration/controlled-deletion-faults.test.ts` covers MinIO, PostgreSQL, candidate payload/evidence, delivery package, and version manifest failures with retry convergence. `tests/e2e/scenario-i.spec.ts` proves the browser governance simulation and completed tombstone view.
- Historical validation at `f2b2cfe` (before the current closure repairs): `npm run test` passed (15 files / 115 tests); the dedicated real PostgreSQL/MinIO Compose integration run passed (3 files / 19 tests); Scenario I browser E2E passed (1/1); the then-required type, lint, format, docs, diff, and Node.js 24 Compose build checks passed. The dedicated Compose Web health identity was `git_sha=f2b2cfe`; PostgreSQL and MinIO remained on their named persistent volumes with no host-published service ports.
- Historical Ticket Closure Review at fixed HEAD `f2b2cfe` (before the current closure repairs): the complete AC/DoD matrix covered closure completeness, shared-blob and asset-level lineage, preview drift, fail-closed visibility, all deletion stages and retries, minimal tombstone allowlists, upload-idempotency tombstones, version/default/Test Set degradation, external-copy dispositions, parser and Worker races, public S-HTTP authorization/project isolation, UI Scenario I, cross-Ticket seams, and scope boundaries. Its accepted P2 was the possible over-serialization of unrelated digests by `hashtext` advisory locks; this historical result is superseded by the revalidation below.
- **2026-08-26 — Revalidation of repair `e661d4a` at evidence HEAD `4cfba95`.** Node.js 24 Compose integration passed (17 files / 158 tests) and unit tests passed (15 files / 115 tests); the Ticket 14 Scenario I passed (1/1), and the isolated non-Ticket-14 draft-workbench capacity test passed (1/1). `npm run typecheck`, `npm run lint`, and `npm run format:check` passed in Node.js 24; host `npm run docs:check` and `git diff --check` passed. A full 23-test E2E run had 22 passes and one non-Ticket-14 ordering timeout; the failed test passed when rerun in isolation and is retained as an environment/order residual, not as Ticket 14 evidence. Web/Worker were rebuilt from this tree and `/health` returned `git_sha=4cfba95`; PostgreSQL and MinIO stayed on the dedicated internal network and named volumes with no host-published service ports.
- **Ticket Closure Review at fixed implementation/evidence HEAD `4cfba95`:** The same complete AC/DoD, authoritative-document, public-seam, negative/error/retry/cancellation, bidirectional concurrency, cross-Ticket, capacity/evidence, lifecycle, and Phase 1B/production-boundary matrix was rerun after `e661d4a`. Standards and Spec axes found no unresolved P0/P1. The accepted P2 remains `hashtext` advisory-lock over-serialization; external VPN/public reachability is an Owner-confirmed assumption rather than a machine-proven claim, and the isolated non-Ticket-14 E2E residual is recorded above.
- Gate and stop point: Non-production Server Development Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`. Ticket 15 remains `not-started`; Ticket 14 completion does not authorize or begin it. External VPN/public reachability is not claimed as machine-proven, no production/security/privacy/legal/compliance approval is claimed, and no remote push was performed.
