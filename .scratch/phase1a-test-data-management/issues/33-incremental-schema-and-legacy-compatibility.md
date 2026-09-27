# EvalBase-33：增量存储表结构与旧版本兼容

Status: ready-for-agent
Implementation: completed

Blocked by: 无未完成实施 Ticket；ADR-0011、同步 Spec 与 Test Plan 为输入。 每张须 Owner 单独授权；创建文档不等于启动执行。

## Outcome

建立正式增量存储 schema，并确保已有测试集升级后可继续浏览、派生和下载。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 按 ADR-0011 加法迁移格式字段、Delta 与 Checkpoint 表、必要外键/索引；旧版本标记 legacy_full_v1，重复执行迁移安全，空库可初始化。
2. 保留旧 ID、父边、标签、hash、对象和来源；公共写入仍走 legacy，不批量改写旧版本。
3. 以迁移验证覆盖 hash NULL 约束、非法 operation、重复 case/position 和跨测试集引用；发布时约束与数据库约束责任写清楚。
4. 明确稳定位置高水位、bigint 无损编码和旧 ordinal 适配方式，为后续 Ticket 提供可实现的内部接口；不新增公共字段选择或 UI。
5. 前端 UI 必须对齐冻结原型；无 UI 修改时保留既有页面，涉及 frontend-v3 时先列明字段、控件顺序、标签、启用状态、空/错状态的 parity 表。禁止新增登录、格式选择、Checkpoint、Job、治理或其他原型外入口。

## Necessary tests

正常：对包含历史分支、结构化/旧文本 Metadata 的合成旧库升级后浏览、派生、下载，内容与升级前一致。边界：重复迁移与一个非法 Delta 写入必须有确定结果。仅跑迁移/兼容相关 PostgreSQL 集成与受影响静态检查。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint

升级后的隔离环境打开已有合成 v1/v2/分支，下载旧版本并派生一次；预期界面与内容不变。新 Delta 尚未启用。

完成本地提交后，将独立 checkpoint 前后端切到当前固定 HEAD；验证 health/ready 和一次同源 API，给出 URL、需要时的 SSH 隧道命令及上述手工步骤。不得覆盖正式部署或其他运行资源；Owner 通过前不把下一张标为已解除阻塞。

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。
- 2026-09-26：完成加法迁移：`test_set_version.storage_format`、`version_change`、`version_checkpoint`、`version_checkpoint_member` 及约束/索引；既有版本默认 `legacy_full_v1`，未修改旧版本 ID、父边、标签、hash、对象、来源或 `version_member`。没有前端改动，保留冻结原型页面。实现提交：`e8dd927`、`bd5260e`。
- 2026-09-26：迁移集成测试在专用 PostgreSQL schema 中覆盖空库初始化、重复迁移、旧历史分支事实保留、NULL/非法 operation/哈希/位置、重复 case/position、Checkpoint 约束、外键边界和 bigint 位置无损读取。公开接口回归在隔离 PostgreSQL/MinIO 中模拟旧 schema 升级后通过浏览、派生与两份 CSV 下载，并核对升级前后响应一致。
- 2026-09-26：验证命令：`npx vitest run tests/integration/incremental-schema-migration.test.ts`（6/6，通过；专用隔离 PostgreSQL/MinIO）；`npx vitest run tests/integration/solo-test-set-v1.test.ts`（4/4，通过；迁移后旧格式创建、浏览、派生、来源和 CSV 下载）；`npm run typecheck`、定向 `eslint`、定向 `prettier --check`、`npm run docs:check`、`git diff --check` 均通过。未运行全仓测试、浏览器 E2E、正式部署迁移；本 Ticket 无新增 UI。
- 2026-09-26：Owner checkpoint 已切换到固定 HEAD `4ea48a1`，Compose project 为 `evalbase-ticket33-owner-checkpoint`，Web 仅监听 `127.0.0.1:4213`，独立 PostgreSQL/MinIO/网络/卷均 healthy；`/health` 与 `/health/ready` 均返回 `git_sha: 4ea48a1`，同源 `POST /api/session` 返回 200。浏览器入口：`http://127.0.0.1:4213/`；本 Ticket 没有新增 UI 操作，手工检查现有项目选择、旧测试集版本浏览、派生和下载即可。Production Gate 仍为 `Not Evaluated / Not Approved`；Ticket 34 未获授权。
- 2026-09-26：Project Owner 已完成 Ticket 33 checkpoint 验收，确认通过。该验收只关闭 Ticket 33，不自动授权 Ticket 34。

- 2026-09-27：按已记录的 Owner 验收清理旧 `evalbase-ticket33-owner-checkpoint`：四个容器、两张专用网络、PostgreSQL/MinIO 卷、4213 端口绑定及专用镜像均已移除。清理前实际运行的 `/health` 返回 `bb97625`；它与此前记录的 `4ea48a1` 之间仅有 Ticket/进度文档改动，无实现改动。四个服务日志、健康响应、Compose 状态及 SHA-256 校验清单保存于 `local-acceptance-evidence/ticket33-owner-checkpoint-20260927/`。
