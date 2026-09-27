# Phase 1A-32：v5.3 测试集回收与精确删除确认对齐

Status: ready-for-agent
Implementation: completed

Blocked by: [30](./30-structured-test-set-records-and-version-filters.md)（已完成并经 Owner 验收）。本 Ticket 仍须 Project Owner 单独明确授权。

## Outcome

让测试集回收、恢复、永久删除与中间版本墓碑逐项对齐冻结原型 v5.3：整套测试集只从列表回收，回收站分组，破坏性动作必须输入对象的精确名称或版本号，并修复整套测试集吸收/恢复已回收版本分支的持久化语义。

## Required reading

- [Implementation Spec](../spec.md)，Trash and Permanent Deletion
- [PRD FR-08](../../../docs/PRD-v2-test-data-management.md#fr-08-回收站与永久删除)
- [Architecture §§5.9、8](../../../docs/architecture/phase1a-architecture.md#59-trash-and-permanent-delete)
- [ADR-0008](../../../docs/adr/0008-controlled-deletion-propagation.md)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [v5.3 映射与删除修订](../../../docs/prototypes/phase1a-solo-workflow-v5.3-mapping-and-deletion-amendment.md)
- [v5.3 差异审计](../../../docs/reviews/phase1a-frozen-prototype-v5.3-contract-ticket-implementation-delta-audit.md)
- [Test plan](../../../docs/test-plan-phase1a.md)

## Acceptance Criteria

1. 测试集列表每行“查看”右侧提供普通边框的垃圾桶图标，且它只将整个测试集移入回收站；版本详情页不再出现整套测试集“移入回收站”动作。
2. 版本详情继续只提供叶子版本回收，以及中间版本的“整支回收”或“删除内容、保留关系”；版本图的灰色虚线墓碑、父边和后代关系保持不变。
3. 回收站分为“测试集”及“版本与版本分支”两个可理解的区段，空态、恢复、错误和 loading 状态均对齐原型。整套测试集回收会吸收此前独立回收的版本分支；恢复整套测试集时，所有仍可恢复版本重新可浏览，且不留下 active 的版本分支回收条目。
4. 永久删除测试集要求输入完整测试集名称；永久删除版本或版本分支要求输入根版本号；中间版本“删除内容、保留关系”同样要求输入版本号。输入不精确匹配时按钮禁用；服务端锁定当前对象/回收条目后再次精确校验，错误请求返回稳定 422 错误。
5. 现有回收、恢复、对象引用保护、fail-closed 清理、重试和项目隔离继续复用；不增加新状态、新服务、新页面或额外公共删除路由。现有删除请求可原位收紧，历史固定确认字符串不再构成可公开调用的确认。
6. **前端 UI 必须逐项对齐 v5.3 冻结原型。** 实现前在 Comments 写出测试集列表、版本详情、回收站和确认对话框的可见字段、控件顺序、文案、按钮状态、空/错状态与明确排除项；实现直接采用 `frontend-v1/` donor 的字体、token、图标、Dialog、Button、Input 和布局，不得自行重画或仅隐藏旧操作。
7. 不增加理由、审批、保留期、归档、外部副本清单、删除 Job、项目/数据集删除、内容恢复、版本改挂、标签复用、合并或任何 Phase 1B 能力。

## Frozen prototype parity

| 页面       | 必须对齐                                         | 排除                           |
| ---------- | ------------------------------------------------ | ------------------------------ |
| 测试集列表 | “查看”右侧普通垃圾桶图标；行内层级、列和分页保持 | 列表批量删除、项目/数据集删除  |
| 版本详情   | 仅版本级删除；中间版本两种选择与墓碑关系         | 整套测试集回收、版本恢复内容   |
| 回收站     | 测试集与版本/版本分支两个区段，恢复与永久删除    | 保留期、搜索、治理记录         |
| 破坏性确认 | 对象名称/版本号输入，未匹配禁用，匹配后才可提交  | 固定口令、第二确认人、理由字段 |

## Necessary tests

- 正常：从列表回收并恢复测试集；在回收站分别永久删除一套测试集和一个叶子版本；在中间版本输入其版本号后创建墓碑。
- 关键边界：先回收版本分支，再回收并恢复整套测试集，确认版本全部可浏览且无 active 分支条目；错误名称/版本号由 UI 禁用且服务端以 422 拒绝。
- 静态：直接相关 HTTP/transaction/delete integration 测试、当前 Trash 浏览器语义测试、`frontend-v3` typecheck/lint/build、`docs:check` 和 `git diff --check`。因修改永久删除持久化语义，运行直接相关 PostgreSQL/MinIO 证据；不运行无关全仓套件。

## Owner checkpoint

在测试集列表把一套测试集移入回收站并恢复；先回收一个版本分支后再回收、恢复整套测试集；检查回收站两个区段；分别输入错误和正确的测试集名称/版本号，确认破坏性按钮状态与结果。

## Out of scope

上传、数据集文件删除、项目删除、归档、保留策略、审批、理由、外部副本、删除任务页、版本合并/改挂、内容恢复、生产与 Phase 1B。

## Comments

- 2026-09-09：由 Project Owner 确认 v5.3 审计结论后创建。本记录不授权实现。
- 2026-09-09：开始实现前的冻结原型对齐记录。测试集列表保留名称、当前版本、记录数、来源、状态、更新时间和分页；“查看”右侧仅为普通边框的垃圾桶图标。版本详情仅保留版本级删除入口：叶子版本移入回收站，中间版本选择整支回收或删除内容保留关系。回收站按“测试集”与“版本与版本分支”分段，均有 loading、错误和空态；每项有恢复和永久删除。永久删除/中间墓碑对话框显示对象范围、精确名称或版本号输入框、取消与禁用至精确匹配的破坏性按钮。明确排除理由、审批、保留期、归档、外部副本、删除任务、项目/数据集删除、内容恢复、版本改挂、标签复用与合并。
- 2026-09-09：路由盘点：`POST /solo-test-sets/:testSetId/trash`、`POST /versions/:versionId/trash`、`POST /solo-test-set-trash/:entryId/restore` 为 reused；`POST /versions/:versionId/tombstone` 与 `POST /solo-test-set-trash/:entryId/permanent-delete` 为 narrowed（由历史固定确认字符串收紧为锁定后精确对象值）；无新增或 retired 公共删除路由。
- 2026-09-09：实现提交 `5a6bf32`。隔离 PostgreSQL/MinIO 环境中 `docker compose -p agentbench-ticket32-test -f compose.yaml -f .scratch/phase1a-test-data-management/ticket32-test-compose.yaml run --rm test` 通过 11/11；临时回环 Vite + 官方 Playwright 容器执行 `npm run test:e2e -- trash.spec.ts` 通过 2/2。`npm test` 通过 18 files / 131 tests，`npm --prefix frontend-v3 test` 通过 1/1，`npm run build`、根与 `frontend-v3` typecheck、`frontend-v3` lint（仅既有 6 条 Fast Refresh warning）、`git diff --check` 均通过。因本 Ticket 已覆盖删除事务与当前浏览器语义，未运行无关全仓 integration/E2E 套件。
- 2026-09-09：最终 Standards/Spec review 无未解决 P0/P1。Spec review 的空回收分组、锁定根版本再确认和破坏性/恢复 loading 状态三个 P1 已修复并由上述集成与浏览器回归覆盖。Production Gate 保持 Not Evaluated / Not Approved；待建立 `5a6bf32` 的独立 Owner checkpoint 后进行浏览器验收。Ticket 33 不存在且未启动。
- 2026-09-09：Owner checkpoint 已就绪：Compose project `agentbench-ticket32-owner-checkpoint` 运行固定提交 `894b6e4`，Web 仅监听 `127.0.0.1:4212`，`/health` 与 `/health/ready` 都返回该 SHA；PostgreSQL、MinIO、Web 和 Worker 均 healthy，同源 `POST /api/session` 返回 200。环境使用独立 edge/internal network、PostgreSQL/MinIO named volume、数据库 `agentbench_v2_ticket32_owner` 和 bucket `agentbench-v2-ticket32-owner`。其中已创建可删除的合成项目“Ticket 32 回收验证”和三版本测试集“回收与版本验证集”，等待 Project Owner 浏览器验收；Ticket 33 未启动。
- 2026-09-09：Project Owner 已在独立 checkpoint `agentbench-ticket32-owner-checkpoint` 完成并通过 Ticket 32 浏览器验收。该环境运行固定提交 `894b6e4`；Ticket 32 至此关闭。Production Gate 仍为 `Not Evaluated / Not Approved`，不会自动开始任何后续工作。
- 2026-09-09：Project Owner 已在同一固定 checkpoint 完成并通过 `docs/test-plan-phase1a.md` §F.2 的最终主闭环：项目、数据集、CSV/JSON/JSONL 确认上传、文件与统一记录浏览、行高、移动与原始预览、测试集 `v1`、线性/历史分支、搜索/分页/筛选、摘要与来源、两份 CSV 下载、回收/恢复、墓碑、分组回收站及精确输入永久删除。该结果覆盖当前 v5.3 序列 Tickets 20–32 的串联行为；Production Gate 仍为 `Not Evaluated / Not Approved`。
