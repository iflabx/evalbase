# Phase 1A-21：两步多文件上传、映射与确认

Status: ready-for-agent
Implementation: completed

Blocked by: [20](./20-project-workspace-and-frontend-v3-dataset-index.md). 仍需 Project Owner 明确授权。

## Outcome

Owner 在当前项目中选择一个或多个 CSV、JSON、JSONL，选择目标数据集，逐文件核对字段映射和真实预览，最后统一确认保存。

## Required reading

- [Implementation Spec](../spec.md)，Confirmed Upload
- [ADR-0009](../../../docs/adr/0009-confirmed-upload-visibility-boundary.md)
- [Architecture 5.3](../../../docs/architecture/phase1a-architecture.md#53-confirmed-upload)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Vertical slice

| Layer  | Deliverable                                                           |
| ------ | --------------------------------------------------------------------- |
| Domain | Pending Upload start/preview/batch-confirm/cancel/expiry              |
| Reuse  | 既有流式接收、容量、hash、MinIO staging、parser、Source Record 和幂等 |
| UI     | `frontend-v3` 的“选择文件 → 字段映射与预览”两步弹窗                   |

## Acceptance Criteria

1. 一次选择多个支持文件，并选择当前项目的目标数据集；首页默认“未整理”，数据集详情默认当前数据集。
2. 文件逐个自动解析；映射表只显示原始字段、样例值和问题/期望输出/Metadata/不导入。
3. 问题和期望输出各最多一个源字段，Metadata 可接多个字段；预览即时显示真实记录。
4. 页面显示记录数和可定位解析问题，但不提供编码、delimiter、header、JSON path、类型或坏行排除工作台。
5. 完成全部文件映射后一次确认保存；关闭弹窗取消未保存批次。
6. 确认前不创建可见资产；取消、失败或过期不留下可见半成品。
7. 单文件精确 50,000,000-byte 上限保持；接收不得重新缓冲完整文件。
8. 批次确认原子且幂等；响应丢失重试不重复创建。
9. UI 不要求责任人、用途、许可、敏感级别、版本说明或内部 ID。
10. 上传公共 API 复用既有流式/parser/存储模块，但请求、响应和动作只覆盖两步批次流程；旧治理字段、高级 parser 参数和逐文件确认动作被移除或不再公开。

## Necessary tests

- 正常：一个 CSV 和一个 JSON 经过两步映射预览后同时出现在目标数据集。
- 关键边界：取消或 50,000,001-byte 文件不产生可见资产；一个旧治理/parser 参数不再被公共合同接受。
- 静态：直接相关上传/API/parser 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

选择两个不同格式文件，调整字段映射、核对真实预览并确认；列表只出现已确认文件，整个弹窗只有两步且没有高级 parser 或治理字段。

## Out of scope

上传阶段原始内容切换、逐文件取消、文件浏览、移动、测试集、提高容量和新增格式。

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 22。

## Comments

- 2026-09-04：Project Owner 授权后以 `8a65284` 完成最小纵向闭环。`frontend-v3` 提供“选择多个文件 → 逐文件字段映射和真实预览 → 一次确认保存”弹窗；不会请求责任人、用途、许可、敏感级别、版本说明或内部 ID。关闭或中途失败会取消未确认批次；传输/预览进行中不可关闭，避免留下未跟踪 pending 上传。
- 路由：`reused` 为既有流式 `ArtifactRepository`、50,000,000-byte 上限、哈希/immutable MinIO 对象、parser、Source Record 与 PostgreSQL 事务；`narrowed` 为仅覆盖 pending start/preview/cancel/batch-confirm 的公共请求和响应；`retired` 为正式单人运行时的 `POST /api/projects/:projectId/assets`（仅显式测试身份模式保留历史路由）。确认采用稳定批次幂等键、事务内 advisory lock，并记录 Owner 已确认的非生产允许输入这一环境级内部来源事实，不伪造单文件来源分类。
- 验证：Node 24 临时容器在现有隔离测试 PostgreSQL/MinIO 上执行 `vitest run tests/integration/project-workspace.test.ts tests/integration/confirmed-upload.test.ts`，6/6 通过；覆盖 CSV+JSON 两步确认、确认前不可见、取消、确认重试、旧入口/治理字段拒绝、精确 50,000,001-byte `413` 和既有项目/数据集回归。根目录 `npm run typecheck` 及变更文件 ESLint 通过；`frontend-v3` typecheck、变更文件 ESLint 与 build 通过；`git diff --check` 通过。根目录全量 lint 未作为证据，因为其扫描历史 `frontend-v2/dist` 的既有生成文件会产生无关错误；浏览器 E2E 未运行，因为宿主缺少 Chromium 的 `libatk-1.0.so.0`，未安装系统依赖。
- Code Review：以 `f8d891f` 为基线完成 Standards/Spec 双轴审查；所有发现的 P1（写入能力复检、pending 清理、默认目标、稳定幂等键、定位解析问题、环境级来源事实和精确容量边界）均已定向回归，最终 P0=0、P1=0。
- Gate：Non-production Server Development Gate 保持 `Passed`；Production Gate 仍为 `Not Evaluated / Not Approved`。Ticket 22 仍须 Project Owner 单独授权，不会自动开始。
