# Phase 1A-03：Source Attribution 与资产生命周期

Status: ready-for-agent
Implementation: completed

Blocked by: [01](./01-utf8-csv-to-validated-v1.md)

## Outcome

用户可以登记、补充和审计 Source Attribution；系统在加入 Working Draft 和发布时阻断 `unknown` 许可及禁止分类。相同原始字节可复用底层 blob，但仍形成来源和生命周期独立的 Data Asset。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Authentication/allowed data、Data Asset、Source Attribution 和 G-04
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-01、FR-02 和允许数据范围
- [Decision record](../../../docs/reviews/phase1a-solo-owner-decision-record.md)
- [Domain language](../../../CONTEXT.md)
- [ADR-0002](../../../docs/adr/0002-postgres-minio-persistence-roles.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-ATTR-*、F-SAME-BYTES-TWICE

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | 独立 Data Asset registration、content-addressed blob reference、Source Attribution revisions、允许分类标识、archive/reference state 和审计 |
| Domain | 来源修订、允许/阻断矩阵、相同字节独立身份、普通归档和已引用资产普通删除门禁 |
| Public interface | 登记/修订来源、获取冻结修订、归档、普通删除尝试、原件下载和引用查询的 S-HTTP |
| UI | 来源表单、显式 `unknown`、敏感级别、修订历史、引用状态、归档与删除阻断说明 |
| Tests | 允许/禁止组合参数化 HTTP 测试、同字节双注册、引用删除负向、真实 MinIO shared blob 集成 |

## Gap closure

关闭 G-04：冻结稳定的 source type、license state、sensitivity 和允许分类 ID，以及类型特定字段组合。ID 不得声称法律依据或生产批准。

## Acceptance Criteria

1. Source Attribution 发布必填项包括来源类型、名称、责任人、用途、显式许可状态和显式敏感级别。
2. 合成、许可清晰公开、已确认完全去标识的非敏感组合可以加入草稿并发布。
3. 缺核心字段、`license=unknown`、真实敏感、生产、秘密、受限或许可不明组合在加入草稿和发布两个阶段均阻断。
4. Source Attribution 每次变化创建不可变 revision 和审计事件；旧 Test Set Version 继续引用发布时 revision。
5. F-SAME-BYTES-TWICE 可共享一个底层 blob，但返回两个 Data Asset ID，保留不同来源、用途、责任人和审计。
6. “替换文件”创建新的 Data Asset；不得覆盖既有原始字节。
7. 普通 archive 保留字节、来源、引用和审计；不实现未确认 restore。
8. 已被 Test Set Version 引用的 Data Asset 拒绝普通硬删除，并指向受控删除流程说明。
9. 一个 registration 被归档或阻断不会改变共享同字节的另一个 registration。
10. UI 对当前非生产、非敏感允许范围和触发重新评审的条件给出准确文案。

PRD trace: AC-04 至 AC-07、AC-41 的来源/分类部分。

## Out of scope

- Controlled Deletion 的物理删除和版本降级；由 Ticket 14 实现。
- 真实敏感数据分类、生产处理依据、保留期限或法律许可判断。
- Hugging Face 直接连接或抓取执行。

## Definition of Done

- G-04 contract Fixture 与参数化测试通过。
- 相同 blob 的独立资产身份和生命周期经真实 PostgreSQL/MinIO 验证。
- 允许/禁止数据只使用合成 Fixture；不得引入真实敏感材料。

## Comments

- 2026-08-19：完成本 Ticket 的最小纵向闭环。实现版本化 Source Attribution（核心字段、类型特定字段与 G-04 fixture）、允许分类门禁、不可变 revision/事务性 audit、独立同字节 Data Asset、归档、普通删除阻断和受控删除指引；Candidate 在创建时冻结 attribution revision，已发布版本继续引用该冻结修订。未实现 Controlled Deletion 物理删除、Phase 1B 或 Production Gate。
- 验证：固定 Node.js 24 Compose 镜像中 `npm test`（46/46）、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 全部通过；真实 PostgreSQL/MinIO 的 `npm run test:integration`（26/26）覆盖必填字段、允许/禁止分类、三种允许分类的上传到发布、revision/audit、同字节独立身份/归档隔离和已发布资产普通删除拒绝；`npm run test:e2e`（4/4）覆盖来源范围说明、revision history、归档及删除指引。`npm audit` 两次均因容器 DNS 无法解析 `registry.npmjs.org`（`EAI_AGAIN`）而未取得审计结果，未改变依赖或绕过该检查。
- Code Review：以 `dfbeae675b1f311e980898f45515ef59b4dcc1dd` 为固定点完成 Standards 与 Spec 双轴最终复审，P0=0、P1=0。审查发现的 audit 原子性、审计可见性和分类证据缺口均已通过 public S-HTTP red → green 收口；同字节共享 blob 仅以公开 SHA、独立资产身份、归档隔离与下载行为验证，不以私有 MinIO key 伪造成功，符合测试计划。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成生产、安全、隐私、法务或合规批准。Commit：`9ccf7f6`。Ticket 04 随后在单独授权下完成。
