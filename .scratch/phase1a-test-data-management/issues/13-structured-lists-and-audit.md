# Phase 1A-13：结构化列表、查询与审计

Status: ready-for-agent
Implementation: completed

Blocked by: [03](./03-source-attribution-and-asset-lifecycle.md), [08](./08-case-revisions-and-version-lifecycle.md), [11](./11-delivery-packages-and-langfuse-csv.md)

## Outcome

用户可以通过已确认的结构化条件找到 Data Asset、Test Set 和固定版本内的 Test Case，并查看可追责、UTC 存储、按用户时区展示且不泄漏数据正文的 Audit Event。Phase 1A 不显示全文搜索能力。

## Required reading

- [Implementation Spec](../spec.md)，重点为 UI/list、Observability 和 G-15
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-13、页面结构和埋点
- [Domain language](../../../CONTEXT.md)，特别是 Lineage/Audit 的区别
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 T-13、AC-38/39/51

## Vertical slice

| Layer            | Deliverable                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Data             | 结构化查询索引、append-only Audit Event、UTC timestamp、漏斗 event 和可用性/交付摘要     |
| Domain           | allowlisted filter/query、case lookup、Test Set summary、audit projection 和事件计数     |
| Public interface | Data Asset/Test Set/Test Case list/query 和 Audit Event pagination/filter 的 S-HTTP      |
| UI               | 三类列表/筛选、`case_id`/metadata 查询、availability/版本/交付摘要、审计时间和空状态     |
| Tests            | query truth table、权限/跨项目、UTC/timezone、审计完整性、秘密 canary 和 no-full-text UI |

## Acceptance Criteria

1. Data Asset 列表只支持名称、来源类型、格式、状态、上传人、时间和敏感级别的结构化筛选。
2. Test Set 列表显示 availability、默认/最新版本、Test Case count、last publisher 和 recent Delivery state。
3. `unavailable_by_deletion` 与普通 archive 在 API 和 UI 上有不同状态；删除状态由 Ticket 14 最终接入。
4. 一个固定 Version 内可以按精确 `case_id` 和结构化 Business Metadata 查询，结果准确且项目隔离。
5. Phase 1A 不创建全文索引，不显示全文/语义搜索输入、占位能力或“即将可用”动作。
6. Audit Event 记录 actor、action、object、UTC timestamp、outcome 和适用引用；普通用户不能修改。
7. UI 按用户选择时区显示时间，但查询和审计事实仍使用 UTC。
8. 导入、Source Attribution 修订、草稿关键变化、容量阻断、Candidate、发布、默认切换、archive、export/download/user confirmation 均可定位到审计。
9. Lineage 不由 Audit Event 推导，Audit 也不伪装成数据因果。
10. 产品漏斗事件由结构化事件计算，失败保留在分母，不依赖解析自由文本日志。
11. Audit/list response 不输出密钥、session、Prompt 正文或原始记录正文；完整 canary 扫描由 Ticket 15 收口。
12. 只增加本票需要的稳定 error/event 名称；G-15 总目录由 Ticket 16 关闭。

PRD trace: AC-38、AC-39 的审计部分、AC-51。

## Out of scope

- 全文/语义搜索、Embedding、LLM summary、搜索引擎或 Arrow/Parquet。
- 删除传播实现；由 Ticket 14 负责。

## Definition of Done

- 结构化查询 truth table 和跨项目负向测试通过。
- 审计事件能通过公共接口对账且不可修改。
- UI 没有 Phase 1A 未实现的全文搜索入口。

## Comments

- **2026-08-25 — Implementation completed at `42b728f`.** Added project-scoped structured read seams for Data Assets, Test Set summaries, fixed-version Test Cases, Audit Events, and structured funnel summaries. Data Asset queries enforce the confirmed filter allowlist plus bounded pagination, use the newest Source Attribution revision, and reject unknown parameters. Test Set summaries expose availability, default/latest version, case count, last publisher, recent Delivery state, and ordinary `archived` status while retaining a distinct presentation contract for future `unavailable_by_deletion`. Fixed-version queries support exact `case_id` and paired top-level Business Metadata key/value only. Audit projection is read-only, paginated/filterable, stores and returns UTC facts, exposes only a narrow safe reference, and distinguishes explicit outcomes through a frozen action map. Added asset/delivery download audit events and query indexes needed by the structured paths. The Web adds a TanStack Query-backed structured lists module without a full-text/semantic search entry.
- Public evidence at `42b728f`: `tests/integration/structured-lists.test.ts` uses real upload→draft→v2 publication/default/archive/download/attestation flows to prove structured filters and pagination, Test Set summary semantics, exact case/metadata lookup, Audit Event responsibility facts, UTC filtering, failed-event denominator retention via a deterministic 50,000,001-byte upload, Owner/Viewer/anonymous access, real cross-project Version/Test Case/Asset/Audit IDOR rejection, and absence of audit reason/session/prompt/raw-record canaries. `tests/e2e/structured-lists.spec.ts` proves the real browser UI for structured Asset filtering, Test Set summaries, fixed-version case query and actionable empty state, Audit filtering/outcome/reference, UTC fact plus selected-timezone display, and no full-text/semantic search input or “coming soon” claim.
- Final validation at `42b728f`: `npm run format:check`, `npm run typecheck`, `npm run lint`, and `npm test` passed (`15` files / `115` tests). `docker compose run --build --rm test sh -lc 'npm run db:migrate && npm run test:integration'` passed with real PostgreSQL/MinIO (`14` files / `138` tests). `docker compose run --build --rm e2e npm run test:e2e` passed (`22` tests). `npm run docs:check`, `git diff --check`, and the fixed-Node-24 Compose `npm run build` passed. Standards + Spec code review found no unresolved P0/P1.
- **2026-08-25 — Review repairs completed at `436c8d3`.** The public audit projection now suppresses client-controlled default/archive correlation values, maps all currently emitted request/schedule outcomes, and keeps safe references server-generated. Case-list responses exclude input, expected output, content hashes, and manual reasons. Test Set, Data Asset, and Audit list paths use bounded pagination without client-side truncation; metadata key/value validation is paired; and the UI exposes the complete current structured action/object filters.
- Repair validation at `436c8d3`: `npm test` passed (`15` files / `115` tests); the clean temporary Node 24 PostgreSQL/MinIO Compose integration suite passed (`14` files / `138` tests); the clean temporary full E2E suite passed (`22` tests); `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm run docs:check`, and `git diff --check` passed. The deployed Web `/health` identity matched `436c8d3`.
- **Ticket Closure Review at fixed `HEAD=436c8d3`:** the complete AC-1…AC-12, DoD, public seam, permission/negative, UTC/timezone, pagination, secret-projection, failure-boundary, cross-Ticket, and lifecycle matrix found no unresolved P0/P1 on either Standards or Spec. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`.
- **Residual boundaries:** complete secret-canary scanning remains assigned to Ticket 15, and the shared G-15 error/metric catalog remains assigned to Ticket 16. `unavailable_by_deletion` is intentionally not fabricated here; its real Controlled Deletion integration remains assigned to Ticket 14. The accumulated-data structured Asset query spot check completed well below the five-second target, but the formal final P95/deployment benchmark remains Ticket 17. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`.
