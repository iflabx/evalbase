# Phase 1A-28：上传队列追加与项目内原始文件去重

Status: ready-for-agent
Implementation: completed

Blocked by: [27](./27-frontend-v3-cutover-and-owner-loop.md)（已完成）。Project Owner 已授权。

## Outcome

在不增加页面、设置、治理字段或新服务的前提下，连续选择本地文件会追加到当前上传队列；同一项目中原始字节 SHA-256 完全相同的文件只保留一份数据资产。

## Required reading

- [Implementation Spec](../spec.md)，两步确认上传
- [PRD FR-03](../../../docs/PRD-v2-test-data-management.md#fr-03-两步确认上传)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [v5.1 上传补充](../../../docs/prototypes/phase1a-solo-workflow-v5.1-upload-amendment.md)
- [Test plan](../../../docs/test-plan-phase1a.md)

## Acceptance Criteria

1. 在同一打开的上传弹窗中，第二次及后续点击“选择文件”会追加新本地文件；同一个本地文件重复选择只保留一次。
2. 系统以原始字节 SHA-256 作为唯一去重身份：同名不同内容允许，不同名但相同内容视为重复；不同项目允许相同字节。
3. 同项目已确认文件或当前待确认上传包含相同内容时，重复项不进入映射和确认；弹窗只显示已有文件名和数据集名等可理解信息，不显示 ID、SHA-256 或原始正文。
4. 混合批次跳过重复项并继续处理其他文件；全部重复时停留在选择页，不产生可见资产。
5. 最终确认在事务内复检内容身份；竞态或陈旧 pending 不产生部分资产或第二份相同内容。
6. 不自动删除、合并、迁移或重写任何历史重复文件；不实现记录级去重、跨项目去重、别名、多数据集引用、重复管理页或新上传状态机。

## Frozen prototype parity

| 范围 | 保留 | 本 Ticket 补充 | 排除 |
| --- | --- | --- | --- |
| 上传选择页 | 选择文件、保存到、文件列表、取消、下一步 | 连续选择追加；红色“已跳过重复文件”提示；逐项移除已选文件 | 拖放、哈希展示、设置页 |
| 映射/确认页 | 逐文件映射、真实预览、一次确认 | 只展示非重复文件；仍维持原有顺序 | 重复文件映射、单文件确认、记录合并 |

## Necessary tests

- 正常：浏览器连续选择 CSV 和 JSON，进入逐文件映射；同项目不同数据集的同字节重传被跳过。
- 关键边界：不同项目相同字节可确认；同批次不同文件名相同字节不产生第二个 pending 或可见资产；确认事务重检不产生半成品。
- 静态：相关上传集成测试、当前浏览器语义测试、`frontend-v3` typecheck/lint/build、`docs:check`。

## Owner checkpoint

在一个项目中先确认文件 A；再次上传 A 与一个新文件 B，确认 A 被跳过、B 可映射并保存。再在另一项目上传 A，确认可保存。

## Comments

- 2026-09-08：Project Owner 决定同项目精确字节去重、混合批次跳过重复并继续、历史重复保持不动。公共路由处置：`POST /pending-uploads` 与 `POST /pending-upload-batches/confirm` 为 `narrowed`，复用流式 ArtifactRepository、SHA-256、MinIO 和 PostgreSQL 事务；不恢复历史直接上传路由。
- 2026-09-08：实现提交 `918bb1f`，后续可见性与逐项移除修正提交 `ce5c27b`。验证通过：`npm run typecheck`、`npm --prefix frontend-v3 run typecheck`、`npm --prefix frontend-v3 run build`、`git diff --check`；专用 Docker PostgreSQL/MinIO 环境中 `tests/integration/confirmed-upload.test.ts` 为 5/5 通过。Standards/Spec 双轴审查的唯一 P1（checkpoint 的 `GIT_SHA` 不得固定为旧提交）已关闭；未运行无关全仓套件。宿主 Chromium 仍缺少 `libatk-1.0.so.0`，未伪造本机浏览器自动化结果。
- 2026-09-08：Project Owner 已验收固定 HEAD `ce5c27b` 的 Ticket 28 checkpoint。`agentbench-ticket28-test` 的 Web 仅监听 `127.0.0.1:4208`；`GET /health` 返回 `{"status":"ok","git_sha":"ce5c27b"}`，`GET /health/ready` 返回 PostgreSQL 与 MinIO 均为 `ok`。本验收仅解除当前 Ticket 的依赖，不自动开始下一张 Ticket。Production Gate 仍为 `Not Evaluated / Not Approved`。
