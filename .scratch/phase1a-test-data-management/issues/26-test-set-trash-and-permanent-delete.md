# Phase 1A-26：测试集回收站、永久删除与墓碑

Status: ready-for-agent
Implementation: completed

Blocked by: none. [25](./25-readable-data-and-provenance-downloads.md) 已完成，Project Owner 已授权执行。

## Outcome

Owner 回收和恢复整个测试集、叶子版本或完整后续分支；可在回收站永久删除，也可删除中间版本内容并保留父子关系墓碑。

## Required reading

- [Implementation Spec](../spec.md)，Trash and Permanent Deletion
- [Architecture 5.9 and 8](../../../docs/architecture/phase1a-architecture.md#59-trash-and-permanent-delete)
- [ADR-0008](../../../docs/adr/0008-controlled-deletion-propagation.md)的 fail-closed/共享引用内部原则
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Acceptance Criteria

1. 整个测试集可移入回收站并恢复，内容、图、来源和下载不重写。
2. 叶子版本可单独回收；中间版本只能连同完整后续分支回收。
3. 回收/恢复不改父边、标签、分支号、发布顺序或来源。
4. 回收站默认不出现在正常列表，有明确入口和恢复动作。
5. 回收站中的测试集或版本分支可经再次确认永久删除，完成后不可恢复。
6. 中间版本可“删除内容、保留关系”；墓碑保留标签、父边、删除时间和后代关系，且不可浏览、下载或派生。
7. 后代始终指向原墓碑节点，不改挂祖先；版本标签永不复用。
8. 服务端内部保护共享内容、先阻断读取、幂等清理并在故障后重试，但不增加影响预览、理由、审批、外部副本或 Job 页面。
9. 回收/删除公共 API 只提供原型中的 Trash、restore、permanent delete 和 tombstone 动作；旧 archive/Controlled Deletion 治理路由退出公共注册，内部 fail-closed 模块继续复用。

## 冻结原型对齐门槛

实现前，在本 Ticket Comments 中写出并锁定本页对照表：可见字段、控件顺序、文案、启用/禁用状态、分页/弹窗、空/错误状态，以及明确属于后续 Ticket 的排除项。对照对象是 [`THROWAWAY-phase1a-solo-workflow-ui.html`](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html) 中版本关系、回收站、恢复、永久删除和“删除内容、保留关系”路径。

- 本 Ticket 必须逐项对齐：回收站入口与列表；恢复/永久删除确认弹窗；中间版本的整支回收与墓碑选择；版本关系中的灰色虚线墓碑节点、父子方向和来源路径高亮。
- 不增加理由、审批、治理记录、保留策略、影响预览、外部副本、Job 页面或其他原型外删除功能；它们不能以可点击占位、伪路由或隐藏宽接口出现。
- 关闭前必须在固定 HEAD 用可用浏览器逐项核对层级、所有可见控件、顺序、文案、状态与对话框，而不只核对 API、类型检查或构建。浏览器不可用时如实记为 unavailable，不得记为通过。
- Owner 必须检查该固定 HEAD 的 checkpoint 并在 Comments 记录接受结论；在此之前，Ticket 27 的依赖不得视为解除。

## Necessary tests

- 正常：回收/恢复测试集和叶子版本，再永久删除一个回收条目。
- 关键边界：中间节点单独回收被拒绝；整支回收和墓碑都保持父边；共享 blob 不误删；一个旧治理删除动作不再公开。
- 静态：直接相关 persistence/deletion 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

回收并恢复测试集和叶子版本；对中间版本分别核对“整支回收”和“删除内容、保留关系”；在回收站永久删除并确认不可恢复。

## Out of scope

独立 Controlled Deletion 工作流、理由/审批、历史改挂、标签复用、合并和保留策略。

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 27。

## Comments

- 本 Ticket 尚未获得执行授权。
- 2026-09-06：Project Owner 已明确授权执行。前端对齐表已锁定：测试集列表页头保留“回收站”和“新建测试集”；版本详情页的删除选项位于现有主操作右侧的省略菜单。叶子版本显示“删除此版本”，确认页只可“移入回收站”；中间版本显示“处理中间版本”，在同一确认页只可选择“删除内容，保留关系”或“删除此版本及 N 个后续版本”。回收站为对话框，按“整个测试集”和“版本分支 / 单个末端版本”显示名称、版本数、移入时间，以及“恢复”“永久删除”；空状态为“回收站为空”。版本图中的墓碑保持原标签和父子方向，以灰色虚线节点呈现，不能查看、下载或创建版本。明确排除：理由、审批、影响预览、外部副本、删除 Job 页、项目/数据集删除、历史改挂、标签复用和任何旧治理路由。
- 2026-09-06：实现完成，提交 `397a52d`。新增窄公共路径：测试集/版本分支回收、回收站查询与恢复、墓碑和永久删除；既有 `solo-test-sets` 查询/详情/下载/派生路径复用并按状态收紧；旧 `assets/:assetId/archive`、`test-sets/*/archive` 和 `deletions/*` 治理路径已退出公共注册，公开请求返回 `404 route_not_found`。验证通过：`npm run typecheck`、`npm --prefix frontend-v3 run typecheck`、`npm --prefix frontend-v3 run test`、`npm --prefix frontend-v3 run lint`（6 条既有 donor Fast Refresh 警告，无 error）、`npm --prefix frontend-v3 run build`、`npm run build`、`npm run docs:check`、`git diff --check`；隔离 Docker PostgreSQL/MinIO 的 `tests/integration/solo-test-set-trash.test.ts` 8/8 通过；固定 Playwright 容器的 `e2e/trash.spec.ts` 1/1 通过。Standards/Spec 审查及三项 P1 定向复审均已关闭。未运行无关的全仓库集成/E2E 套件，因本 Ticket 的迁移、删除与浏览器 seam 均已有针对性证据。Production Gate 仍为 Not Evaluated / Not Approved。Ticket 27 仍等待本 Ticket 固定 HEAD 的 Owner checkpoint 验收，不得自动启动。
- 2026-09-06：Owner checkpoint 发现“移入回收站”成功后等待已失效详情刷新，导致确认弹窗和跳转延后。`03b4602` 将列表失效保留在跳转前，移除对已回收详情的等待；墓碑同样先切换到后代版本再失效旧详情。固定 Playwright 容器 `e2e/trash.spec.ts` 2/2 通过，其中新增回归覆盖成功回收后详情 `404` 时弹窗立即关闭并回到测试集列表；`frontend-v3` typecheck/build 通过。
- 2026-09-06：Project Owner 已验收 Ticket 26 checkpoint（固定 HEAD `c89c292`）。Ticket 27 的依赖已解除；本记录不构成自动启动 Ticket 27 的授权。
