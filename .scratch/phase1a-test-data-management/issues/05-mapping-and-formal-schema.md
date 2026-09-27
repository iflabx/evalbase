# Phase 1A-05：字段映射与 Formal Schema

Status: ready-for-agent
Implementation: completed

Blocked by: [01](./01-utf8-csv-to-validated-v1.md)

## Outcome

用户可以通过显式、可重放的 mapping 把 Source Record 组织为正式 `input`、`expected_output` 和 `metadata`，在至少 20 条源/目标预览中定位错误，确认未映射字段处置，并按完整 Phase 1A Formal Schema 合同阻断无效候选或破坏性变化。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Mapping/Formal Schema、Candidate block list 和 G-08
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-06、FR-07 和 6.2–6.3
- [Domain language](../../../CONTEXT.md)
- [Architecture Formal Schema module](../../../docs/architecture/phase1a-architecture.md#64-formal-schema)
- [ADR-0006](../../../docs/adr/0006-formal-schema-and-compatibility.md)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-MAPPING-*、F-SCHEMA-*

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | 分源 mapping revision、未映射字段确认、Formal Schema revision、Schema proposal/profile、逐记录/字段 validation result |
| Domain | 显式映射重放、Schema suggest/confirm/validate/compare、两种 mode、完整 publication block decision |
| Public interface | mapping preview/save、Schema suggestion/confirmation、compatibility check、全量验证和错误查询的 S-HTTP |
| UI | 至少 20 条 paired preview、目标对象构造、错误定位、未映射字段列表、mode/required 确认和破坏性变化去向 |
| Tests | Mapping/Schema S-MODULE conformance、HTTP 行为、恶意 Schema Fixture 和浏览器验收 |

## Gap closure

关闭 G-08：冻结 JSON Schema Draft 2020-12 的 Phase 1A 支持关键字、local reference、schema byte/depth/property/keyword/regex 限制，以及每种支持约束的 compatibility decision table。禁止远程 `$ref`、网络/数据库访问、未设上限递归和人工覆盖破坏性结果。

## Acceptance Criteria

1. 每个 draft source 可以把源字段、嵌套字段和常量独立映射到同一正式结构。
2. 支持字段到标量、多个字段到对象、key rename、object nesting、constant 和冻结语义的基本类型解释；不执行脚本。
3. mapping 编辑至少显示 20 条 source/target pair；错误定位到 Source Record locator 与目标字段。
4. 所有未映射字段及样例被列出；Candidate 前必须保存“只留在 Data Asset”的显式确认。
5. 相同 mapping revision 重放得到相同 JSON；不得隐藏扁平化、改名、裁剪或类型转换。
6. Formal Schema 只在扫描全部选中映射结果后建议，用户确认最终 revision、必填性和 `gold_required`/`input_only`。
7. 两种 mode 都要求可序列化 `input`；`gold_required` 缺 expected output 阻断，`input_only` 允许空值且不警告。
8. 任一 mode 的非空 `expected_output` 必须通过 Schema；`metadata` 必须是 JSON object 且不能占用 `_agentbench`。
9. 映射/Schema 失败记录只有被显式排除后才不再阻断，排除进入报告。
10. compatible 变化可在原 Test Set 继续；destructive 变化返回 `requires_new_test_set`，UI 只能携带草稿创建新 Test Set。
11. Fastify route Schema 只验证 HTTP envelope，不解释 Formal Schema。
12. 发布阻断错误返回稳定类别与记录/字段引用，日志不输出原始正文。

PRD trace: AC-17 至 AC-20、AC-45、AC-46 的 Schema mode 部分、AC-47 的破坏性 Schema 部分。

## Out of scope

- 任意表达式、用户脚本、远程 Schema、语义推断或自动决定 expected output。
- 多资产追加和版本比较。

## Definition of Done

- G-08 conformance Fixture 和 compatibility decision table 固化。
- 两种 mode、恶意 Schema、mapping replay 和全量阻断测试通过。
- UI 可独立演示嵌套 input、错误定位、未映射确认和 destructive redirect。

## Comments

- 2026-08-19：Project Owner 授权后完成本 Ticket 的最小纵向闭环。实现可重放 Mapping、完整未映射字段确认、Mapping preview 错误定位、Formal Schema suggest/confirm/validate/compare、两种 mode、兼容性阻断和 Candidate invalidation；未实现多资产追加、版本比较、Phase 1B 或 Production Gate。
- 验证：Mapping/Formal Schema 单元与 HTTP 集成测试、Tracer 回归和 `draft-workbench` 浏览器场景通过；完整单元测试 `73/73`、集成测试 `35/35`、构建、类型检查、Lint、格式检查和 `git diff --check` 通过。浏览器套件此前完整运行 `8/8` 通过。
- Code Review：Standards 与 Spec 双轴最终复审均为 P0=0、P1=0；已修复 Proposal 绑定、Recipe 失效、完整 unmapped profile、locator/错误展示及容器/数组/空对象覆盖问题。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成生产、安全、隐私、法务或合规批准。Commit：`0b7cba8`（包含 `2867ea5` 的后续审查修复）。Ticket 06 不会自动开始。
