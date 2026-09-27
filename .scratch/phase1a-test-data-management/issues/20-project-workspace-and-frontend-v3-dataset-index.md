# Phase 1A-20：项目工作区、`frontend-v3` 与数据集首页

Status: ready-for-agent
Implementation: completed

Blocked by: [19](./19-raw-material-collections.md) 已完成。仍需 Project Owner 明确授权。

## Outcome

Owner 打开新正式前端预览后直接看到项目列表，可以新建、打开和切换项目；进入项目后，侧栏显示项目名称，数据集和测试集成为子项。数据集首页完整呈现冻结原型的列表、筛选、排序、分页和创建行为。

本 Ticket 从 `frontend-v1/` 重新建立 `frontend-v3/`，不继承已废弃 `frontend-v2/` 的页面或业务。

## Required reading

- [Implementation Spec](../spec.md)，Project Workspace / Raw Material Collection
- [PRD](../../../docs/PRD-v2-test-data-management.md)
- [Architecture 3 and 5.1–5.2](../../../docs/architecture/phase1a-architecture.md#3-前端基线)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [Frozen prototype record](../../../docs/prototypes/solo-workflow-reference-adaptations.md)
- [v5 delta audit](../../../docs/reviews/phase1a-frozen-prototype-v5-contract-ticket-delta-audit.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Vertical slice

| Layer       | Deliverable                                                         |
| ----------- | ------------------------------------------------------------------- |
| Source      | 固定 HEAD 完整复制 `frontend-v1/` 到 `frontend-v3/`；donor 保持不变 |
| Public seam | 项目 list/create/open 与项目级数据集 list/create                    |
| UI          | 项目首页、项目切换器、项目内子导航和冻结原型数据集首页              |
| Retirement  | `frontend-v2/` 保留历史但不进入本 Ticket 的开发、预览或构建         |

## Acceptance Criteria

1. `frontend-v1/` 被完整复制为 `frontend-v3/`；保留 donor 字体、token、布局和所需组件，且 `git diff -- frontend-v1` 为空。
2. 打开预览直接进入项目列表，无登录、凭据、用户选择、成员或角色页面。
3. 项目列表显示名称、数据集数、测试集数、最近更新和“查看”，支持搜索、10 条分页、新建和打开。
4. 新建项目只填写名称和可选说明，并在同一事务得到唯一固定“未整理”数据集。
5. 进入项目后侧栏显示当前项目名称；数据集和测试集为子项；项目切换器可切换或新建项目。
6. 项目不提供重命名、删除、设置、成员或跨项目引用；跨项目 ID 不泄漏存在性。
7. 数据集首页显示名称、类型、文件数、统一记录数、状态、最近更新和“查看”，支持搜索、类型/内容筛选、更新时间排序和10条分页。
8. 普通数据集只可用名称和可选说明新建；数据集首页没有重命名、删除或右侧信息面板。
9. `frontend-v3/` 使用真实项目/数据集 API，不包含冻结原型 Mock 或浏览器内持久化；`frontend-v2/` 不参与预览。
10. 项目/数据集公共 API 只接受并返回 AC-3–AC-8 所需合同；旧 rename/delete/member/settings 和宽 DTO 路由原位收紧或退出公共注册，不由前端隐藏代替。

## Necessary tests

- 正常：新建项目、看到“未整理”、新建数据集、切换项目并返回，刷新后数据仍存在。
- 关键边界：跨项目对象 ID 被拒绝；一个原型外项目/数据集动作不再有公共路由，响应没有旧治理字段。
- 静态：相关 HTTP/迁移测试，`frontend-v3` typecheck、lint/build，`frontend-v1` 无 diff，docs check。

## Owner checkpoint

Owner 从预览地址新建并打开一个项目，在数据集首页使用搜索、两项筛选、排序和分页，新建一个数据集，再切换到另一个项目；确认没有登录、重命名、删除或右侧信息面板。

## Out of scope

上传、文件浏览/移动、测试集创建、版本、下载、回收站、正式部署切换，以及冻结原型没有的任何项目或数据集管理动作。

## Definition of Done

- AC 和必要测试通过，P0/P1 Standards/Spec 问题关闭。
- Ticket Comments 与进度表记录 commit、验证和 Owner checkpoint。
- 本地提交后停止，不自动开始 Ticket 21。

## Comments

- 2026-09-03：由冻结原型 v5 差异审计新增，取代在旧 `frontend-v2/` 上继续修补项目/数据集首页的方案。
- 2026-09-04：实现提交 `1bd1ecf`。`frontend-v3/` 由 `frontend-v1/` 完整复制后连接项目/数据集窄 API；项目与数据集列表按服务端搜索、筛选、排序和 10 条分页；新项目原子创建固定“未整理”数据集。`frontend-v1/` 无改动，`frontend-v2/` 未参与构建。
- 路由处置：新增 `GET/POST /api/projects`、`GET /api/projects/:projectId`；收紧 `GET/POST /api/projects/:projectId/collections`；退休集合 rename/delete/detail、项目成员和 Audit 路由。后续上传、作业、版本和导出 seam 由 Tickets 21–26 各自收紧，未在本 Ticket 扩大处理。
- 验证：隔离 EvalBase 验证库执行 `tests/integration/project-workspace.test.ts tests/integration/collections.test.ts`，4/4 通过；`tests/unit/migrate.test.ts`，3/3 通过；`frontend-v3` 的 unit test、typecheck、lint（仅 6 条 donor Fast Refresh 警告）和 build 通过；`npm run docs:check` 见进度记录提交。
- 审查：Standards 及 Spec P0/P1 已针对固定实现复核。浏览器路径测试已加入，但本机 Playwright 因缺少 `libatk-1.0.so.0` 无法启动 Chromium；未安装系统依赖。Project Owner 浏览器 checkpoint 尚未执行，不宣称人工验收通过。
