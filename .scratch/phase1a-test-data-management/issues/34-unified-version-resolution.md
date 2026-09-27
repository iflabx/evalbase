# EvalBase-34：统一版本解析与全部读取调用方接入

Status: ready-for-agent
Implementation: completed
Owner checkpoint: accepted; resources released

Blocked by: 无；[Ticket 33](./33-incremental-schema-and-legacy-compatibility.md) 已完成并通过 Owner checkpoint，Project Owner 已单独授权本 Ticket。下一张 Ticket 仍须单独授权。

## Outcome

从 legacy 或最近 Checkpoint + Delta 得到同一完整版本，所有现有读取功能使用统一模块。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 实现最近有效 Checkpoint 查找与按唯一父链回放；支持空版、净零、更新、删除、新增、分支和 legacy→delta。
2. 查询先解析完整逻辑成员，再执行白名单筛选、总数、分页和详情 ordinal；保持稳定位置与源字段/Metadata 语义。
3. 盘点并迁移版本浏览、编辑读取、摘要、核对、来源、两份 CSV、完整性扫描和删除依赖读取的全部直接 version_member 调用方；记录遗漏为阻塞，不能假定内部历史路径无调用。
4. 合成 Delta fixture 只经内部测试构造；公共发布保持 legacy。墓碑/永久删除节点禁止公开读取，内部依赖读取必须受专门上下文限制。
5. 前端 UI 必须对齐冻结原型；无 UI 修改时保留既有页面，涉及 frontend-v3 时先列明字段、控件顺序、标签、启用状态、空/错状态的 parity 表。禁止新增登录、格式选择、Checkpoint、Job、治理或其他原型外入口。

## Necessary tests

正常：同一含增删改和分支的 fixture 在 legacy/delta/checkpoint 得到相同有序记录、筛选分页、来源事实及数据 CSV；来源 CSV 保持各版本真实的变更类型与来源。边界：删除前页记录后分页不遗漏，跨项目/墓碑拒绝读取。跑统一模块及直接读取路由集成；不跑上传等无关套件。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint

预置一个仅含少量合成记录的测试集：同内容的 legacy、Delta 和 Checkpoint 版本，另含增删改及分支。交付可直接打开的版本链接/编号。Owner 切换三个版本，搜索、分页、Metadata 筛选、查看来源和下载两个 CSV；同一逻辑版本的顺序、内容、来源事实和数据 CSV 一致，来源 CSV 如实显示所选版本的变更类型，界面与冻结原型一致。跨项目/墓碑拒绝由自动化证据说明。

完成本地提交后，将独立 checkpoint 前后端切到当前固定 HEAD；验证 health/ready、预置内容的一次同源 API，并给出 URL、需要时的 SSH 隧道命令及上述手工步骤。Owner 通过并记录证据后回收本批专用资源；通过前不把 Ticket 35 标为已解除阻塞。

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。
- 2026-09-26：实现统一 SQL 解析器，从最近经成员数与 `members_hash` 验证的 Checkpoint 或 legacy 基线沿唯一父链回放 Delta；按稳定位置排序并重新生成页面 ordinal。版本浏览、编辑读取、摘要、核对、来源、两份 CSV、完整性扫描、删除依赖读取及 Worker 读取均接入；公开读取拒绝墓碑，完整性扫描使用可记录成员数异常的内部读取。公共发布仍是 legacy，没有改动 `frontend-v3/`。实现提交 `6017195`。
- 2026-09-26：专用合成 schema 测试 legacy/Delta/Checkpoint 等价、更新/删除/新增/分支、空版、分页总数、来源、两份 CSV、无效 Checkpoint 回退、损坏成员数扫描、墓碑与跨项目拒绝。当前集成套件 `unified-version-resolution`、`solo-test-set-v1`、`solo-test-set-trash`、`incremental-schema-migration` 在隔离 PostgreSQL/MinIO 中 29/29 通过；`npm run typecheck`、定向 eslint（`app.ts` 屏蔽基线既存未使用函数规则）、定向 Prettier、`npm run docs:check` 和 `git diff --check` 通过。历史 `version-lifecycle`/`controlled-deletion` 套件的旧登录入口在 v5.3 已退役，运行时先于本次读取接入返回 404；未运行全仓、正式部署迁移或浏览器 E2E。
- 2026-09-26：Standards/Spec 双评审的 P1（完整性扫描异常被解析器中断、无效 Checkpoint 被接受）已修复并复核关闭；保留 P2：解析器中祖先/路径递归查询有重复，后续若复杂度上升再抽取。Production Gate 仍为 `Not Evaluated / Not Approved`；Ticket 35 在本批 Owner checkpoint 通过前保持阻塞。
- 2026-09-26：固定实现提交 `6017195` 的 Ticket Closure Review P0/P1 cleared：按 AC 1–5 与 ADR-0011 检查公开成功/错误、迁移重跑、legacy/Delta/Checkpoint 解析、删除及完整性扫描相邻路径、资源隔离和启用门槛。保留 P2 递归查询重复；未测全仓、历史退役登录套件、正式迁移及大规模性能，不以当前 29/29 推断这些性质。
- 2026-09-26：独立 Owner checkpoint `evalbase-ticket34-owner-checkpoint` 运行固定实现 `6017195`，Web 仅绑定 `127.0.0.1:4214`，专属 edge/internal 网络、PostgreSQL/MinIO 卷、数据库和 bucket。Web、Worker、PostgreSQL、MinIO 均 healthy；`/health` 与 `/health/ready` 返回 `git_sha: 6017195`。同源 API 已验证三格式各显示 `bravo updated → charlie → delta` 三条记录、来源 CSV 与数据 CSV 可下载、真实来源预览可打开。隔离 Chromium 浏览器烟测三条版本直链均显示该测试集与预期记录。Owner 浏览器入口 `http://127.0.0.1:4214/projects/ticket34_project/test-sets/ticket34_set?version=ticket34_delta`；测试集 ID `ticket34_set`，等价版本 ID 为 `ticket34_legacy`、`ticket34_delta`、`ticket34_checkpoint`，另有分支 `ticket34_branch`。仅待 Owner 验收，资源保持运行；Ticket 35 继续阻塞。

- 2026-09-27：Project Owner 明确验收通过 Ticket 34。验收实现 SHA 为 `6017195`；清理前 `/health` 与 `/health/ready` 均返回该 SHA。已保存四个服务日志、健康响应、Compose 状态及 SHA-256 校验清单至 `local-acceptance-evidence/ticket34-owner-checkpoint-20260927/`。核对资源只属于 `evalbase-ticket34-owner-checkpoint` 后，已移除该项目四个容器、两张专用网络、PostgreSQL/MinIO 卷、4214 端口绑定及本 Ticket 专用镜像；专用合成数据随卷清理。Ticket 35 的前置验收条件已满足，但仍需 Project Owner 单独授权实施。
