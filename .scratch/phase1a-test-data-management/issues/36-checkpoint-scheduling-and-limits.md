# EvalBase-36：Checkpoint 后台物化与回放硬上限

Status: ready-for-agent
Implementation: completed

Blocked by: 无；[Ticket 35](./35-sparse-publication-and-manifest.md) 已完成并与本 Ticket 共同通过 Owner checkpoint。

## Outcome

周期物化完整成员并为 Worker 停止时的发布提供硬上限保护。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 遵照 ADR-0011 的精确 ceil 与空基线规则：20 代或累计 20% 触发；拟超过 40 代或 40% 时新版本同步物化，否则不得发布。重复修改按实际 Delta 行累计，零变化仍计版本深度。
2. Checkpoint 绑定已有版本，header/成员/checksum 原子可见；幂等作业重试、数量/顺序/payload 校验失败不发布半成品。
3. 锁序与发布/删除一致；旧 Worker 任务不得复活已删节点。required_dependency 不按可重建缓存回收。
4. 单次大变化直接物化；Checkpoint 后继续派生与从旧根回放等价，高水位不丢失；公共写入仍 legacy。
5. 前端 UI 必须对齐冻结原型；无 UI 修改时保留既有页面，涉及 frontend-v3 时先列明字段、控件顺序、标签、启用状态、空/错状态的 parity 表。禁止新增登录、格式选择、Checkpoint、Job、治理或其他原型外入口。

## Necessary tests

正常：跨触发阈值后读取及后继派生等价。边界：Worker 停止时分别覆盖深度/变化数硬上限前、等于、超出，注入物化失败验证无可见半版和号洞；空基线及净零深度用小 fixture。只跑 Checkpoint/job/publication 定向集成。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint

本批同时验收 Tickets 35+36。预置少量合成记录的 legacy 基线、内部 Delta 发布链、已触发 Checkpoint 的版本及其后继派生/分支，并交付可直接打开的版本链接/编号。Owner 顺着版本图打开 Delta→Checkpoint→后继版本，比较记录、来源与两个 CSV，再打开已预置的后继派生版本；内容与顺序连续且图节点不增加。Delta 发布、Checkpoint 触发、后继派生、Worker 停止和失败保护由自动证据说明，无设置页面或公共 Delta 发布入口。

完成本地提交后，将 35+36 合批 checkpoint 前后端切到 Ticket 36 固定 HEAD；验证 health/ready、预置内容的一次同源 API，并给出 URL、需要时的 SSH 隧道命令及上述手工步骤。Owner 通过并记录两张 Ticket 的证据后回收本批专用资源；通过前不把 Ticket 37 标为已解除阻塞。

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。
- 2026-09-27：Owner 已授权 Ticket 35+36。分支 `codex/ticket-36-checkpoint-limits` 的实施提交 `76e6577`：Delta 发布同步计算累计回放代数与实际变化行数；达到 20 代或 20% 时原子排入周期物化作业，拟超过 40 代或 40% 时在发布事务中建立硬 Checkpoint。Checkpoint 校验数量、顺序、payload、来源与成员哈希，并在同一事务写 header/成员；Worker 重试幂等，已删除版本不复活。已有 Checkpoint 的 deletion cut 晋升也重新执行完整校验。公开写入、路由和前端仍为 legacy；既有派生 API `reused`，无 `narrowed`/`retired` 或新增公开入口。
- 定向验证：`tests/integration/checkpoint-limits.test.ts` 10/10、Ticket 35/34 相邻回归 16/16、最终来源状态定向复测 1/1；宿主机 `npm run typecheck`、改动文件定向 `npx eslint` 与 `git diff --cached --check` 通过。隔离 Compose 已预置 10 条合成记录，基础 legacy、1 条变更 Delta、超过 40% 的硬 Checkpoint、零变化后继、20% 周期分支和排队作业；数据库核对 5 个版本、硬 Checkpoint 原因 `hard_limit`、周期作业 `queued`。全仓 lint 因既存 frontend-v3 生成文件及未改动 server 文件报错；容器内 typecheck 因现有 `.dockerignore` 排除 `src/web` 报错，故以宿主机全量 typecheck 和定向 lint 为有效检查。未跑全仓、性能套件或正式环境迁移。
- Standards/Spec 双轴审查发现的 P1（deletion cut 晋升缺完整校验、已晋升重试绕过校验）已修复并定向复核，无未解决 P0/P1。保留 P2：真实 Worker 领取/重试路径待本批 checkpoint 核验。Production Gate 仍为 `Not Evaluated / Not Approved`；Ticket 37 在 35+36 Owner 验收前保持阻塞。本批独立前后端 checkpoint 和固定 HEAD 闭环复核见后续记录。
- 固定 HEAD `5b15133` 的 Ticket Closure Review：逐项核对 20/40 代、20%/40% 精确 ceil 与空基线、净零计深度、变化行累计、发布与 Checkpoint 同事务、header/成员 hash、Worker 领取和幂等、已删节点跳过、来源及 deletion cut 保留、高水位与后继派生、公共 legacy、容量边界、文档和环境身份。对应定向测试、相邻回归与本批实跑证据均通过，结论为 `Ticket Closure Review P0/P1 cleared at 5b15133`。保留 P2：未故障注入真实 Worker 作业领取后的失败重试（物化函数的重试已测试）；未跑无关全仓、性能及正式环境套件。
- 35+36 合批 Owner checkpoint `evalbase-ticket35-36-owner-checkpoint` 已从 `5b15133` 构建并在服务器回环地址 `127.0.0.1:4215` 运行；Web、Worker、PostgreSQL、MinIO healthy，`/health` 与 `/health/ready` 回报固定 SHA。独立数据库、bucket、两张网络和两个卷只属于本批。预置项目 `ticket3536_project`、测试集 `ticket3536_set`、10 条合成记录；版本依次为 legacy `ticket3536_base`、Delta `version_c47b960f8a774bb1981e0f1fc24e3b78`、硬 Checkpoint `version_00e4c1d9929140fab8cd6e62ec6d47b7`、零变化后继 `version_02b3cbbb8abb455286eec2e1de284735`，另有周期分支 `version_15420f18864d4f57bbe402f57c029680`。真实 Worker 将该分支作业从 `queued` 处理为 `succeeded`，建成 `periodic/rebuildable` Checkpoint。隔离 Chromium 浏览器五条版本直链可见；同源记录、来源、`data.csv`、`provenance.csv` 均为 200。Owner 从测试集版本图按上述顺序打开，核对 10 条内容与顺序、前五条更新、后继不新增图节点和两个 CSV；Checkpoint 为内部存储，不显示额外 UI 节点。未验收前保留该环境。
- 测试 Compose `evalbase-ticket36-test` 的容器、网络、卷及测试镜像已清理。另发现 Ticket 33 遗留的独立 `evalbase-ticket33-pg` PostgreSQL 测试容器：数据库无版本、无客户端连接，仅绑定 `127.0.0.1:55433`；核对后已连同匿名卷移除，端口释放。已验收的 Ticket 34 无剩余专用容器、网络、卷或端口。其他项目与正式 `evalbase` 未操作。
- 2026-09-27：Project Owner 明确将 35+36 联合 checkpoint 记为通过；验收运行 SHA `5b15133`。本机浏览器经 SSH 隧道打开五个版本并核对 10 条顺序记录、v3 的 4 条修改及单条前后详情、v4 净零后继、v2-b1 的第 6/7 条修改和 CSV 下载。验收前 `/health`、`/health/ready` 均返回 `5b15133`；真实 Worker 的周期作业 `succeeded`，硬/周期 Checkpoint 状态与预期相符。服务日志、Compose 状态、健康响应、版本/作业状态和通过 SHA-256 校验的证据保存在 `local-acceptance-evidence/ticket35-36-owner-checkpoint-20260927/`。待按根 AGENTS.md 仅回收本批专用资源。Ticket 37 的前置验收条件已满足，但仍需 Project Owner 单独授权；Production Gate 仍为 `Not Evaluated / Not Approved`。
- 清理前逐一核对四个容器、两张网络和两个卷的 Compose project 标签均为 `evalbase-ticket35-36-owner-checkpoint`。已移除该批四个容器、两张网络、两个卷、专用镜像、合成数据与服务器 4215 端口绑定；本机 SSH 隧道已关闭，本机端口 4215 空闲。最终资源清单无该批残留，清理日志及 SHA-256 校验清单已保存到上述证据目录。其他项目和正式 `evalbase` 未动。
