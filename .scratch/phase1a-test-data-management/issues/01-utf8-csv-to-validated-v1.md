# Phase 1A-01：UTF-8 CSV 到可离线验证的 v1

Status: ready-for-agent
Implementation: completed

Blocked by: [Non-production Server Development Gate](../../../docs/reviews/phase1a-nonproduction-server-development-gate.md)

Historical execution hold: Project Owner 于 2026-08-18 确认 Gate 通过后曾要求暂不开始 Ticket 01；该停点随后已解除，本 Ticket 已完成。

## Outcome

Project Owner / Sole Developer 可以通过正常 UI 登录，上传一份允许分类的合成 UTF-8 CSV，在不预建 Schema 的情况下形成不可变 Data Asset 和 Parsed View，完成一个等值筛选、一次显式字段映射和 `gold_required` Formal Schema 确认，物化 Candidate Snapshot，原子发布默认 `v1`，生成 Standard Version Package，并由 Offline Validator 离线验证通过。

这是第一条 tracer bullet，也是唯一允许同时建立最小应用骨架的 Ticket。只实现这条闭环实际需要的结构；不得预先创建 Phase 1A 全部数据库表、API 或页面。

当前产品、技术合同与服务器执行条件已经满足，Gate 已保存真实证据并标记为 `Passed`。本 Ticket 已完成；`ready-for-agent` 是 triage 标签，不表示实现未开始。

## Required reading

- [Implementation Spec](../spec.md)
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-01、FR-02、FR-06 至 FR-09、FR-11 和场景 A
- [Domain language](../../../CONTEXT.md)
- [Phase 1A architecture](../../../docs/architecture/phase1a-architecture.md)
- [Phase 1A frontend reuse guidance](../../../docs/architecture/phase1a-frontend-reuse.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 S-HTTP、S-PARSER、S-CLI 与场景 A
- [Non-production Server Development Gate](../../../docs/reviews/phase1a-nonproduction-server-development-gate.md)
- [ADR-0001](../../../docs/adr/0001-phase1a-deployment-topology.md)
- [ADR-0002](../../../docs/adr/0002-postgres-minio-persistence-roles.md)
- [ADR-0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)
- [ADR-0005](../../../docs/adr/0005-deterministic-artifacts-and-offline-validation.md)

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | 只增加本闭环所需的项目/Owner、Data Asset、Source Attribution、Parsed View/Source Record、Working Draft、Formal Schema、Candidate Snapshot、Test Case/Revision、Test Set Version、Job、Audit、Delivery Record 和对象引用；MinIO 保存原始字节、候选/版本文件、Standard Package 与 marker |
| Domain | 最小 Data Asset Ingestion、CSV Parsed View、Working Draft、Formal Schema、Candidate Materialization、Test Case Identity、Test Set Publication、Package Delivery 和 Offline Validator 公共行为 |
| Public interface | 登录后的 S-HTTP 上传/查询/保存/物化/发布/下载合同；UTF-8 CSV S-PARSER；`agentbench-validate <package.zip> [--json]` S-CLI |
| UI | 以旧版前端为选择性源代码种子，交付登录、Data Asset 上传/预览、最小连续 Curation Workbench、版本详情和交付下载；沿用已确认视觉语言并明确非生产/非敏感范围 |
| Tests | 从失败的 HTTP 行为测试开始；真实 PostgreSQL/MinIO 集成、CSV Parser 契约、独立 Golden/CLI 黑盒和一条浏览器 E2E |

## Required embedded prefactors

这些工作只因 tracer 立即需要而存在，不得扩张为水平平台票：

1. 执行任何工作前核对 Server Development Gate 已保存目标服务器证据并标记 `Passed`。尤其在编写持久化数据路径前，架构 §17.4 的有界技术 Spike 必须已经通过；失败时立即停止本 Ticket。
2. 按前端复用说明，以 `frontend-v1/` 为正式 Web 的源代码种子，只迁移本 tracer 需要的视觉令牌、UI primitive、应用外壳和通用状态视图；移除 Lovable 专用 hook、旧导航、旧 Mock/领域类型和 Phase 1B/Phase 2 路由。不得另建并行前端，也不得一次性搬入全部 UI 目录。
3. 建立一个 TypeScript/Node.js 24 + npm 代码库以及 React/Vite、Fastify、Worker、PostgreSQL、MinIO 的最小运行入口；旧 pnpm/`catalog:` 合同不得继承，必须使用 `package-lock.json` 和 `npm ci`。
4. 建立最小迁移、专用 Compose 和标准命令：`npm run dev`、`npm test`、`npm run test:integration`、`npm run test:e2e`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run db:migrate`、`npm run validator -- <package.zip> [--json]`。每个部署单元只实现 tracer 所需行为。
5. 关闭 G-03 的最小非生产登录方案：安全密码存储、服务端 session、CSRF/Origin、Owner bootstrap、测试身份开关和零凭据日志；不实现 SSO 或真实多人能力。
6. 冻结 G-10 canonical artifact conformance set。
7. 冻结 G-13 的 package format、checksum grammar、CLI 报告 schema、稳定诊断命名空间和安全资源限制；生产者和 Validator 必须读取同一版本化 Fixture。
8. 为 tracer 使用的简单对象 Schema 支持最小安全关键字；完整 G-08 由 Ticket 05 关闭。

## Acceptance Criteria

1. Owner 登录后，不创建任何 Schema 即可上传 F-CSV-UTF8，并得到 Data Asset ID、精确 size、MIME、SHA-256、上传人和时间；容量口径使用十进制，50 MB 明确等于 50,000,000 bytes。
2. 上传完成返回前，原始字节已经通过 Artifact Repository 的 staging、不可变对象和 commit marker 提交；下载字节与上传 SHA-256 一致。
3. 上传请求直接使用已确认的客户端幂等键合同：对象提交后丢失响应，同作用域、同键、同请求重试返回原 Data Asset/receipt；同键异指纹返回 `idempotency_conflict`，并发同键返回 `idempotency_in_progress`，新键同字节创建独立来源身份。不得把该语义推迟到 Ticket 09 决定。
4. 用户填写允许的合成 Source Attribution；页面可以查看前 100 条 Source Record，并从任一记录定位到原始内容。
5. 用户创建 Test Set 和唯一活跃 Working Draft，完成一个等值筛选、一个明确的源字段到嵌套 `input` 映射，并确认未映射字段只留在 Data Asset。
6. 用户确认一个最小 `gold_required` Formal Schema；全部选中记录通过后才能形成不可变 Candidate Snapshot。
7. Candidate 的 `payload_hash` 和 `evidence_hash` 在发布前后不变。PostgreSQL 提交使 Test Set Version、成员、Manifest、Candidate 状态、审计和默认指针同时可见。
8. 只有成功发布才分配 `v1`；`v1` 自动成为默认版本。任意读取 `test_set_id + version_id` 返回相同 Manifest hash。
9. 版本页能看到发布人、冻结 Source Attribution/Curation Recipe/Schema/校验报告和一条 record-level Source Record 起点，最多三次页面跳转到原始位置。
10. Standard Version Package 只含 PRD 规定的正式文件，不含原始资产字节；同版本、同配置重复生成得到相同业务字节和 delivery hash。
11. 独立进程执行 `agentbench-validate <package.zip> --json` 返回退出码 `0`，报告为 Standard verification level；CLI 不读取网络、数据库、MinIO 或应用配置。
12. Golden 的期望字节和哈希来自独立 Fixture，不得用生产序列化器重新生成期望值。
13. 浏览器 E2E 从登录走到 CLI 验证，不直接修改数据库、MinIO 私有 key 或后台状态。
14. UI、日志和测试结果只声明非生产研发闭环，不声称 Langfuse 远端验证、生产批准、备份、RPO/RTO/SLA 或合规认证。

PRD trace: AC-01、AC-02、AC-04、AC-05、AC-17、AC-21 至 AC-23、AC-26、AC-32、AC-33、AC-38、AC-50 的第一条完整纵向证据；跨格式、完整阻断矩阵和完整交付矩阵由后续 Ticket 收口。

## Execution rules

- 遵循 red → green：先在已确认公共 seam 写一条失败行为测试，再写最小实现。
- Gate 状态不是实现者可绕过的测试失败：若 Gate 未通过或 Spike 失败，停止本票，不得提高容量、引入 Arrow/Parquet、增加服务或放宽 P95。
- HTTP 测试只能通过公开查询验证结果；不得断言私有表布局、MinIO key 或内部调用顺序。
- PostgreSQL 事务、锁和 MinIO marker 使用真实服务；只在 Artifact Repository/Clock 边界做窄故障注入。
- React 只消费 HTTP 合同；Fastify 类型不得进入深模块；Offline Validator 不得导入存储 Adapter。
- 旧版页面只提供视觉和布局实现；浏览器内 Mock store、客户端 parser/freeze、旧状态机和 Langfuse/评测行为不得进入 tracer 运行路径。

## Out of scope

- JSON/JSONL、其他 CSV 编码和完整 Parser edge matrix。
- 完整筛选/抽样、租约接管、多资产、`v2` 和版本比较。
- `input_only`、完整 Formal Schema 子集和兼容性。
- Full Provenance Package、Langfuse CSV、受控删除和完整权限矩阵。
- 任何 Phase 1B 或 Production Gate。

## Definition of Done

- 上述 Acceptance Criteria 具备自动化证据，场景 A 的 tracer 可独立演示。
- Server Development Gate 在本票开始前已有 `Passed` 证据；该证据不被描述为 Production Gate。
- 本票新增的 Markdown、迁移、Fixture 和代码通过仓库校验。
- 未创建未被 tracer 消费的通用框架、表、页面或服务。
- 正式 Web 保留复用说明规定的视觉令牌、应用外壳和通用状态表现，并为当前 tracer 建立新浏览器基线；旧截图只作人工参考。
- 在本文件 `## Comments` 记录实现提交、验证命令和已知但不阻断后续的结果。

## Comments

- 2026-08-18：Project Owner 明确解除执行停点后，完成本 Ticket 的最小纵向闭环。实现覆盖 AC 1-4 的登录、流式上传、不可变原件、幂等、Source Attribution 与前 100 条预览；AC 5-9 的筛选、映射、Formal Schema、Candidate、原子 `v1`、默认指针与 record-level lineage；AC 10-14 的确定性 Standard Package、独立 Golden、离线 Validator、浏览器场景与非生产范围提示。
- 验证：Node.js `v24.6.0` / npm `11.5.1` 下 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（18/18）和 `npm run build` 通过；专用 Compose 中 `npm run test:integration`（3/3，含精确 50,000,000-byte 接收与 50,000,001-byte 拒绝）和 `npm run test:e2e`（2/2，含 390px 窄视口与离线 CLI）通过；`npm audit` 为 0 vulnerabilities。
- Code Review：Standards 与 Spec 双轴最终复审无 P0/P1；仅保留 `src/server/app.ts` 与 `src/worker/main.ts` 后续可能按真实变更压力拆分的 P2 判断项。未实现 Ticket 02+、Ticket 09、Phase 1B 或 Production Gate。
- Commit：`b73461e`（本地 Ticket 提交）。Ticket 02 随后在单独授权下完成。
