# Phase 1A-02：三种格式适配与解析恢复

Status: ready-for-agent
Implementation: completed

Blocked by: [01](./01-utf8-csv-to-validated-v1.md)

## Outcome

用户通过同一 Data Asset 页面导入支持编码的 CSV、JSON 和 JSONL，得到统一、可定位且不改写源值的 Source Record。解析失败后原始字节仍可下载，用户可修改配置创建新解析尝试；旧 Parsed View 和已发布内容不变。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Parsed View、G-05 和状态转换
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 FR-01、FR-03、场景 B
- [Domain language](../../../CONTEXT.md)
- [Architecture](../../../docs/architecture/phase1a-architecture.md#62-parsed-view)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 C.1、T-03 和相关故障注入

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | Parsed View attempts、固定 parser config/version/hash、Source Record 查询面、字段 profile、错误/计数和 superseded 引用 |
| Domain | CSV/JSON/JSONL Adapter 共用 Source Record contract；配置重放、边界可信度和解析资格判断 |
| Public interface | 请求/重试解析、查看 attempt/job、分页预览、字段发现、定位原始内容和选择当前视图的 S-HTTP |
| UI | 编码/dialect/record-path 配置、解析状态、统计、坏记录、原始位置和重试入口 |
| Tests | 三个 Adapter 共用 S-PARSER conformance suite；真实 HTTP/Worker/PostgreSQL/MinIO；场景 B 浏览器验收 |

## Gap closure

1. TP-G01：冻结空文件和仅表头文件的 Parsed View 最终状态与用户文案。
2. G-05：冻结 field-path escaping、duplicate header/key、数字、BOM、blank line、坏记录、locator 和嵌套数组边缘语义。
3. conformance 只可收窄歧义，不得增加任意 JSONPath、改变原值或创建 Arrow/Parquet。

## Acceptance Criteria

1. UTF-8、UTF-8 BOM、GB18030 和 GBK CSV 经过同一后续工作流；自动检测可由用户显式纠正。
2. CSV 配置覆盖 delimiter、header row 和 quote rules；数据行号是稳定 locator。
3. JSON 支持顶层对象、顶层数组和用户选择一个嵌套数组；多数组组合与任意 JSONPath 被清晰拒绝。
4. JSONL 按非空物理行解析；一个坏行不遮蔽其他行级错误，物理行号稳定。
5. 所有 Adapter 输出相同 Source Record envelope，并保留源字段名、嵌套结构和值；类型推断只作为旁路元数据。
6. 总记录数始终等于成功加失败；所有边界可信的失败都有位置和原因。
7. F-JSONL-BAD-3 的三处错误准确定位；显式排除后可得到 9,997 条，报告说明排除位置和原因。
8. F-BOUNDARY-UNTRUSTED 不可成为可加入草稿或创建候选的 Parsed View。
9. 解析失败不删除或覆盖 Data Asset；修改配置会创建新的 parse attempt，已固定旧视图仍可读取。
10. 相同资产、parser version 和 config 产生相同顺序、locator、record hash、统计与错误。
11. 超过 10,000 条的 Data Asset 仍可下载，但 Parsed View 明确标记为 Phase 1A draft-ineligible。
12. 错误页说明对象、位置、原因、重试方式和实际阻断阶段。

PRD trace: AC-03、AC-08 至 AC-10、AC-40 的编码/记录资格部分、AC-42。

## Execution rules

- 第一条 red test 应通过共享 S-PARSER 证明同一合同可运行于三个 Adapter。
- 不复制三套预览、筛选或映射产品语义。
- Source Record 的公共断言不能依赖 parser 私有 AST 或库异常文本。

## Out of scope

- 草稿总容量、Candidate/`items.jsonl` 容量和发布复检。
- 全文搜索、任意 JSONPath、多数组 Join、Arrow/Parquet 或大于当前限制的处理。

## Definition of Done

- Parser conformance、HTTP 集成和场景 B 浏览器测试通过。
- TP-G01/G-05 的 versioned Fixture 与预期结果提交并由三个 Adapter 消费。
- 原件、旧 Parsed View 和已发布版本在解析重试后哈希不变。

## Comments

- 2026-08-18：Project Owner 授权后完成本 Ticket。实现覆盖 AC 1-4 的 CSV 编码/dialect、JSON 顶层/单一 RFC 6901 数组路径与 JSONL 独立物理行错误；AC 5-8 的统一 Source Record envelope、稳定 locator/hash、字段 profile、计数恒等式、显式排除与边界不可信阻断；AC 9-12 的不可变 parse attempt/config/version/hash、旧视图读取与选择、10,000 条边界、通用预览、原始位置和准确恢复说明。未实现任意 JSONPath、Arrow/Parquet、Ticket 03、Phase 1B 或 Production Gate。
- 验证：Node.js `v24.6.0` / npm `11.5.1` 下 `npm test`（46/46）、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 和 `npm audit`（0 vulnerabilities）通过；专用 Compose 中 `npm run test:integration`（7/7，含精确 50,000,000-byte 接收、三格式恢复、10,001 条阻断和 superseded 选择）与 `npm run test:e2e`（4/4，含场景 A、场景 B、窄视口、通用值/原始位置及超过 100 条错误时的分页排除资格）通过。
- Code Review：Standards 与 Spec 双轴最终复审均为 P0=0、P1=0；审查发现的生命周期逆转、CSV 编码误报、硬编码预览、未调用 location seam、选回旧视图后无法建草稿和部分排除误报均已通过 red → green 修复。保留非阻断 P2：`parser-contract-v1.json` 的部分 TP-G01/G-05 边界预期仍由同一 conformance 测试代码断言，而非全部展开为 fixture case；`src/server/app.ts`、`src/web/App.tsx` 与集成测试 setup 仅在后续出现真实变更压力时再做范围化整理。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成生产、安全或合规批准。Commit：`dfbeae6`。Ticket 03 随后在单独授权下完成。
