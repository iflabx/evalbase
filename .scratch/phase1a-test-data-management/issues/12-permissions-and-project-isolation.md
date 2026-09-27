# Phase 1A-12：权限与项目隔离

Status: ready-for-agent
Implementation: completed

Blocked by: [02](./02-format-adapters-and-parse-recovery.md), [03](./03-source-attribution-and-asset-lifecycle.md), [04](./04-draft-recipe-and-edit-lease.md), [05](./05-mapping-and-formal-schema.md), [08](./08-case-revisions-and-version-lifecycle.md), [10](./10-transformation-runs-and-lineage.md), [11](./11-delivery-packages-and-langfuse-csv.md)

## Outcome

Owner、Editor 和 Viewer 的 Phase 1A 产品权限在所有已实现命令、查询和下载上由服务端执行；匿名或跨项目请求无法通过 opaque ID、Job payload 或对象 URL 绕过隔离。真实运行仍只有 Project Owner / Sole Developer。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Authentication/authorization 和 Security tests
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 5.1、14.3
- [Decision record B-2](../../../docs/reviews/phase1a-solo-owner-decision-record.md#3-b-2权限与风险范围)
- [Architecture permissions](../../../docs/architecture/phase1a-architecture.md#13-项目权限校验)
- [Test plan permission matrix](../../../docs/test-plan-phase1a.md#f6-安全与权限测试矩阵)

## Vertical slice

| Layer            | Deliverable                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Data             | Project membership、role/capability、server-side session、test identity activation 和授权审计                             |
| Domain           | 统一 capability check、object project recheck、Worker input re-resolution 和 deny-by-default                              |
| Public interface | 所有 HTTP command/query/download 的认证、CSRF/Origin、项目能力和稳定拒绝合同                                              |
| UI               | 角色可见动作、拒绝/登录状态、非生产测试身份标识；隐藏按钮不替代服务端授权                                                 |
| Tests            | Owner/Editor/Viewer/anonymous matrix、截至 Ticket 11 已实现对象的 IDOR、download handoff 和 Worker cross-project negative |

## Staged acceptance ownership

本 Ticket 关闭截至 Ticket 11 已存在公共 seam 的权限与项目隔离，并建立后续模块复用的统一 capability check。Controlled Deletion 的数据模型、Deletion Event 和 preview/confirm/outcome/retry 公共 seam 尚不存在，由 Ticket 14 创建并通过真实 S-HTTP 补齐非 Owner 拒绝和跨项目 Deletion Event IDOR。不存在的路由返回 `404` 不能作为权限证据；本分工不改变完整 Phase 1A 权限合同。

## Acceptance Criteria

1. 未登录请求不能读取 UI data、API resource、Job、Data Asset、Package 或 CSV。
2. Owner 可管理 membership 并执行全部 P0；Editor 可导入、策展、独立发布和导出；Viewer 只读但在限定范围可导出原件和两类包。
3. Viewer 对截至 Ticket 11 已实现的所有 mutation 在服务端拒绝；Owner-only capability 决策由统一权限模块覆盖。非 Owner Controlled Deletion 请求的运行时拒绝由 Ticket 14 在真实删除 seam 上验证。
4. 每个命令/query 在进入深模块前验证 `project_id + actor_id + capability`；租约和 opaque ID 不替代权限。
5. Data Asset、Parsed View、Working Draft、Candidate、Version、Test Case、Run、Delivery 和 Job 的跨项目 IDOR 全部拒绝；Deletion Event 的跨项目 IDOR 由 Ticket 14 在该对象和公共 seam 存在后验证。
6. PostgreSQL lookup 携带或复检 project；Worker 不信任 Job payload 的对象归属。
7. 每次原件/Package/CSV 下载重新鉴权并由 Web 流式返回；浏览器不获得 MinIO credential、console 或 public URL。
8. CSRF/Origin 和 request-size check 应用于所有 mutation；actor ID 只能从 server-side session 得出。
9. UI 根据角色显示动作，但直接调用被隐藏 endpoint 仍被拒绝。
10. Editor/Viewer 仅由自动化或开发测试身份使用；页面说明这不构成真实多人、外部共享、敏感数据或生产批准。
11. Viewer Full Package/原件正向测试只使用合成非敏感 Fixture，并保留当前已接受风险说明。

PRD trace: AC-38、AC-39 的权限/不泄密部分，以及 Phase 1A 权限 Definition of Done。

## Out of scope

- SSO、真实第二用户、审批流、双人复核、`sensitive_export`、细粒度对象权限和生产认证。
- 把 VPN 可达性当成登录或授权。

## Definition of Done

- 每个已实现 command family 有服务端 role matrix 和跨项目负向测试。
- 下载授权与 MinIO 隔离经真实服务验证。
- 测试与 UI 不伪造真实多人或生产审批。
- Closure 记录明确列出由 Ticket 14 承接的非 Owner Controlled Deletion 和 Deletion Event IDOR；不得用不存在路由的 `404` 声称已验证。

## Comments

- **2026-08-25 — Ticket Closure Review repair at `2c3431f` (prior implementation `e578af3`, initial implementation `75eb76b`).** Retained the unified `read/write/export/manage` capability checker, stable development-only Owner/Editor/Viewer bootstrap, Owner-only membership management with public audit projection, server-side session actor capabilities, CSRF/Origin and request-size/type boundaries, UI project-role presentation and Viewer read-only controls, cross-project opaque-ID checks for all seams existing through Ticket 11, re-authorized Web downloads, and project-scoped Worker object/cancellation updates. The repair adds valid-manifest Transformation Run IDOR coverage, public-seam no-side-effect assertions, the non-retryable `job_actor_capability_revoked` contract, browser regression for existing Langfuse CSV Viewer boundaries, actor-spoof regression coverage, public-seam-only Delivery lookup in the browser test, and exact audit-ID cleanup for both stable and random membership fixtures.
- Public evidence: `tests/integration/permissions.test.ts` covers anonymous resources/downloads, all implemented Viewer mutation families, Owner membership management and public audit projection, stable Editor upload-to-publication flow, Viewer raw/Standard/Full synthetic exports, cross-project IDOR for Data Asset, Parsed View, Draft, Candidate, Version, Test Case, Job, Transformation Run, Delivery, lineage and package reads, valid-manifest cross-project Transformation Run rejection, public resource state stability, non-upload request Content-Type/size rejection, poisoned Worker execution, and poisoned parse/materialize/publish cancellation. `tests/integration/package-delivery.test.ts` proves both membership-revocation lock orders and the stable Worker capability-revocation Job error code through the public Job seam. `tests/e2e/permissions.spec.ts` proves the browser role UI, existing Langfuse CSV hiding, and direct Viewer rejection without exposing MinIO credentials, URLs, or private database tables.
- Final validation at `2c3431f`: `npm run format:check`, `npm run typecheck`, `npm run lint`, and `npm test` passed (`15` files / `115` tests); fixed-Node-24 targeted integration validation passed (`permissions` 15/15 and `package-delivery` 14/14), the complete fixed-Node-24 integration suite passed (13 files / 129 tests), and the complete browser suite passed (21/21) against Web health identity `2c3431f`. `npm run docs:check`, `git diff --check`, and the fixed-Node-24 Compose build passed; fresh migration also verifies the `project_member` role CHECK constraint.
- **Closure evidence and residuals:** `Ticket Closure Review P0/P1 cleared at 2c3431f`. The public Job seam exposes the stable capability-revocation error, but no public Job-audit query exists yet; the audit-event read is therefore an explicit untested claim rather than a private-table assertion. A dedicated negative fixture for frozen Source Attribution project/asset mismatch, continuous foreground UI role refresh, and the duplicated one-off browser fixture flow remain accepted P2/untested risks. Controlled Deletion and Deletion Event authorization/IDOR remain explicitly assigned to Ticket 14's real seam; absent-route `404` is not evidence. Non-production Gate remains `Passed`; Production Gate remains `Not Evaluated / Not Approved`.
