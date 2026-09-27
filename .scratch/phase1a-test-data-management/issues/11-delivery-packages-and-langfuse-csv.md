# Phase 1A-11：交付包与 Langfuse CSV

Status: ready-for-agent
Implementation: completed

Blocked by: [05](./05-mapping-and-formal-schema.md), [08](./08-case-revisions-and-version-lifecycle.md), [10](./10-transformation-runs-and-lineage.md)

## Outcome

用户可以从一个固定、完整 Test Set Version 生成 Standard Version Package、Full Provenance Package 和本地校验的 `langfuse.csv`。接收方可以用 Offline Validator 区分验证级别并诊断损坏包；人工 CSV 状态不会被展示成 Langfuse 远端验证。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Package Delivery、Offline Validator、G-13
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-11、包契约、场景 F
- [Architecture package/CLI](../../../docs/architecture/phase1a-architecture.md#12-交付包与离线校验器)
- [ADR-0005](../../../docs/adr/0005-deterministic-artifacts-and-offline-validation.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 Golden Package 和损坏包

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Package/CSV artifact、Delivery Record、verification level、download/user attestation、独立 delivery hash 和 external-copy fact |
| Domain | frozen evidence selection、Standard/Full distinction、deterministic ZIP/CSV、safe package validation 和 delivery state |
| Public interface | request package/CSV、Job/result、授权下载、attest imported；完整 S-CLI report/exit contract |
| UI | 包类型/验证能力、生成/下载、CSV 预览/映射说明、未远端验证警告和用户确认 |
| Tests | 五个 Golden、单因素 corruption matrix、CLI 黑盒、CSV 安全/Schema、下载故障与浏览器场景 F |

## Contract rule

生产者和 Validator 必须继续消费 Ticket 01 冻结的唯一 package format/conformance Fixture。若实现发现 G-13 无法在该合同内完成，停止并标记 `needs-info`；不得各自定义第二套字段、错误码或 ZIP 规则。

## Acceptance Criteria

1. Standard Package 逻辑文件完整，读取发布时冻结的 Schema、Recipe、Parsed View、Source Attribution、Transformation Run 和 Lineage，不读取 current mutable 值。
2. Standard Package 不含原始资产字节，并准确报告仅验证冻结证据及引用。
3. Full Provenance Package 包含完整 Standard 内容及版本实际引用的原始/派生资产和 filename manifest，不扫描整个项目 bucket。
4. Full validation 额外验证原始字节、locator 和 Source Record hash；两种成功报告不得混称。
5. 重复生成相同版本/类型/format configuration 得到确定性 ZIP 业务字节与相同 delivery hash。
6. Golden corruption matrix 覆盖缺失/额外/重复/危险路径、checksum、分层哈希、JSON/JSONL、计数、Schema、identity、lineage、资源限制和不支持版本。
7. CLI 按 ADR 返回 `0/1/2/3`、稳定 JSON report 和不含数据正文的 stderr；不连接任何服务。
8. `langfuse.csv` 使用 UTF-8、表头 `input/expected_output/metadata`、合法 JSON cell 和正确 delimiter/quote/newline。
9. CSV metadata 在 `_agentbench` 中加入本地 `case_id`/version identity，不覆盖业务 key；公式注入防护保持可核对语义。
10. 本地校验覆盖表头、行数、JSON cell、Formal Schema、CSV syntax 和 mapping contract。
11. UI 明确：未获取/验证远端 Schema、没有稳定远端 item ID、重复人工上传不幂等。
12. Delivery 状态只使用 `generated → downloaded → user_confirmed_imported`；最后一项是用户声明，不变成 `succeeded`。
13. package/CSV generation 在 marker/数据库可见性前可取消；流中断/重试不产生重复 Delivery。

PRD trace: AC-32 至 AC-34、AC-50，以及场景 F。

## Out of scope

- Langfuse SDK/API、远端 Schema、稳定远端 item ID、自动同步、固定远端版本和结果回流。
- UI/远程服务形式的 Validator。

## Definition of Done

- 所有正向 Golden 和 corruption variant 在 CLI 黑盒通过预期 exit/report。
- Standard/Full 验证级别和 CSV 警告可在 UI 独立演示。
- 场景 F 停止在本地生成/下载/用户确认，不声称远端成功。

## Comments

- **2026-08-23 — Implementation completed at `5a24d9a`.** Implemented deterministic Standard and Full Provenance package generation, exact referenced-asset closure, pre-commit Full validation, delivery listing/download/external-copy facts, local Langfuse CSV generation and contract validation, Offline Validator Standard/Full reporting and corruption diagnostics, and Scenario F UI without any Langfuse remote connection or remote-validation claim.
- Public evidence: `tests/integration/package-delivery.test.ts` covers deterministic Standard/Full replay, Full raw-byte validation, local CSV validation, Viewer export versus attestation authorization, queued package/CSV cancellation, object-storage interruption retry, and one logical Delivery. `tests/integration/transformation.test.ts` proves a derived Full package contains both the transformation output asset and its parent-version input asset. Static Goldens cover Standard `gold_required`, Standard `input_only`, Full mixed evidence, and both Langfuse CSV modes; `tests/unit/validator.test.ts` covers CLI JSON/exit behavior and the single-factor corruption matrix; `tests/unit/langfuse-csv.test.ts` covers header, row count, canonical JSON, Formal Schema, quoting/newline, formula semantics, reserved metadata, and frozen-item mapping. `tests/e2e/scenario-f.spec.ts` proves Scenario F stops at local generation/download/user confirmation.
- Final validation at `5a24d9a`: `npm run format:check`, `npm run typecheck`, `npm run lint`, and `npm test` passed (`15` files / `113` tests). `docker compose run --build --rm test sh -lc 'npm run db:migrate && npm run test:integration'` passed (`12` files / `104` tests). A fresh temporary PostgreSQL migration verified non-null delivery fields, all delivery checks, and the logical unique index. `npm run test:e2e` in the fixed Playwright/Node 24 Compose image passed (`19` tests). `npm run docs:check`, `git diff --check`, and the Node 24 Compose `npm run build` passed.
- Standards + Spec review completed after fixes. No P0/P1 remains. Residual P2 risk: the referenced-asset closure SQL is intentionally lineage-semantic and should retain the current real PostgreSQL Transformation/package regressions to detect future lineage drift. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`.
- **2026-08-24 — Authorized closure repairs fixed at `aa26a5c`.** Full Provenance and Langfuse CSV final Delivery transactions now lock the target `test_set_version`, recheck project ownership and reject `degraded_by_deletion` before inserting Delivery, Audit, or completing the Job. Rollback leaves no domain-visible Delivery or successful Job; the change stays within Ticket 11 and does not implement Ticket 14 deletion transitions.
- Closure Review (fixed code HEAD `aa26a5c`, baseline `a219e91`): the complete matrix covered AC 1–13/DoD, Implementation Spec §20–21/G-13, PRD FR-11/AC-32–34/AC-50 and Scenario F, Architecture §12, ADR-0005/ADR-0008 boundaries, Test Plan, AGENTS, S-HTTP/S-CLI/S-BROWSER/S-MODULE seams, positive/negative/authorization/error/retry/cancellation/persistence/concurrency behavior, and cross-Ticket interactions. Standards and Spec axes found no P0/P1; conclusion: `Ticket Closure Review P0/P1 cleared at aa26a5c`.
- Recheck evidence at `aa26a5c`: `npm test` (15 files / 115 tests), Ticket 11 real PostgreSQL/MinIO integration (10/10), `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, `npm run build`, `git diff --check`, and Compose health all passed. `/health` reported `git_sha=aa26a5c`; the fixed Compose image uses Node.js 24 and pinned PostgreSQL/MinIO images.
- Accepted P2 / untested claims: `hydrateSourceSnapshots` does not independently recheck the frozen `source_attribution_revision` project's ownership when a corrupted Candidate carries only an attribution ID; normal HTTP creation paths prevent this, but a future hardening fixture should close it. Ticket 14 owns the `degraded_by_deletion` state transition and migration constraint, so that state was not force-created in Ticket 11; the fail-closed guards are implemented but their future transition remains untested. The duplicated Full/CSV final version guard is a maintainability P2 only. These do not block the current closure.
- Gate and stop point: Non-production Server Development Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`. Ticket 12 remains `not-started`; Ticket 11 completion does not authorize or begin it. No remote push and no production, security, privacy, legal, or compliance approval is claimed.
