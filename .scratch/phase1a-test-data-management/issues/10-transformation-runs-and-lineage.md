# Phase 1A-10：Transformation Run 与双粒度 Lineage

Status: ready-for-agent
Implementation: completed

Blocked by: [03](./03-source-attribution-and-asset-lifecycle.md), [07](./07-multi-asset-v2.md), [08](./08-case-revisions-and-version-lifecycle.md)

## Outcome

用户可以把外部代码/规则、Agent、人工或未知工具的输出登记为 Derived Asset 和 immutable Transformation Run。系统按处理类型要求 record-level 或 asset-level Lineage，并在 UI、发布校验和冻结证据中诚实展示。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Lineage/Transformation Run、G-09
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-09、FR-10、外部清单和场景 D
- [Domain language](../../../CONTEXT.md)
- [Architecture lineage module](../../../docs/architecture/phase1a-architecture.md#68-lineage--transformation-run)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 F-LINEAGE-*、F-TRANSFORM-*

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Transformation Run manifest/revision、Derived Asset output、typed lineage edge、record/asset scope、manual event 和 append-only annotation |
| Domain | 清单校验、operation/lineage decision table、DAG/cross-project checks、publication lineage gate 和 trace graph |
| Public interface | 注册/查看 Run、上传 output、提交 record edges/asset scope、trace subject、验证发布资格的 S-HTTP |
| UI | Derived Asset/Run 表单、缺字段、record/asset badge、父记录或输入范围、最多三跳追踪 |
| Tests | manifest 参数化、DAG/cross-project 负向、record/asset trace、场景 D HTTP/浏览器和 package evidence |

## Gap closure

关闭 G-09：选择最小 Prompt evidence 方案，支持直接内容或一个受控、可验证 immutable reference；固定 hash、授权和导出行为。不建设 secret manager，不导出无权读取的外部正文，也不放宽当前禁止秘密/敏感数据的边界。

## Acceptance Criteria

1. 支持 code/rule、Agent rewrite/extraction、Agent augmentation/generation、manual revision 和 unknown external tool 清单。
2. 所有 Run 至少冻结 purpose、tool/version、parameters、inputs、outputs、actor、time、counts 和 hashes。
3. LLM/Agent 额外冻结 provider、model、model parameters、Prompt content/immutable reference、Prompt version/hash 和 lineage level。
4. 只有 Agent augmentation/generation 可选择 `asset_level`；它必须引用完整输入资产/版本范围且不得创建伪造父 Test Case edge。
5. import、code/rule、Agent rewrite/extraction 和 manual revision 必须提供 `record_level` output-to-one-or-more-input edges。
6. 缺少对应类型任一核心字段、用 `unknown` 绕过核心证据、粒度不合法、跨项目 edge 或 lineage cycle 均阻断发布。
7. Run 被 Candidate/Version 引用后核心 manifest 不可原地修改；补充说明只可 append。
8. 每个普通 Test Case Revision 至少追到精确 Source Record、父 revision 或 manual creation event。
9. 页面从 Version/Test Case 最多三次跳转到实际 record-level 起点，或 asset-level 完整 Run/输入范围。
10. UI、导出证据、指标和 validation report 逐条显示真实 lineage level，不把可审计表述为确定性重放。
11. 场景 D 可演示 Agent asset-level 扩写；缺核心字段版本不能发布。

PRD trace: AC-20 的 lineage block、AC-26、AC-28 至 AC-31、AC-48 的 trace 部分、AC-49。

## Out of scope

- 在 EvalBase 内执行清洗、代码、LLM、Agent 或 Prompt。
- Embedding、语义聚类、Pipeline engine 或虚构 per-record parent。

## Definition of Done

- G-09 Adapter contract 固化。
- operation/lineage decision table 的正负 Fixture 全部通过。
- 场景 D 的 UI、发布门禁和冻结证据可独立验证。

## Comments

- 2026-08-23：Project Owner 授权后完成 Ticket 10，实现提交固定为 `3762352`。本票新增 `import`、code/rule、Agent rewrite/extraction/augmentation/generation、manual revision 与 unknown external tool 的 immutable Transformation Run 合同；冻结 purpose、tool/version/code 或制品引用、parameters、authoritative input hash/scope、output hash/count、actor、时间、模型供应商/名称/参数、Prompt 版本/哈希与 lineage level。Prompt evidence 采用两种 G-09 允许形式：服务端计算哈希的直接内容，或绑定同项目 immutable Data Asset 的受控引用；注册时复检引用对象哈希、项目归属和允许 Source Attribution。未执行外部工具，不建设 secret manager，不导出无权读取正文。
- 数据与发布链路：新增 `transformation_run`、input/output、typed record edge、Candidate freeze join 与 append-only annotation；`data_asset` 区分 raw/derived，Candidate item 与 Test Case Revision 保存真实 lineage level 和 Run 引用。Run 被 Candidate 引用后不可补全/改写，annotation 只追加且不改变 manifest hash。record-level Run 的每个 output ordinal 必须映射到同项目且属于声明输入范围的具体 Source Record hash 或 parent case revision content hash；asset-level 仅限 Agent augmentation/generation，并冻结完整声明输入范围且不伪造 per-case parent。跨项目引用、非法粒度、缺失/空 record edges、核心字段缺失/伪造和并发 lineage cycle 均阻断。
- 公共 seam：S-HTTP 支持注册/查看 Run、补全未引用 incomplete Run、追加 annotation、trace version/case revision；UI 支持处理类型、模型参数、Prompt 直接内容/受控引用、输入 version hash/scope、多输入 JSON、record/asset badge、Run 工具/模型/Prompt/范围证据和最多三跳向上追踪。标准包输出 `lineage.jsonl` 与 `transformation-runs.jsonl`；UI、Candidate report、Manifest counts 与 offline validator 均逐条显示真实 lineage level，不把可审计证据描述为确定性重放。
- 测试证据：`tests/integration/transformation.test.ts` 在真实 PostgreSQL/MinIO 上覆盖 asset-level Run 注册、record-level exact parent hash/scope、Agent asset-level v2 发布与包证据、incomplete Run 阻断/授权拒绝/补全恢复、并发 cycle 与跨项目引用；`tests/unit/transformation.test.ts` 覆盖 8 类 operation 的 common/type-specific omission matrix；`tests/unit/validator.test.ts` 覆盖 asset/record 正向、 forged Prompt/edge、多输出 parent swap 与重封包；`tests/e2e/scenario-d.spec.ts` 在真实浏览器完成 Scenario D。record-level trace 已从 transformed case 递归到 parent revision 和具体 Source Record。
- 验证 at implementation `3762352`：`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm test`（14 files / 92 tests）、`npm run docs:check`、`git diff --check` 通过；专用 Compose 中 `npm run db:migrate && npm run test:integration` 为 11 files / 96 tests 通过；独立 Compose E2E 为 18/18 通过；固定 Node.js 24 容器 `npm run build` 通过；全新空 PostgreSQL DB 迁移记录 `ticket10-transformation-lineage-v1`，6 张 Transformation 表和 5 个 lineage/asset-kind 列均存在。一次既有单条 input E2E 在共享持久开发卷上超过原 30 秒观察窗口，按异步 Job 合同把公共 UI 观察等待提高到 60 秒并保留原容量断言；最终完整 E2E 通过。
- Closure Review：固定 HEAD `3762352` 的 Standards 与 Spec 双轴完整 Closure Matrix 均为 `Ticket Closure Review P0/P1 cleared at 3762352`。接受的 P2 / residual risk：注册路径逐 edge 数据库复检在 10,000 edge 规模存在性能风险；polymorphic input/edge 引用依赖事务内应用校验而非单一 FK；少量负向集成断言直接检查私有表以证明未创建半成品；Run 补全无专门 completion audit（注册/annotation 有审计）；离线 Prompt 校验可能忽略无效但未选用的备用形态；更深血缘链在三跳边界显示下一 Run/input scope 供继续追踪。上述风险不改变本票正确性合同。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 11 未开始，不自动推进。
- 2026-08-23：按 Closure Review 返修授权提交 `c7e7049`，保持本票范围不变。修复 Transformation Run 输出记录数上限（10,000）、record edge 的 ordinal/input 唯一性、三跳 trace 的可达边过滤、离线 validator 与完整 operation decision table 的一致性、asset-level 输入/输出与冻结 Run 精确一致性、非对象 JSON body 的稳定 422、completion 对核心 manifest/lineage 的锁定、immutable Prompt reference 的项目/哈希/Source Attribution 校验，以及 Worker 对 Derived output 的排除。
- 2026-08-23：提交 `bc2a40b` 完成最后两项 P1 修复：离线 validator 强制 `manifestHash` 存在、为合法 SHA-256 且等于重算值；record-level 离线校验按未消费的精确 `parent_inputs` edge 匹配 output ordinal，不再把 Candidate item index 当作原始 output ordinal。新增对应缺失/伪造 hash 与筛选后非连续输出负向/正向测试。
- Closure Review（重跑）：固定代码 HEAD `bc2a40b`，基线为 `3762352`；按同一完整 Closure Matrix 复核 AC 1–11、DoD/G-09、PRD FR-09/FR-10、Spec §15、Architecture §6.8/§6.10、相关 ADR、Test Plan、AGENTS、HTTP/UI/package/offline-validator seam、正负/授权/并发/取消/持久化/容量证据及跨 Ticket 交互。Standards 与 Spec 双轴均无 P0/P1，结论为 `Ticket Closure Review P0/P1 cleared at bc2a40b`。
- 重跑证据：`npm test`（14 files / 98 tests）、`npx vitest run tests/unit/validator.test.ts`（18 tests）、Ticket 10 专用 Compose 集成（10/10）、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run docs:check`、`git diff --check` 和独立 Compose E2E（18/18）通过。完整 Compose 集成套件为 88/100；12 项失败均为既有 Ticket 06 并发锁时序（4）或 Ticket 09 lease/retry/crash（8），Ticket 10 专用集成 10/10 通过，未修改其他 Ticket。
- 接受的 P2 / residual risk：离线 validator 对重封包中的重复 Transformation Run ID 取首个匹配项而未主动拒绝；未逐项核对嵌套 lineage summary 中可选的 operation/hash/level；注册时逐 edge 复检在 10,000 edge 规模可能有性能风险；polymorphic input/edge 依赖事务内应用校验而非单一数据库 FK；少量负向集成测试使用私有表断言未创建半成品；Run completion 没有独立 completion audit；三跳以外仅展示边界而不宣称完整追踪；离线 Prompt 校验未为未选用备用形态提供额外证明。这些均不阻断当前 Closure Review。
- Gate 与停点：Non-production Server Development Gate 仍为 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 11 未开始，Ticket 10 完成不自动推进下一票；不提交业务代码以外的范围变更，不推送远端。
