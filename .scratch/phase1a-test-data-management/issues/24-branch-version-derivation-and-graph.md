# Phase 1A-24：从任一父版本派生与版本关系图

Status: ready-for-agent
Implementation: completed

Blocked by: [23](./23-solo-test-set-v1-workflow.md). 仍需 Project Owner 明确授权。

## Outcome

Owner 从任一完整历史版本继承并编辑，可选追加新资料，发布稳定 `vN` / `vN-bK`，并在横向父子图中切换全部历史。

## Required reading

- [Implementation Spec](../spec.md)，Test Set Version
- [ADR-0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)
- [Architecture 5.6](../../../docs/architecture/phase1a-architecture.md#56-version-graph)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Acceptance Criteria

1. 编辑从选中父版本完整内容开始，可不加新资料，也可选择额外数据集、文件或记录。
2. 发布新版本不改变父版本或其他历史。
3. `publication_order` 表示提交顺序，`generation` 和父边决定图位置。
4. 主线使用适用 `vN`；历史或分支派生使用测试集内全局唯一 `vN-bK`。
5. 并发发布不重复标签/分支号；失败不消耗号或留下半版本。
6. 图返回全部节点和父边，切换节点后摘要、记录、来源和下载绑定所选 version ID。
7. 当前祖先路径高亮；内容溢出时才显示“适应视图”。
8. 不提供默认切换、归档、任意比较、merge、rebase、rename、reparent 或并行草稿。
9. 版本公共 API 只提供派生、版本详情和只读父子图；旧 default/archive/compare/rename/reparent 动作退出公共注册，底层原子分配与不可变历史继续复用。

## Necessary tests

- 正常：`v1 → v2` 后回到 `v1` 派生分支，图和旧内容保持。
- 关键边界：两个并发派生获得不同标签，失败发布不留号洞；一个旧版本管理动作不再公开。
- 静态：version migration/allocator 测试及 `frontend-v3` typecheck、lint/build。

## Owner checkpoint

创建一个线性版本，再从历史节点创建分支；逐个切换图节点并确认内容不覆盖、路径高亮正确。

## Out of scope

来源详情、下载、删除、默认版本、归档、合并和 Git 式控制。

## Frontend parity repair

| 原型要素     | 本 Ticket 修复                                                                                       | 明确不做                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 当前版本摘要 | 置于版本关系图之前；显示标题、版本关系、创建时间、记录总数、用途说明和仅提示的数据核对。             | 来源与本版本修改详情由 Ticket 25 提供。                   |
| 版本关系     | 显示全部节点、父子连线箭头；当前版本到根节点的节点与边高亮，其他路径弱化；仅在溢出时显示“适应视图”。 | 不增加合并、重排、默认版本或其他图编辑操作。              |
| 删除节点     | 不在本 Ticket 提前显示。                                                                             | 灰色虚线墓碑及其不可浏览状态由 Ticket 26 的删除实现提供。 |

## Definition of Done

AC 与必要测试通过；记录 commit 和证据；本地提交后停止，不自动开始 Ticket 25。

## Comments

- Project Owner 已授权执行。实现提交：`92d6d1a`。
- `POST /api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/derived-versions` 与 `GET /api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId` 为本 Ticket 新增的窄版本 seam；测试集列表复用并收窄为返回最新发布版本。旧的未指定 version ID 的测试集详情读取已退出注册。
- 已验证：`v1 → v2`、从 `v1` 派生 `v2-b1`、`v2-b1 → v3-b1`、两个并发派生获得不同分支标签、失败请求不占用后续标签、重复父修订绑定被拒绝，且删除首条继承记录后剩余案例仍保留父修订身份。
- 实际命令：隔离 PostgreSQL/MinIO 环境中的 `npm run db:migrate`、`npx vitest run tests/integration/solo-test-set-v1.test.ts`、`npm run typecheck`、目标源文件 ESLint、`npm run build`。全仓 `npm run lint` 未作为证据：它会扫描既有的 `frontend-v2/dist/` 和 `frontend-v3/dist/` 生成资产并产生非本 Ticket 的错误。
- `agentbench-ticket24-owner-checkpoint` 浏览器语义验证已在 `http://127.0.0.1:4192` 完成：创建合成 `v2`，返回 `v1` 后操作文案切换为“基于此版本创建分支”；截图为忽略文件 `test-results/ticket24-browser.png`。后端 `/health` 与 `/health/ready` 均报告固定 SHA `9470777`。
- Standards 与 Spec 双轴审查及 P0/P1 定向复核完成，无未关闭 P0/P1。Production Gate 仍为 `Not Evaluated / Not Approved`。等待 Owner checkpoint 验收；不自动开始 Ticket 25。
- 前端原型对齐修复提交：`ff567c1`。`frontend-v3` 的 `npm run typecheck`、目标 ESLint、`npm run build`、`npm test`、Prettier、根目录 `npm run docs:check` 和 diff 检查均通过；新增 `e2e/version-graph.spec.ts` 覆盖摘要顺序、路径边状态及适应/还原/过窄保留滚动。该浏览器测试实际启动被宿主机缺少 `libatk-1.0.so.0` 阻断，未执行任何断言，必须在可用 Chromium 环境中重跑；未将它记为通过。对齐修复的 Standards/Spec 双轴审查及 P0/P1 定向复核均无未关闭 P0/P1。
- Project Owner 已验收 Ticket 24 当前浏览器 checkpoint；实现证据基线为 `a27a48c`。Ticket 25 的依赖已解除。未自动开始 Ticket 25。
