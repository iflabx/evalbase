# Phase 1A-08：用例修订与版本生命周期

Status: ready-for-agent
Implementation: completed

Blocked by: [07](./07-multi-asset-v2.md)

## Outcome

用户可以重算 Working Draft、比较 `v1`/`v2`、查看 Test Case 身份和不可变 revision 的连续性，显式切换默认版本，并在不删除历史的情况下归档非默认完整版本。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Test Case identity、Atomic publication、Version rules、G-11
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-08、FR-09、场景 C/E
- [Domain language](../../../CONTEXT.md)
- [ADR-0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)
- [ADR-0007](../../../docs/adr/0007-test-case-identity-and-revisions.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-CASE-*、F-VERSION-*

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | draft case binding unique key、immutable Test Case Revision、lineage fingerprint、version membership/diff、default pointer、archive state 和审计 |
| Domain | 幂等 identity/revision resolution、父版本继承、版本比较、默认切换、archive precondition 和不可变读取 |
| Public interface | 重物化、版本/用例查询、revision diff、版本比较、设置默认、归档的 S-HTTP |
| UI | Test Set version history、case/revision detail、+/−/~/= 比较、默认切换、归档阻断和场景 E |
| Tests | 并发 identity upsert、重试、immutability、diff reconciliation、default/archive 行为和浏览器 E2E |

## Gap closure

按 G-11 omission-first，只实现已确认的 archive 行为。不得增加 restore；默认版本归档必须先显式选择另一个完整版本。

## Acceptance Criteria

1. 新 Source Record 第一次进入目标 Test Set 时立即获得持久化、不透明 `case_id`。
2. 同一 `test_set_id + draft_source_id + source_record_ref + output_slot` 并发绑定或重算只返回一个 `case_id`。
3. 未来 Working Draft 重新追加同一 Data Asset 因新的 `draft_source_id` 默认生成新身份。
4. 父版本成员继承 `case_id`；内容和 lineage fingerprint 均不变时复用原 `case_revision_id`。
5. 内容或 lineage 变化创建新 immutable revision，`case_id` 不变；历史版本继续访问旧 revision。
6. 任意版本读取返回冻结内容和 Manifest hash；普通命令不能修改已发布 membership、Schema、证据或哈希。
7. 版本比较的 added、removed、modified、unchanged 计数与逐条结果完全一致，并显示 Formal Schema、Recipe 和 source 变化。
8. `v1` 自动默认；后续版本不自动切换。用户可显式把完整、未归档历史版本设为默认并填写原因。
9. 设置默认不会删除或改写较新版本；审计记录 actor、reason 和 UTC time。
10. 非默认完整版本可 archive；当前默认、degraded 或不完整版本不能通过普通 archive 路径。
11. UI 完成场景 C 的 `+10 / -2 / ~5` 和场景 E 的显式回退。

PRD trace: AC-11、AC-16、AC-23 至 AC-25、AC-27、AC-47 的普通版本部分、AC-48 的 case identity 部分。

## Out of scope

- restore、版本分支/合并、语义 diff、LLM summary、就地修改或自动回退。
- Controlled Deletion 导致的降级；由 Ticket 14 实现。

## Definition of Done

- identity/revision 并发和版本不可变性在真实 PostgreSQL 上通过。
- 场景 C/E 可独立演示，diff 计数和逐条明细可机器对账。
- 没有 restore 或其他未确认生命周期动作。

## Comments

- 2026-08-21：Project Owner 授权后完成 Ticket 08，并在修复审查发现的问题后固定实现提交 `4b38ac5`。本票实现持久化不透明 `case_id`、同草稿幂等绑定、未来重新追加的新身份、父版本成员继承、内容与 lineage fingerprint 双条件 revision 复用、内容/血缘变化新 immutable revision、冻结版本/用例读取、精确 `+ / - / ~ / =` reconciliation、Formal Schema/Recipe/source 前后快照、版本历史、显式默认切换和非默认版本归档。默认切换与归档在 PostgreSQL 锁内复检 owner/editor 权限、完整版本状态和乐观默认指针，并写入稳定 correlationId 与命令 fingerprint 的审计事件；人工用例创建同样在锁内复检当前项目权限。
- 公共测试 seam：真实 PostgreSQL/MinIO S-HTTP 版本历史、用例 revision、版本比较、默认切换、归档、物化 replay、撤销 Editor 权限、重新追加身份和 lineage-only revision；真实浏览器执行场景 C 的 `+10 / -2 / ~5 / =0`、用例修订入口与场景 E 的 `v1 → v2 → v3`、显式回退、归档和哈希不变性。
- 验证 at implementation `4b38ac5`：固定 Node.js 24 容器中 `npm test` 为 12 个文件 / 80 个测试通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check`、`git diff --check` 和 `npm run db:migrate` 通过；专用内部 Compose 网络中 `npm run test:integration` 为 9 个文件 / 69 个测试通过；新增 lineage-only S-HTTP Fixture 通过；独立临时内部 Compose 网络中的 `npm run test:e2e` 为 16/16 通过；部署 `/health.git_sha` 返回 `4b38ac5`。持久化开发卷上的一次 E2E 运行因历史测试数据残留有 2 个环境状态失败，不作为当前 HEAD 的产品失败证据。
- Closure Review：固定 HEAD `4b38ac5` 的 Standards 与 Spec 双轴及完整 Closure Matrix 均为 `Ticket Closure Review P0/P1 cleared at 4b38ac5`；旧实现 `6424b9f` 的 case binding 延迟、UI 未调用 case detail、Recipe/source 仅布尔值和 lifecycle replay 隔离问题均已通过代码与回归测试关闭。
- 接受的 P2 / 未测试声明：未做独立真实数据库 binding upsert race（已有公共 materialization replay 与唯一约束）；未做版本审计读取 API 的 actor/UTC 独立 seam；未做 inherited/manual 用例到原始记录或人工事件的三跳浏览器断言；完整 Viewer/匿名/跨项目 lifecycle 权限矩阵、archived package 下载资格和 archive mismatch 专项 replay 尚未在本票独立覆盖；`candidate_item.lineage_fingerprint` 仍由回填保证但未提升为 `NOT NULL`。Standards 轴另记录重复 eager-binding/lifecycle 幂等代码为判断性 P2 smell，不阻断关闭。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 09 未开始，不自动推进。
