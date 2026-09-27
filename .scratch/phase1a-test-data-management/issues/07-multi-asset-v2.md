# Phase 1A-07：多资产追加并发布 v2

Status: ready-for-agent
Implementation: completed

Blocked by: [03](./03-source-attribution-and-asset-lifecycle.md), [04](./04-draft-recipe-and-edit-lease.md), [05](./05-mapping-and-formal-schema.md)

## Outcome

用户从 `v1` 创建 Working Draft，追加第二个 Data Asset，为各 Parsed View 使用独立 mapping 对齐同一 Formal Schema，明确处理重复和身份冲突，人工新增/删除/修改用例后发布 `v2`。系统不执行 Join、自动去重或身份合并。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Working Draft、Mapping、identity 和 version rules
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-04 至 FR-06、场景 C
- [Domain language](../../../CONTEXT.md)
- [ADR-0007](../../../docs/adr/0007-test-case-identity-and-revisions.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-MULTI-ASSET-MAP、F-DUPLICATE-\*、场景 C

## Vertical slice

| Layer            | Deliverable                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Data             | 多个 draft source、独立 Parsed View/Source Attribution/mapping、append order、人工 creation/revision event 和 `v2` membership |
| Domain           | 父版本继承、多源 append、重复确认、identity conflict、人工理由门禁和 `v2` publication                                         |
| Public interface | 从版本开草稿、追加/移除 source、分源 mapping、重复决定、人工增删改、`v2` 预览/发布                                            |
| UI               | 父版本/多源工作台、逐源 mapping、重复/冲突提示、人工修改理由和版本摘要                                                        |
| Tests            | 真实 PostgreSQL/MinIO 的多源 HTTP 流程、重复/冲突负向、场景 C 浏览器 E2E                                                      |

## Acceptance Criteria

1. 从 `v1` 创建草稿不会修改 `v1`；草稿固定唯一 `base_version_id`。
2. 追加第二个 Data Asset 后，每个 source 保持独立 Parsed View、Source Attribution revision、mapping、lineage 和 append ordinal。
3. CSV/JSON/JSONL 等异构 source 可使用不同路径映射到同一 Formal Schema；系统不显示或执行 Join。
4. 精确内容重复产生 warning 并要求明确 include/exclude；未经确认不能形成可发布候选。
5. 传入 `case_id` 与现有 Test Case 冲突时阻断，不自动更新、合并或接管身份。
6. 手工新建以及修改 `input`/`expected_output` 必须填写 reason；纯业务 metadata 变化保存 diff 和 actor。
7. 手工创建用例符合当前 Formal Schema，并以 manual creation event 作为 record-level 起点。
8. 用户可完成场景 C 的新增 10、删除 2、修改 5，并发布 `v2`；详细身份/diff 正确性由 Ticket 08 收口。
9. `v1` 内容和哈希不变，`v2` 默认不自动成为默认版本。
10. UI 和 API 不提供自动 dedupe、identity merge、Join 或 branch merge。

PRD trace: AC-16、AC-24 的旧版本不变部分、AC-44、AC-45。

## Out of scope

- 完整 case revision 复用和版本 diff；由 Ticket 08 实现。
- 多草稿、版本分支、合并、自动去重和 Join。

## Definition of Done

- 场景 C 可以通过正常 UI 独立演示到 `v2`。
- 每个 source 的 mapping/来源/血缘不会在保存或发布时合并。
- 重复、身份冲突和人工理由负向测试通过。

## Comments

- 2026-08-20：Project Owner 授权后完成 Ticket 07 最小纵向闭环。实现 `v1` 父版本派生、多个 active `draft_source`、逐源独立 mapping/未映射确认、source 移除与同资产重新追加、父成员继承、人工新增/修改/删除、metadata diff 与 actor、精确重复 include/exclude、`case_id` 冲突阻断、manual/parent/source record-level lineage、多来源 evidence、`v2` 顺序发布与默认指针保持不变。Candidate materialization 与 publication 均复检所有冻结来源分类；两条 Source 同 ordinal 的身份绑定由实际 `draft_source` 主键约束保证。
- 验证（初始实现）：固定 Node.js 24 容器中 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 通过；专用 Compose 中 `npm run db:migrate && npm run test:integration` 为 8 个文件 / 58 个测试通过；`npm run docs:check` 与 `git diff --check` 通过。
- 2026-08-21 修复复审指出的问题，修复提交为 `19572b026bc16e7a61b062fd6b665673db516a90`：多 Source mapping validation/recipe evaluation 改为遍历 active `draft_source`；Candidate 以不可变 `draft_revision_id + schema_revision_id + materializer_version` 幂等冻结 recipe、来源和 Schema；`input_only` 显式 `expected_output: null` 可保存并物化；发布时 Source identity 使用 Candidate 冻结来源；补充响应丢失重试、双 Worker 并发 binding/membership、公共多 Source seam 回归证据。
- 修复验证：`npm test` 为 11 个文件 / 77 个测试通过；专用 Compose 中 `npm run test:integration` 为 8 个文件 / 62 个测试通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 通过。E2E、部署身份和服务器人工网络验证仍按 Closure Matrix 单独记录，不从本地集成结果推断。
- 2026-08-21 自动保存与场景 C 复审修复提交为 `1f2984c`：多 Source 自动保存不再发送无效的空全局 mapping；重复取舍只提交 Recipe 步骤、版本说明和 decision，避免未映射字段状态重置已确认的 duplicate decision；同步修正多 Source 聚合评估的 E2E 断言（`6 → 4`）。
- 修复后验证：专用 Compose 中完整浏览器 E2E 为 15 个测试 / 15 个通过；`npm test` 为 11 个文件 / 77 个测试通过；专用 Compose 集成测试为 8 个文件 / 62 个测试通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 通过。
- 2026-08-21 固定修复提交为 `8d4bcfb`：Candidate 物化容量预检改为只读取冻结 `draft_revision.sources`；人工新增/修改/删除操作按 `created_at, id` 写入 `draft_revision.operations` 并纳入 revision hash，Worker 不再读取活动 `draft_case_operation`；迁移为既有草稿修订回填操作快照。
- 2026-08-21 追加修复提交为 `77952bb`：`input_only` 中手工显式清空 `expected_output` 按操作 diff 保留 `null`；迁移只为当前 Working Draft revision 回填活动操作，历史 revision 使用空快照，避免后续操作污染历史 Candidate；补充冻结操作、冻结容量和 input-only 包内容的公共回归。
- 固定修复验证：`npm test` 为 11 个文件 / 77 个测试通过；专用 Compose 集成测试为 8 个文件 / 64 个测试通过；专用 Compose 浏览器 E2E 为 15 个测试 / 15 个通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 通过；部署 `/health.git_sha` 为 `77952bb`。集成测试中的 capacity publication-lock 三条回归在本固定 HEAD 全部通过。
- 2026-08-21 Closure 修复提交为 `9970dff`：后续只修改 metadata/input 时保留 `input_only` 手工显式 `expected_output: null` 的 diff 语义；增加一次性 `schema_migration` marker，识别并修复 `8d4bcfb` 及更早 revision operations 快照并使用 canonical JSON 重算 `revision_hash`；补充 HTTP null 回归、迁移 hash/历史 revision 单元证据。
- `9970dff` 固定 HEAD 验证：`npm test` 为 12 个文件 / 80 个测试通过；专用 Compose（停止本项目 Worker 后避免测试锁时序竞争）中 `npm run test:integration` 为 8 个文件 / 64 个测试通过；专用 Compose 浏览器 E2E 为 15 个测试 / 15 个通过；`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check` 与 `git diff --check` 通过。数据库实证含 `ticket07-draft-revision-operations-v3` marker，658/658 条现存 `draft_revision` 均匹配含 operations 的 canonical revision hash；部署 `/health.git_sha` 为 `9970dff`。
- Closure Matrix 复审固定为 `9970dff`：Ticket AC 1–10、Spec/PRD/Architecture/ADR/Test Plan/AGENTS 约束、HTTP 正负/校验/授权/重试/持久化、双 Worker binding、容量边界和场景 C 均有结果；P0/P1 清零。接受的 P2 为 freeze 路径重复快照组装、`draftCapacity` 命名、完整 revision diff（Ticket 08）、Worker lease heartbeat/crash reclaim（Ticket 09）和完整 observability/资源峰值（Tickets 16/17）；未测试声明为真实断开 Tailscale/公网不可达、灾难恢复及 Production Gate。结论：`Ticket Closure Review P0/P1 cleared at 9970dff`；不开始 Ticket 08。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。实现 Commit：`d111210`；Closure 修复 Commit：`19572b0`、`1f2984c`、`8d4bcfb`、`77952bb`、`9970dff`。Ticket 08 未开始，不自动推进。
