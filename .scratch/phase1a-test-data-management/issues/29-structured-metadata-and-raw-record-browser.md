# Phase 1A-29：结构化 Metadata 与原始记录浏览纠偏

Status: ready-for-agent
Implementation: completed

Blocked by: [28](./28-upload-queue-and-project-content-dedup.md)（已完成）。本 Ticket 仍须 Project Owner 单独明确授权。

## Outcome

让数据集上传后、单文件记录和数据集全部记录按冻结原型 v5.2 保留并阅读 Metadata 的字段和值边界；记录可由序号打开详情，单文件原始内容在当前页按受限只读预览查看。

## Required reading

- [Implementation Spec](../spec.md)，Metadata、Parsed View 和 Completion
- [PRD FR-03、FR-04](../../../docs/PRD-v2-test-data-management.md#fr-03-两步确认上传)
- [Architecture §§5.3–5.4](../../../docs/architecture/phase1a-architecture.md)
- [ADR-0010](../../../docs/adr/0010-structured-metadata-entries.md)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [冻结原型 v5.2](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [v5.2 记录浏览补充](../../../docs/prototypes/phase1a-solo-workflow-v5.2-record-browsing-amendment.md)
- [Test plan](../../../docs/test-plan-phase1a.md)

## Acceptance Criteria

1. 上传 mapping 中每个被选为 Metadata 的源字段分别保留其显示字段名和值；不得把多个字段拼接成单一文本。
2. 单文件和数据集“全部记录”列表显示稳定序号、问题、期望输出和最多前两项 Metadata；额外项显示“+N 项”。点序号打开同一记录的完整详情，详情按顺序显示所有键和值。
3. “紧凑 / 适中 / 展开”只改变上述记录表的当前浏览器会话行高；不写数据库、不加偏好 API，受影响下拉框沿用 `frontend-v1/` donor 风格。
4. 单文件“查看原始内容”留在当前页，最多取得并显示源文件开头 1,000,000 bytes 的只读文本。服务端在有效文本边界截断；源文件更大时 UI 明确提示预览被截断。不得把完整文件重新缓冲到浏览器。
5. 历史单文本 Metadata 保持原存储和历史不变；本 Ticket 的列表和详情可无损把它显示为唯一 `Metadata` 项。测试集 CSV 的同一表示由 Ticket 30 负责。
6. 相关公开读取仅返回当前原型所需的记录列表、详情和原始预览字段。实现前按 Architecture §5.0 清点调用方并将旧路由记录为 `reused`、`narrowed` 或 `retired`。
7. 不实现测试集编辑或版本记录筛选、任意 Metadata 查询、Schema、类型系统、JSON 编辑器、批量编辑、分页式原始文件管理或新的下载动作。

## Frozen prototype parity

| 页面 | 必须对齐 | 明确排除 |
| --- | --- | --- |
| 单文件 / 全部记录 | 序号进入详情、前两项 Metadata 与“+N 项”、完整键值详情、三档行高 | 右侧信息面板、动态列、保存行高 |
| 单文件原始内容 | 当前页只读查看、返回统一记录、超过预览边界的提示 | 编辑、完整文件缓冲、分页、额外下载 |

### 2026-09-09 corrective Dataset parity

| 页面 | 纠偏后的可见合同 | 本 Ticket 不扩展到 |
| --- | --- | --- |
| 数据集“全部记录” | 搜索和行高图标在同一工具栏；紧凑为单行截断、适中最多三行、展开最多六行；前两项 `字段：值` Metadata、额外项 `+N 项` 与完整弹层 | 测试集记录页、持久化行高偏好、任意 Metadata 筛选 |
| 单文件记录 | 与数据集“全部记录”使用相同行高和 Metadata 呈现；记录详情标题显示 `Metadata · N 项` | 新读取路由、修改 Mapping 或原始内容预览边界 |

## Necessary tests

- 正常：上传一份含至少三个 Metadata 源字段的合成文件，确认列表、详情和行高均保留字段和值。
- 关键边界：读取旧单文本 Metadata 不丢失；超过 1,000,000 bytes 的合成 UTF-8 文件只返回有效前缀和截断事实。
- 静态：受影响 HTTP / mapping 测试、`frontend-v3` typecheck/lint/build、`docs:check`；只在实际迁移或共享持久化变更时增加直接相关 PostgreSQL/MinIO 证据。

## Owner checkpoint

上传有三个 Metadata 字段的小文件，检查列表前两项及“+N 项”，点序号检查完整键值；切换三档行高；在单文件页打开大文件原始内容，确认它留在当前页且明确提示预览截断。

## Comments

- 2026-09-08：由 Project Owner 确认的 v5.2 最小决策创建。结构化 Metadata 和旧单文本兼容以 ADR-0010 为准；原始内容只读预览固定为最多 1,000,000 bytes，不引入完整文件浏览工作流。本记录不授权实现。
- 2026-09-08：Project Owner 已授权实现。实现提交 `09f9105`：上传预览、数据集记录列表和详情使用有序 `{ key, value }` Metadata；读取历史 mapping 时保持兼容，新写入 mapping 拒绝大小写不敏感的重复显示字段。`GET /collections/:collectionId/records` 为 `reused`，新增仅供序号详情使用的 `GET /collections/:collectionId/assets/:assetId/records/:ordinal`，`GET /assets/:assetId/download?view=raw` 为 `narrowed`，返回受限 JSON 预览并保留 `asset_raw_previewed` 审计。
- 2026-09-08：必要验证通过：专用临时 PostgreSQL/MinIO 容器上的 `npm exec vitest run tests/integration/material-browser.test.ts` 为 4/4；`npm run typecheck`、`npm --prefix frontend-v3 run typecheck`、`npm --prefix frontend-v3 run lint`（仅 6 条既有 donor 组件警告）、`npm run build`、`git diff --check` 均通过；临时 Playwright 容器中 `npx playwright test e2e/material-browser.spec.ts --output=/tmp/agentbench-ticket29-playwright-container --reporter=line` 为 1/1。Standards/Spec 双轴审查发现的 P1（上传预览旧文本、重复显示字段、原始预览审计）均已修复并由上述窄测试回归。未运行无关全仓测试套件。
- 2026-09-08：等待 Project Owner 在专用 checkpoint 验收后，Ticket 30 的依赖才解除；Production Gate 仍为 `Not Evaluated / Not Approved`。
- 2026-09-08：Owner checkpoint 当前 blocked。Docker 报告预定义地址池已耗尽，无法创建本 Ticket 必需的独立 edge/internal network；未复用、停止或清理其他项目资源。自建临时测试 PostgreSQL/MinIO 容器已停止并自动移除。待 Project Owner 释放或扩展 Docker 地址池后，才可按本 Ticket 固定 HEAD 创建隔离 checkpoint；Ticket 30 仍未解除。
- 2026-09-08：Project Owner 已批准删除两个无容器连接的历史 Gate 网络后，checkpoint 已就绪：Compose project `agentbench-ticket29-owner-checkpoint`，固定应用提交 `960c3ad`，Web 仅监听 `127.0.0.1:4209`；`/health` 与 `/health/ready` 均返回该 SHA，PostgreSQL 与 MinIO 均为 `ok`。等待 Owner 浏览器验收；Ticket 30 仍未开始。
- 2026-09-09：数据集记录页纠偏提交 `1c4c268`。既有读取路由均为 `reused`，未新增、收紧或退役 API；行高状态仅保存在根级浏览器内存，刷新恢复“紧凑”，不写数据库或偏好 API。实际验证通过：`npm --prefix frontend-v3 run typecheck`、受影响文件的 Prettier check、`git diff --check`、`npm exec vite build -- --outDir /tmp/agentbench-ticket29-density-final-dist --emptyOutDir`，以及隔离 Playwright 容器中的 `npm run test:e2e -- material-browser.spec.ts --output=/tmp/agentbench-ticket29-density-green-5`（1 passed）。Standards/Spec 审查的两个 P2（详情 Metadata 数量、单文件页行高 E2E）已修复并完成 targeted recheck，无 P0/P1。因本次没有后端、持久化或 API 变更，未重跑无关的广泛套件。checkpoint 已切换至 `1c4c268`：Web、Worker、PostgreSQL、MinIO 健康，`/health`、`/health/ready` 均返回该 SHA，未经认证的 `/api/session` 请求按预期返回 401。仍等待 Project Owner 浏览器验收；Ticket 30 仍未开始。
- 2026-09-09：Project Owner 已完成并通过 Ticket 29 浏览器验收。Ticket 29 的依赖已解除；Ticket 30 仍须 Project Owner 单独明确授权后才能开始。Production Gate 状态不变：`Not Evaluated / Not Approved`。
