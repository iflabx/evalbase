# Phase 1A-25：版本来源、修改详情与两个 CSV 下载

Status: ready-for-agent
Implementation: completed

Blocked by: [24](./24-branch-version-derivation-and-graph.md)（已解除）。

## Outcome

Owner 查看当前版本如何形成、逐条来源与修改，并下载该版本数据 CSV，或连续下载数据 CSV 与 provenance CSV。

## Required reading

- [Implementation Spec](../spec.md)，Provenance and Change Facts / CSV Download
- [Architecture 5.7–5.8](../../../docs/architecture/phase1a-architecture.md#57-provenance)
- [ADR-0005](../../../docs/adr/0005-deterministic-artifacts-and-offline-validation.md)的 CSV/hash 内部原则
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Acceptance Criteria

1. 顶部显示直接父版本、当前版本、未改变/修改/新增/移除计数和本次新加入资料。
2. 新加入文件的字段映射默认收起，按需展开。
3. 逐条表默认“本次有变化”，可切换全部、未改变、已修改、新增、已移除，并支持搜索和分页。
4. 记录详情显示当前内容、修改前或移除前内容、来源文件/记录和变化字段；手工新增不伪造文件来源。
5. “下载 CSV”下载所选 version ID 的数据 CSV。
6. “下载数据与溯源”下载同一 version ID 的数据 CSV 和 provenance CSV 两个独立文件，不生成 ZIP。
7. 两个 CSV 正确处理 Unicode、逗号、引号、换行和公式前缀；历史版本不会偷换 latest。
8. 不提供 Standard/Full Package、Offline Validator、Delivery Record、Langfuse CSV、处理运行或多跳关系图。
9. 来源/下载公共 API 只返回原型摘要、记录详情和两份 CSV；复用既有 lineage/CSV 安全模块，同时让 Package/Delivery/Validator/Langfuse 和多跳技术接口退出公共注册。

## 冻结原型对齐门槛

实现前，在本 Ticket Comments 中写出并锁定本页对照表：可见字段、控件顺序、文案、启用/禁用状态、分页/弹窗、空/错误状态，以及明确属于后续 Ticket 的排除项。对照对象是 [`THROWAWAY-phase1a-solo-workflow-ui.html`](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html) 中当前版本摘要、记录浏览/详情、来源与下载路径。

- 本 Ticket 必须逐项对齐：当前版本摘要位于版本关系之后的页面顺序；变更筛选、搜索、分页；记录详情弹窗中的当前值、前值和来源；“下载 CSV”及“下载数据与溯源”两个独立 CSV 动作。
- 不在此页面添加 Package、ZIP、CLI、Langfuse、删除操作或多跳技术关系图；它们不能以可点击占位、伪路由或隐藏宽接口出现。
- 关闭前必须在固定 HEAD 用可用浏览器逐项核对层级、所有可见控件、顺序、文案、状态与对话框，而不只核对 API、类型检查或构建。浏览器不可用时如实记为 unavailable，不得记为通过。
- Owner 必须检查该固定 HEAD 的 checkpoint 并在 Comments 记录接受结论；在此之前，Ticket 26 的依赖不得视为解除。

## Necessary tests

- 正常：对两个历史/分支版本分别查看变化并下载核对两份 CSV。
- 关键边界：恶意 CSV 单元格安全转义，不存在/跨项目 version ID 不返回其他版本；一个旧 Package/Delivery 动作不再公开。
- 静态：provenance/CSV/API 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

打开一个分支版本，筛选各类变化并查看前值/来源；分别执行两个下载动作，确认得到当前版本的数据 CSV 和 provenance CSV，没有 ZIP 或其他交付页面。

## Out of scope

修改来源、Package/CLI、Langfuse、报告、回收站和永久删除。

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 26。

## Comments

- 2026-09-05：Project Owner 已明确授权执行。
- 实现前原型对照表：

  | 项目     | 本 Ticket 固定交付                                                                                                | 不在本 Ticket 交付                                        |
  | -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
  | 可见字段 | 父版本、当前版本、四类变更计数、本次新加入资料及折叠字段映射                                                      | 多跳技术血缘、处理运行和内部 ID                           |
  | 控件顺序 | 当前版本摘要 → 变更筛选/搜索 → 记录表/分页 → 记录详情；版本页操作包含查看来源与修改、下载 CSV、下载数据与溯源     | Package、ZIP、CLI、Langfuse 与删除操作                    |
  | 状态     | 默认“本次有变化”；可切换全部、未改变、已修改、新增、已移除；详情能显示前值或移除前值；无匹配/请求失败给出恢复提示 | 回收站、墓碑和永久删除状态（Ticket 26）                   |
  | 下载     | 显式当前 version ID 的数据 CSV；连续下载同一 version ID 的数据 CSV 与 provenance CSV                              | Standard/Full Package、Offline Validator、Delivery Record |

- 路由处置：`reused` 既有单人项目/版本深模块；`narrowed` 为来源、记录详情和两个 CSV 增加最薄的 `solo-test-sets` 公开接口；`retired` 已将 Package、Delivery、Langfuse CSV、Offline Validator、处理运行和多跳 lineage 历史公开入口转入内部退役前缀或移出 npm 脚本，公开 HTTP 访问固定返回 `route_not_found`。
- 实现提交：`159e22a`。来源页显示直接父版本、四类变化、新加入资料/折叠映射、筛选、搜索、10 条分页和逐条前值/来源详情；两个 CSV 始终绑定显式 version ID。
- 已验证：`docker compose --project-name agentbench-ticket25-test -f compose.yaml -f .scratch/phase1a-test-data-management/ticket25-test-compose.yaml run --rm test npx vitest run tests/integration/solo-test-set-v1.test.ts`（3/3）；`npm test`（18 files / 131 tests）；`npm --prefix frontend-v3 test`（1/1）；根与 `frontend-v3` typecheck；`frontend-v3` lint（0 errors、6 条 donor 既有 warning）；临时输出目录的 `frontend-v3` build；`npm run docs:check` 与 `git diff --check`。
- Standards / Spec 双轴审查及 P0/P1 定向复核完成，无未关闭 P0/P1。`npm run lint` 未作为通过证据：它扫描已忽略的旧 `frontend-v2/dist/` 与 `frontend-v3/dist/`，产生非本 Ticket 的历史产物错误。
- 浏览器语义测试 `frontend-v3/e2e/provenance.spec.ts` 已新增，但实际启动 Chromium 被宿主缺少 `libatk-1.0.so.0` 阻断，未执行断言，未记为通过。等待 Owner checkpoint 验收；不自动开始 Ticket 26。Production Gate 仍为 `Not Evaluated / Not Approved`。
- 2026-09-06：Project Owner 拒绝初版来源页的视觉与交互验收：详情页的摘要/关系图顺序、顶部动作区和“来源与修改”独立页面均未对齐冻结原型。Ticket 25 重新打开为 `in-progress`；`159e22a` 仅保留为被替代的初版实现证据，Ticket 26 继续阻塞。
- 2026-09-06：修订实现提交 `58a7ebc`。详情页恢复为“当前版本摘要 → 版本关系 → 当前记录”，操作区移至页头；“来源与修改”改为独立页面并复用 donor `PageHeader`；来源表格、空筛选状态、父版本跳转、详情上下文与原始资料入口均对齐冻结原型。隔离 Compose 集成 `3/3`、根单元测试 `131/131`、前端单元测试、前后端 typecheck、前端 lint（仅 donor 既有 warning）、隔离构建、文档校验及 Standards/Spec 双轴定向复核通过。宿主 Chromium 仍缺 `libatk-1.0.so.0`，自动浏览器断言未运行。
- 2026-09-06：Project Owner 已在固定 checkpoint `58a7ebc` 完成人工浏览器验收并确认通过。Ticket 25 关闭；Ticket 26 的依赖已解除，但不会自动开始。Production Gate 仍为 `Not Evaluated / Not Approved`。
