# Phase 1A-31：v5.3 上传字段拖拽映射对齐

Status: ready-for-agent
Implementation: completed

Blocked by: [30](./30-structured-test-set-records-and-version-filters.md)（已完成并经 Owner 验收）。本 Ticket 仍须 Project Owner 单独明确授权。

## Outcome

在不改变待确认上传、解析、映射、预览或批次确认 API 的前提下，让 `frontend-v3` 的上传第二步逐项对齐冻结原型 v5.3：带样例值的源字段卡通过拖拽映射到问题、期望输出或 Metadata。

## Required reading

- [Implementation Spec](../spec.md)，Confirmed Upload
- [PRD FR-03](../../../docs/PRD-v2-test-data-management.md#fr-03-两步确认上传)
- [Architecture §5.3](../../../docs/architecture/phase1a-architecture.md#53-confirmed-upload)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [v5.3 映射与删除修订](../../../docs/prototypes/phase1a-solo-workflow-v5.3-mapping-and-deletion-amendment.md)
- [v5.3 差异审计](../../../docs/reviews/phase1a-frozen-prototype-v5.3-contract-ticket-implementation-delta-audit.md)
- [Test plan](../../../docs/test-plan-phase1a.md)

## Acceptance Criteria

1. 上传第二步在现有逐文件队列中显示左右映射工作区：左侧为原始字段卡和其样例值，右侧依次为问题、期望输出、Metadata 目标；不显示逐字段下拉框、映射说明卡、Schema 或 parser 设置。
2. Owner 把源字段卡拖至目标后，目标显示对应 chip，源字段卡显示居中的透明勾选。移除或重新拖动 chip 会即时刷新现有真实 preview。
3. 一个源字段只能保留一个映射；问题和期望输出各最多一个字段，Metadata 可保留多个字段。冲突映射不得在 UI 或确认请求中残留。
4. 现有逐文件顺序、连续选择追加、去重提示、取消、真实解析问题和一次批量确认保持不变；本 Ticket 不修改其服务端数据模型、路由或事务。
5. **前端 UI 必须逐项对齐 v5.3 冻结原型。** 实现前在 Comments 写出受影响上传页的字段、控件顺序、文案、拖拽/已映射/禁用/错误状态和明确排除项；实现使用 `frontend-v1/` donor 的字体、token、组件、图标与布局，不能用新的通用组件重新设计页面。
6. 不引入 DnD 依赖、键盘替代工作流、字段类型推断、自动转换、映射模板、批量字段编辑、拖放上传、额外页面或 API。

## Frozen prototype parity

| 区域         | 必须对齐                                                              | 排除                                     |
| ------------ | --------------------------------------------------------------------- | ---------------------------------------- |
| 映射工作区   | 宽对话框、源字段卡、样例值、拖拽把手、透明勾选、三个目标区与紧凑 chip | 下拉框、字段类型、映射摘要、复杂说明文字 |
| 映射状态     | 目标悬停强调、已映射边框、chip 移除/重新分配、真实预览刷新            | 多目标绑定、转换规则、模板               |
| 既有上传步骤 | 文件队列、保存到、连续追加、跳过重复、解析问题、取消和一次确认        | 单文件确认、上传拖放、设置页             |

## Necessary tests

- 正常：上传含问题、期望输出与三个 Metadata 字段的合成 CSV；拖拽映射后检查真实预览并确认保存。
- 关键边界：把已映射字段重新分配，确认问题/期望输出不保留重复映射，Metadata 的多个字段仍各自可辨认。
- 静态：受影响确认上传前端测试、`frontend-v3` typecheck/lint/build、`docs:check` 和 `git diff --check`。不运行无关的全仓套件。

## Owner checkpoint

从同一上传弹窗选择一个小型 CSV，拖拽问题、期望输出和多个 Metadata 字段，检查样例、勾选、preview 与确认保存；再确认现有连续选择与重复文件提示未变化。

## Out of scope

上传 API、parser、映射数据结构、字段转换、Schema、映射模板、拖放上传、记录编辑、测试集、回收站、生产与 Phase 1B。

## Comments

- 2026-09-09：由 Project Owner 确认 v5.3 审计结论后创建。本记录不授权实现。
- 2026-09-09：上传第二步的 v5.3 页面一致性记录：

  | 区域       | 实现对齐                                                                                                                                                                                                            |
  | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 宽度与顺序 | 宽对话框（最大 1180px）；标题、当前文件与两步进度后，依次为左右映射工作区、现有解析问题、统一记录预览和既有取消/上一个/下一个/确认保存。                                                                            |
  | 原始字段   | 左侧显示“原始字段”、字段数、可拖动把手、字段路径、样例值；已映射字段显示居中的透明勾选。                                                                                                                            |
  | 统一记录   | 右侧标题附“拖入字段完成映射”，并按“问题”“期望输出”“Metadata”顺序显示目标区；辅助文案分别为“仅一个字段”“可选 · 仅一个字段”“可多个字段”，空目标显示“拖到这里”。“期望输出”沿用正式合同术语，替代原型早期的“预测输出”。 |
  | 映射状态   | 拖过目标区显示主色强调；已映射目标显示浅主色边框；chip 可重新拖动或用 x 移除；预览请求进行时禁止拖放和移除；现有解析问题、预览错误、队列顺序、重复提示、取消及一次确认保持原位置和语义。                            |
  | 明确排除   | 每字段下拉框、映射说明卡、字段类型/Schema/parser 设置、映射模板、键盘替代工作流、上传拖放、新路由和新 API。                                                                                                         |

- 2026-09-09：Project Owner 已授权实现；实现提交 `fd15cee`。上传相关公共路由均为 `reused`：待确认上传 `POST /pending-uploads`、真实预览 `PUT /pending-uploads/:id/preview`、批次确认 `POST /pending-upload-batches/confirm` 和取消 `DELETE /pending-upload-batches`；无路由收紧、退役或新增。
- 2026-09-09：必要验证通过：隔离 Vite 与官方 Playwright 容器中执行 `npm run test:e2e -- --output=/tmp/agentbench-ticket31-e2e --grep 'maps pending upload fields by drag'`（1/1），覆盖三个 Metadata、源字段拖入、chip 重新分配、移除、真实 preview 刷新与一次确认；`npm --prefix frontend-v3 run typecheck`、`npm --prefix frontend-v3 run lint`（仅 6 条既有 donor Fast Refresh warning）、`npx vite build --outDir /tmp/agentbench-ticket31-web-build --emptyOutDir`、`npm run docs:check` 和 `git diff --check` 均通过。未运行无关的全仓单元、集成、性能或持久化套件，因为本 Ticket 仅替换既有前端交互，未变更后端、parser、数据库或事务。已有 `project-workspace.spec.ts` 在进入上传前的侧栏“测试集”旧断言失败，和本 diff 无关，未将其作为通过证据或扩大本 Ticket 修复范围。
- 2026-09-09：固定 diff 的 Standards/Spec 双轴审查及 targeted recheck 无遗留 P0/P1；已补齐多个 Metadata 重分配边界、1180px 宽对话框、v5.3 映射文案和页面一致性记录。Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 32 仍须 Project Owner 单独授权，不能自动开始。
- 2026-09-09：Project Owner 已在独立 checkpoint `agentbench-ticket31-owner-checkpoint` 完成并通过浏览器验收。该环境当前运行修复提交 `dca96f9`，`/health` 与 `/health/ready` 均返回该 SHA，PostgreSQL、MinIO、Web 与 Worker 均健康。Ticket 31 至此关闭；Production Gate 仍为 `Not Evaluated / Not Approved`，不会自动启动 Ticket 32。
