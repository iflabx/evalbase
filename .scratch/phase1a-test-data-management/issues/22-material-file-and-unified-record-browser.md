# Phase 1A-22：数据集文件与统一记录浏览

Status: ready-for-agent
Implementation: completed

Blocked by: [21](./21-confirmed-multi-file-upload.md). 仍需 Project Owner 明确授权。

## Outcome

Owner 在数据集详情的“文件 / 全部记录”间切换，按冻结原型浏览真实内容、移动文件，并从“查看”进入单文件统一记录和原始内容。

## Required reading

- [Implementation Spec](../spec.md)，Material Browser
- [Architecture 5.2 and 5.4](../../../docs/architecture/phase1a-architecture.md#52-raw-material-collection)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Acceptance Criteria

1. 文件页显示名称、格式、大小、记录数、上传时间、状态、移动和查看，只提供文件名搜索及分页。
2. 单击文件行只改变选中样式；页面没有右侧信息面板；点击“查看”才进入文件记录。
3. 文件可移至当前项目另一数据集；移动不改变 ID、字节、hash、映射、来源或 locator。
4. 单文件页按问题、期望输出、Metadata 搜索和分页，并可查看只读原始内容。
5. 全部记录页跨文件显示来源文件、问题、期望输出和 Metadata；分页稳定。
6. 不加入格式/状态筛选、全文搜索、Join、自动去重或记录身份合并。
7. 文件/记录公共 API 只返回本页列、搜索、分页、移动和原始内容所需字段；旧治理筛选、任意查询和右侧信息 DTO 原位收紧或退出公共注册。

## Necessary tests

- 正常：CSV/JSON 文件页和全部记录显示真实内容，移动后在目标数据集可见。
- 关键边界：移动保持 asset identity、mapping 和 locator，跨项目目标被拒绝；旧治理筛选不再是公共参数。
- 静态：直接相关 query/API 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

打开一个数据集，切换文件/全部记录，确认没有右侧信息面板；移动一个文件，点“查看”浏览统一记录并打开原始内容。

## Frozen v5 parity

| Aspect                | Ticket 22 result                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible fields        | 文件：名称、格式、大小、记录数、上传时间、状态、移动、查看；全部记录：来源文件、问题、期望输出、Metadata；单文件页显示文件名、格式和记录数。 |
| Control order         | 数据集名与“返回数据集 / 上传文件”在页头；文件 / 全部记录标签及数量在前，搜索在后；行内仅移动、查看。                                         |
| States and pagination | 文件行仅高亮；稳定上一页/下一页；移动仅可选当前项目其他数据集；加载、空和错误使用 donor 既有状态组件。                                       |
| Dialog and raw view   | 复用既有确认上传弹窗；移动弹窗只选择目标数据集；原始内容只读并显式 `view=raw` 打开。                                                         |
| Exclusions            | 无右侧信息面板、格式/状态筛选、全文搜索、Join、去重、记录合并、原始文件修改或任何测试集编辑能力。                                            |

## Out of scope

测试集选择/编辑、格式/状态筛选、嵌套目录和修改原始文件。

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 23。

## Comments

- Project Owner 已明确授权执行 Ticket 22；基线为 `f12fe0e`，初始实现提交为 `5457d35`，最终合同修复提交为 `5ff5f72`。
- 路由处置：复用 `GET /api/projects/:projectId/collections`、确认上传和项目内移动深层能力；新增窄 DTO `GET /api/projects/:projectId/collections/:collectionId/assets/:assetId`；退休旧治理列表 `GET /api/projects/:projectId/assets`、宽记录 `GET /api/projects/:projectId/assets/:assetId/records` 和治理详情 `GET /api/projects/:projectId/assets/:assetId`；原始内容只接受显式 `?view=raw`。
- 必要验证：Docker PostgreSQL/MinIO 的 `npm exec vitest run tests/integration/material-browser.test.ts` 为 `4/4`；Docker Playwright 的 `npm run test:e2e -- e2e/material-browser.spec.ts` 为 `1/1`，覆盖文件名/三字段搜索、稳定翻页、移动、原始内容和无右侧信息面板；`npm run test` 为 `18 files / 131 tests`；根目录与 `frontend-v3` typecheck、`frontend-v3` lint、build 通过。lint 仅保留 6 条未改 donor Fast Refresh warning。
- 固定 `5ff5f72` 的 Standards/Spec 复查无 P0/P1；`npx prettier --check src/server/app.ts .scratch/phase1a-test-data-management/issues/22-material-file-and-unified-record-browser.md`、`git diff --check` 与 `npm run docs:check` 通过。未重跑与本 Ticket 无关的历史广域集成套件，因为它此前包含历史失败，不能作为本 Ticket 证据。
- Project Owner 已通过浏览器 checkpoint；Ticket 23 的依赖已解除，但仍须 Project Owner 单独明确授权才可执行。生产 Gate 仍为 `Not Evaluated / Not Approved`。
