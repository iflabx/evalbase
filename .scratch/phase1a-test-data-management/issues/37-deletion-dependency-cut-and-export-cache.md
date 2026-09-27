# EvalBase-37：永久删除依赖切断与 CSV 缓存保护

Status: ready-for-agent
Implementation: completed

Blocked by: 无；[Ticket 36](./36-checkpoint-scheduling-and-limits.md) 已与 Ticket 35 共同通过 Owner checkpoint，Project Owner 已单独授权实施本 Ticket。

## Outcome

删除增量链中间节点后，后代独立可读且目标正文不会经存储或缓存重新暴露。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 确认后先阻断目标访问，找到跨出删除范围的全部存活边界（含回收站可恢复版本），在自身建立/提升 required_dependency Checkpoint；全部校验成功后才清理。
2. 图父边与标签不变；当前内容、来源与修改事实按现行语义保护，专属已删前值不可通过 revision、manifest、candidate、staging 或导出缓存泄漏。锁序、重试与共享引用必须覆盖。
3. 已有 periodic checkpoint 成为必要基线时提升保留级别；本版本和后代仍依赖时不回收，删除叶子或完整支不做无用物化。
4. 两份 CSV 按需生成，可重建缓存按版本/类型/序列化/证据指纹区分；命中仍授权，来源移动/删除导致相关缓存失效；不新增 ZIP/导出管理 UI。
5. 公共写入仍 legacy；用内部 Delta fixture 验证真实 MinIO/PG 删除，不能以隐藏节点替代内容清理。
6. 前端 UI 必须对齐冻结原型；无 UI 修改时保留既有页面，涉及 frontend-v3 时先列明字段、控件顺序、标签、启用状态、空/错状态的 parity 表。禁止新增登录、格式选择、Checkpoint、Job、治理或其他原型外入口。

## Necessary tests

正常：分叉中间节点墓碑后所有存活后代内容、来源、CSV 与删除规则一致，父边不改挂。边界：一处分支物化失败时不物理清理；重试完成、共享修订保护、缓存命中与删除竞态。补叶子/整支/整套删除与回收恢复的定向回归，不跑无关套件。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint

预置专用的小型合成测试集，含分叉中间版本、两条存活后代及可恢复版本，交付可直接打开的版本链接/编号。Owner 先回收恢复，按现有精确输入对话框永久删除指定中间版本，再打开两条后代并下载两个 CSV：后代内容和来源可读，旧节点正文不可打开，版本关系仍在。只对本批合成数据执行删除。

完成本地提交后，将独立 checkpoint 前后端切到当前固定 HEAD；验证 health/ready、预置内容的一次同源 API，并给出 URL、需要时的 SSH 隧道命令及上述手工步骤。Owner 通过并记录证据后回收本批专用资源；通过前不把 Ticket 38 标为已解除阻塞。

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。
- 2026-09-27：在 `codex/ticket-37-deletion-cut-cache` 完成实施，代码提交 `4179921`、`c7e5880`。永久删除先阻断，再为所有存活边界（含可恢复及归档节点）建立或提升 Checkpoint；清理专属 PG 修订、candidate/staging 前值及 MinIO 对象，保留共享引用和待重试对象列表。两份 CSV 使用按证据指纹区分的可重建缓存，来源移动/删除与导出串行化；公共写入仍为 legacy，前端未改。
- 2026-09-27：测试数据库迁移后，`npm run typecheck`、Ticket 37 定向集成 19/19、相邻 Tickets 34–36 定向集成 26/26、`git diff --check` 通过。定向 lint 仅报 `src/server/app.ts:633` 未改动的既有未使用函数；未运行全仓测试。Standards 与 Spec 复核均无剩余 P0/P1。路由盘点：复用单人测试集版本/回收站路由、收窄墓碑与永久删除及 CSV 导出语义；既有受控删除入口仍 retired。Production Gate 维持 `Not Evaluated / Not Approved`。Owner checkpoint 及资源回收证据另记。
- 2026-09-27：Project Owner 明确通过 Ticket 37 checkpoint，且单独授权在隔离合成数据中永久删除 v2。固定运行 SHA `c9b755f` 的浏览器验收先恢复 v3-b2，再删除 v2：关系图保留 v2 墓碑及三条父边；v3、v3-b1、v3-b2 均可读取 20 条；v3 来源与修改显示未改变 19、已修改 1；两个 CSV 可下载且不含被删专属正文；直接访问 v2 返回 404。数据库复核 v2 已清理、三条后代具有 `required_dependency,deletion_cut` Checkpoint，revision 与导出缓存不含被删专属正文。证据和 SHA-256 清单位于 `local-acceptance-evidence/ticket37-owner-checkpoint-20260927/`。验收专用四个容器、两个网络、两个卷、镜像及 4217 隧道均已释放；正式 `evalbase` 与其他项目未动。Ticket 38 的依赖条件已满足，但未获实施授权；Production Gate 仍为 `Not Evaluated / Not Approved`。
