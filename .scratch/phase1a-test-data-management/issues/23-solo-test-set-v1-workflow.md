# Phase 1A-23：选择记录、表格编辑并创建测试集 `v1`

Status: ready-for-agent
Implementation: completed

Blocked by: [22](./22-material-file-and-unified-record-browser.md). 仍需 Project Owner 明确授权。

## Outcome

Owner 从当前项目的数据集、文件和真实记录中选择内容，在固定三列表格增删改，创建不可变 `v1`。

## Required reading

- [Implementation Spec](../spec.md)，Solo Test Set Editor
- [Architecture 5.5](../../../docs/architecture/phase1a-architecture.md#55-solo-test-set-editor)
- [ADR-0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Acceptance Criteria

1. 新建只填写测试集名称和可选用途，不填写版本说明、逐行原因、Schema 或默认选择。
2. 选择按数据集 → 文件 → 真实记录展示，支持一个或多个来源。
3. 编辑表固定为问题、期望输出、Metadata，可新增、修改和删除行。
4. Metadata 是普通文本输入，由服务端安全编码；UI 不要求 JSON/Schema 语法步骤。
5. 问题未填写、完全重复和来源已记录仅显示数据核对提示，不阻止创建。
6. 成功原子创建不可变 `v1`；重新打开顺序与内容一致。
7. 5 资产、100,000,000 原始 bytes、10,000 源记录/正式记录和 100,000,000 规范化 bytes 边界保持。
8. 失败保留可恢复编辑；重试不重复发布或消耗标签。
9. 测试集编辑/发布公共 API 只暴露名称、可选用途、来源选择、三列编辑、数据核对和创建；Draft/lease/Recipe/Schema/Candidate 等宽接口仅在内部复用并退出公共注册。

## Necessary tests

- 正常：从两个文件选择部分记录，增删改后创建并重新打开 `v1`。
- 关键边界：容量超限不发布且保留编辑；提示性数据核对不阻断；公共响应不泄漏内部工作流对象。
- 静态：直接相关 editor/publication 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

填写名称和可选用途；勾选两个文件的记录，编辑一行、添加一行、删除另一行并确认对应来源勾选取消；创建并重新打开 `v1`。确认三列可编辑、数据核对只提示，且页面没有版本说明、Schema 或内部对象。

## Frozen v5 parity

| Aspect | Ticket 23 result |
| --- | --- |
| Visible fields | 测试集列表显示名称、当前版本、记录数、来源、状态、更新时间和查看；创建仅有名称、可选用途、来源记录和三列。 |
| Control order | 列表页头“新建测试集”后为搜索和列表；创建弹窗按名称/用途、选择记录、编辑记录、数据核对、创建 `v1` 排列。 |
| States | 复用 donor 的加载、空和错误状态；来源读取错误可重试；数据核对为非阻断提示。 |
| Exclusions | 无登录、Schema、Recipe、Draft、lease、Candidate、版本图、派生、下载、来源下载或回收站。 |

## Out of scope

历史版本派生、版本图、来源下载、回收站及高级策展控件。

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 24。

## Comments

- Project Owner 已明确授权执行；基线为 `4e1ef90`，实现提交为 `95c09b3`。
- 路由处置：新增窄 `GET /solo-test-set-sources`、`GET/POST /solo-test-sets` 和 `GET /solo-test-sets/:id`；历史 drafts、candidates、test-sets 工作台路由已退休，原 URL 和内部退休别名均返回 `404`。
- 必要验证：隔离 Docker PostgreSQL/MinIO 中的 `npm exec vitest run tests/integration/solo-test-set-v1.test.ts` 为 `2/2`，覆盖两文件真实来源、编辑/新增、警告不阻断、幂等重试、重开、空/超容量拒绝与退休路由；根目录 typecheck/build、frontend-v3 typecheck/lint/build 通过。lint 仅保留 6 条未改 donor Fast Refresh warning。
- Standards/Spec review 的 P0/P1 已修复并 Targeted Recheck；宿主 Chromium 缺少 `libatk-1.0.so.0`，未伪造浏览器自动化结果。Owner checkpoint 待验收，验收前不启动 Ticket 24。生产 Gate 仍为 `Not Evaluated / Not Approved`。
- 2026-09-05: Project Owner 已在固定提交 `709f95a` 的 Ticket 23 checkpoint 验收通过；该提交仅将“新建测试集”三步弹窗的资料/记录/编辑来源分组与冻结 v5 原型对齐，未改变 API 或创建行为。Ticket 24 的依赖已解除，但仍须 Project Owner 单独明确授权。Production Gate 仍为 `Not Evaluated / Not Approved`。
