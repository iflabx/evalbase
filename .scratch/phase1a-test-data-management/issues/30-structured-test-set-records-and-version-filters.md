# Phase 1A-30：结构化测试记录与版本固定筛选

Status: ready-for-agent
Implementation: completed

Blocked by: [29](./29-structured-metadata-and-raw-record-browser.md)（完成且经 Owner 验收后）。本 Ticket 仍须 Project Owner 单独明确授权。

## Outcome

让测试集 `v1` 和派生版本使用结构化 Metadata；按冻结原型 v5.2 浏览当前版本的记录详情、服务端分页搜索和固定筛选，并保持来源与 CSV 的可读一致性。

## Required reading

- [Implementation Spec](../spec.md)，Solo Test Set、Version Graph、Provenance 和 Completion
- [PRD FR-05、FR-06、FR-07](../../../docs/PRD-v2-test-data-management.md#fr-05-创建测试集-v1)
- [Architecture §§5.5–5.8](../../../docs/architecture/phase1a-architecture.md)
- [ADR-0010](../../../docs/adr/0010-structured-metadata-entries.md)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [冻结原型 v5.2](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [v5.2 记录浏览补充](../../../docs/prototypes/phase1a-solo-workflow-v5.2-record-browsing-amendment.md)
- [Test plan](../../../docs/test-plan-phase1a.md)

## Acceptance Criteria

1. 新建 `v1` 与从任一版本派生的编辑页把 Metadata 作为可增删的字段和值编辑；同一记录内字段名不区分大小写重复时阻止保存。旧单文本 Metadata 仍作为唯一 `Metadata` 项可读，不改写历史版本。
2. 选中版本的记录通过服务端任务型读取搜索、分页和按序号打开详情；不得为筛选而一次把最多 10,000 条记录加载到浏览器。
3. 固定筛选仅包含：一个或多个来源文件、问题已填写/未填写、原始资料/手工新增、指定或全部 Metadata 字段的值包含。不同条件以 AND 合并；多个选中来源文件在来源条件内以 OR 匹配。
4. 已应用筛选显示可单独移除的条件标签和“清除全部”；筛选和三档行高只保留当前浏览器会话，不写 URL、浏览器持久化或服务端。
5. 版本记录详情、来源与修改页和当前版本 CSV 下载都以相同有序“字段：值”表示 Metadata；历史和分支版本仍严格绑定当前选中 version ID。
6. 既有已验收版本图、来源摘要、下载、回收站和墓碑行为保持不变；实现前按 Architecture §5.0 清点调用方并将受影响路由记录为 `reused`、`narrowed` 或 `retired`。
7. 不实现任意或嵌套筛选、保存筛选、URL/session 恢复、动态列、Schema/类型系统、JSON 编辑器、批量 Metadata 编辑、记录归档/删除、版本合并或任何新服务/依赖。

## Frozen prototype parity

| 页面 | 必须对齐 | 明确排除 |
| --- | --- | --- |
| 创建 / 派生编辑 | Metadata 键值对话框、重复键错误、三列编辑 | JSON 表单、Schema、批量编辑 |
| 版本详情 | 当前版本摘要与版本关系在上；记录搜索、固定筛选、条件标签、分页、序号详情和三档行高 | 任意条件 builder、保存/分享筛选、动态列 |
| 来源 / 下载 | 结构化 Metadata 可读；当前选中版本下载数据 CSV 或数据加 provenance CSV | 新文件格式、ZIP、Langfuse 输出 |

### Ticket-local v5.2 parity record

| 区域 | 字段、控件与顺序 | 状态、空态与错误态 | 本 Ticket 明确不提供 |
| --- | --- | --- | --- |
| 创建 v1 / 派生编辑 | 三列表先显示问题、期望输出、Metadata；点“编辑 Metadata”后以字段名、值、删除和“添加字段”顺序编辑 | 字段名为空或大小写重复时停留在对话框并显示错误；旧文本显示为唯一 `Metadata` 项 | JSON/Schema 表单、批量 Metadata 编辑 |
| 版本记录 | 当前版本摘要、版本关系之后依次为搜索、筛选、行高、匹配数量、已应用条件、记录表、分页；表列为序号、问题、期望输出、Metadata | 筛选仅在点“应用筛选”后生效；无结果显示“没有匹配的记录”；序号可打开详情；行高只在当前会话生效 | 动态列、任意条件 builder、保存/分享筛选、URL 或持久化恢复 |
| 筛选 | 来源文件多选、问题、记录来源、Metadata 字段、Metadata 值包含，然后取消、清除、应用 | 来源文件在同一条件内为 OR，其余条件为 AND；已应用条件可单独移除或清除全部；切换版本重置条件，不能留下隐藏筛选 | 嵌套条件、Schema/类型筛选 |
| 记录详情 / 下载 / 来源 | 点序号按需读取完整问题、期望输出、`Metadata · N 项` 键值和来源；CSV 与来源页均按有序“字段：值”显示 Metadata | 详情读取失败显示错误；当前选中版本继续决定详情、来源和下载 | 新格式、ZIP、Langfuse 导出、记录归档/删除 |

## Necessary tests

- 正常：从真实来源创建或派生版本，添加多个 Metadata 项，筛选一组来源文件并打开结果详情。
- 关键边界：同一记录内大小写不同的重复 Metadata 字段名被拒绝；两个不同筛选维度不同时匹配的记录不返回。
- 静态：受影响版本 API / editor / CSV 测试、`frontend-v3` typecheck/lint/build、`docs:check`；只在实际迁移或共享 CSV 持久化变更时增加直接相关 PostgreSQL/MinIO 证据。

## Owner checkpoint

从已有版本派生，编辑多个 Metadata 字段和值并创建新版本；在版本详情使用来源文件、问题状态、记录来源和 Metadata 包含筛选，移除一个条件后确认结果变化；打开序号详情并分别下载当前选中版本的数据 CSV 与数据加 provenance CSV。

## Comments

- 2026-09-08：由 Project Owner 确认的 v5.2 最小决策创建。固定筛选只采用冻结原型实际可见条件及明确的 AND/OR 语义；Langfuse Filters 调研仅为交互证据，不复制其代码、查询架构或持久化策略。本记录不授权实现。
- 2026-09-09：Project Owner 已授权实现。实现提交 `22b8d2e`：新写入以有序键值 Metadata 保存并拒绝大小写重复键或旧文本写入；旧文本仅在读取、来源和 CSV 导出时显示为唯一 `Metadata` 项。`GET .../versions/:versionId` 为 `narrowed`，不再返回整版记录；`GET .../records` 为 `narrowed` 的 SQL 筛选/计数/分页浏览读取，仅返回当前页可见字段；新增薄任务读取 `GET .../records/:ordinal` 供详情按需读取，以及仅在“创建新版本”打开后分页使用的 `GET .../editing-records`。后者只携带当前父版本范围内的 `parentOrdinal`，不暴露 revision ID；无路由退役。
- 2026-09-09：必要验证通过：`npm test`（18 files、131 tests）、专用临时 Node 24 容器中的 `npm exec vitest run tests/integration/solo-test-set-v1.test.ts`（4/4，连接隔离 PostgreSQL/MinIO）、`npm run typecheck`、`npm --prefix frontend-v3 run typecheck`、`npm --prefix frontend-v3 run lint`（仅 6 条既有 donor Fast Refresh 警告）、`npm --prefix frontend-v3 exec vite build -- --outDir /tmp/agentbench-ticket30-final-dist --emptyOutDir`、三项隔离 Playwright 检查（筛选/序号详情、版本图、来源页）及 `git diff --check`。常规 `npm --prefix frontend-v3 run build` 未作为通过证据：历史临时容器留下的忽略 `dist/` 权限阻止清空，未修改该历史产物，改用隔离 `/tmp` 输出构建。未运行无关全量集成或性能套件。
- 2026-09-09：固定 diff 的 Standards/Spec 双轴审查及 targeted recheck 无 P0/P1。已修复的 P1 包含：筛选前整版内存读取、普通浏览返回编辑内部字段、缺少独立序号详情、跨版本隐藏筛选、旧文本新写入，以及内部 revision ID 经编辑 API 暴露。Production Gate 仍为 `Not Evaluated / Not Approved`；等待独立 Ticket 30 Owner checkpoint 与 Project Owner 浏览器验收，不能自动开始后续工作。
- 2026-09-09：Project Owner 确认的原型纠偏提交 `86b2fe7`：版本详情在版本关系图前以冻结结构显示当前版本摘要，并随选中版本更新；文件行的“移动”和其弹窗对齐冻结原型。`GET .../versions/:versionId` 仍为 `narrowed`，仅补充摘要 DTO；文件移动路由为 `reused`，无新增/退休公共路由。`npm test`（18 files、131 tests）、根与 `frontend-v3` typecheck、前端 lint（仅 6 条 donor 既有 warning）、隔离前端构建、`git diff --check`，以及固定 Playwright 容器中的 `version-graph.spec.ts` 和 `material-browser.spec.ts` 均通过；固定 diff Standards/Spec 审查无 P0/P1。后续集成重跑被服务器可用磁盘约 2.4 GB 阻塞：MinIO 对两字节对象返回 `XMinioStorageFull`，故未把该次重跑或新的 Owner checkpoint 写为通过。未停止、删除或复用任何既有项目资源；临时 `agentbench-ticket30-summary-test` 容器、network、volume 和镜像均已移除。等待 Project Owner 批准服务器资源清理后，才可将 checkpoint 切换到此固定提交并进行浏览器验收。
- 2026-09-09：Project Owner 已在独立 checkpoint `agentbench-ticket30-owner-checkpoint` 完成并通过浏览器验收。该环境运行固定提交 `2858801`，`/health` 与 `/health/ready` 均返回该 SHA，PostgreSQL、MinIO、Web 与 Worker 均健康。Ticket 30 至此关闭；Production Gate 仍为 `Not Evaluated / Not Approved`，不会自动启动任何后续工作。
