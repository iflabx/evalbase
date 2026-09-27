# EvalBase Phase 1A Non-production Server Development Gate

| 项目 | 内容 |
| --- | --- |
| Gate 状态 | **Passed** |
| Gate 类型 | 非生产研发服务器执行准入检查 |
| 决策与执行角色 | Project Owner / Sole Developer |
| 适用范围 | Project Owner 已确认可经既有 Tailscale 路径访问的目标非生产研发服务器；仅允许数据分类 |
| 阻断对象 | [Ticket 01](../../.scratch/phase1a-test-data-management/issues/01-utf8-csv-to-validated-v1.md) |
| Production 状态 | Not Approved；本 Gate 不是 Production Gate 或生产批准 |
| 建立日期 | 2026-08-18（Asia/Shanghai） |

> Project Owner / Sole Developer 已在目标服务器完成机器可验证检查并保存原始证据，于 2026-08-18 明确确认本 Gate 通过。Project Owner 已确认其本机可经既有 Tailscale 路径访问目标服务器；这是一项非生产运行前提，不是本 Gate 的网络测试结论，也不构成生产、安全或合规批准。Ticket 01 的历史研发停点已由 Project Owner 解除，Ticket 01 已完成；本 Gate 不自动授权后续 Ticket。

## 1. 目的和边界

本 Gate 只回答：目标共享服务器是否具备安全地开始 EvalBase Phase 1A 非生产研发的工具链、隔离、持久化和最小数据路径能力。

- 当前文档机没有 Docker、PostgreSQL 或 MinIO 属于 deferred server condition，不阻断文档冻结或仓库迁移。
- Gate 为 `Pending` 时不得执行 Ticket 01，也不得把 Ticket 01 标记为 `ready-for-agent`。
- Gate 通过不代表 Phase 1A 已实现、性能最终验收已通过、生产部署已获批准，或可以处理真实敏感数据。
- [Ticket 17](../../.scratch/phase1a-test-data-management/issues/17-performance-deployment-and-owner-loop.md)仍负责完整应用的最终性能、部署和真实 Owner 闭环验收。

## 2. 既定技术合同

### 2.1 工具链

- Node.js 使用 24 LTS major；实际 patch 版本在执行时记录。
- 包管理器使用随 Node.js 环境提供并在执行时记录版本的 npm；仓库使用 `package-lock.json` 和 `npm ci`，不增加另一种包管理器。
- PostgreSQL、MinIO 和 Compose 的实际版本在服务器 Gate 执行时选择并记录非浮动 tag 或 digest；当前文档冻结不虚构尚未验证的版本。
- `WEB_PORT` 可配置，默认值为 `3000`。Gate 可选择任一经预检确认未占用的临时端口并记录；不能影响服务器其他项目。

### 2.2 标准命令

后续代码库必须保持以下稳定入口：

| 目的 | 标准命令 |
| --- | --- |
| 安装 | `npm ci` |
| Web/Worker 开发运行 | `npm run dev` |
| 单元/公共模块测试 | `npm test` |
| PostgreSQL/MinIO 集成测试 | `npm run test:integration` |
| 浏览器端到端测试 | `npm run test:e2e` |
| 类型检查 | `npm run typecheck` |
| 静态检查 | `npm run lint` |
| 构建 | `npm run build` |
| 数据库迁移 | `npm run db:migrate` |
| 离线校验器 | `npm run validator -- <package.zip> [--json]` |

Gate 可以在仓库外的临时目录使用可删除的 probe/Spike harness 验证 Node、npm、Compose、PostgreSQL、MinIO 和这些命令入口在目标服务器可执行；该 harness 不是应用骨架、产品实现或 Ticket 01 的替代品。Ticket 01 完成后仍须让真实仓库命令通过。

## 3. 共享服务器隔离和安全约束

执行 Gate 前必须先做只读预检，证明不会影响服务器中的其他项目：

1. 使用 EvalBase 专用工作目录、固定且唯一的 Compose project name、内部 network、PostgreSQL/MinIO named volumes 和凭据；不得复用其他项目的数据库、bucket、network 或 volume。
2. 先记录现有端口、容器、Compose project、CPU、内存和磁盘占用，再选择未占用的 `WEB_PORT`。PostgreSQL、MinIO API 和 MinIO Console 不发布宿主机入站端口。
3. 为 EvalBase 容器设置 CPU、内存和磁盘使用边界；若资源不足或无法证明隔离，Gate 必须失败。
4. 禁止执行会影响全局环境的 `docker system prune`、批量 stop/restart/remove、全局 network 修改或删除非 EvalBase volume。清理动作只能命中已核对的 EvalBase namespace。
5. Gate 使用的对象、数据库、bucket、container、network 和 volume 名称全部写入证据；任何名称冲突必须先换名，不能覆盖已有资源。

## 4. 必须通过的检查

### 4.1 基线和工具版本

- 从本文档冻结产生的 Git baseline commit 开始，迁移后工作树干净。
- Node.js major 为 24；记录 Node、npm、Git、Docker Engine 和 Docker Compose 的精确版本。
- Compose 文件解析成功；PostgreSQL 与 MinIO 使用非浮动版本并通过健康检查。

### 4.2 标准命令探针

- 第 2.2 节的每条标准命令都有真实执行结果、开始/结束时间和输出摘要；短命令记录 exit code，`npm run dev` 记录 ready/health 结果和受控停止结果。
- probe harness 只证明服务器工具链和命令入口可运行，不得把 probe 结果描述成应用功能测试通过。
- 任一命令缺失、不可运行或依赖未隔离时，Gate 保持 `Pending` 或标记 `Failed`；不得用手工替代步骤假装通过。

### 4.3 Compose、服务和持久化

- 专用 Compose project 中 PostgreSQL、MinIO 和 probe 所需进程启动并健康，其他项目状态前后不变。
- 分别向 PostgreSQL 和 MinIO 专用卷写入 synthetic sentinel，重启进程与容器、按正常 Compose 程序重建容器后仍能读取并校验。
- 该检查只证明正常重启/重建后的本地持久化，不是备份、RPO、RTO 或灾难恢复测试。

### 4.4 既有 Tailscale 访问前提与端口

- Project Owner 已确认其本机可经既有 Tailscale 路径访问目标服务器；Gate 记录该 Owner 确认，但不重复测试 Tailscale 连通性，也不要求执行断开 Tailscale 或公网负向探测。
- 记录实际 `WEB_PORT` 与 Owner 指定的服务器绑定地址，并用服务器侧证据确认 Web 没有绑定未指定的宿主机地址；不得修改防火墙或扩大现有网络暴露面。
- PostgreSQL、MinIO API 和 MinIO Console 没有宿主机入站端口；正式前端不提供登录步骤，服务端在受限非生产配置中为唯一 Owner 非交互式建立请求身份，Tailscale 可达性不替代 Origin/CSRF 或项目范围边界。
- 访问路径、绑定地址或公网暴露状态发生变化时，本运行前提立即失效并触发重新评审；本 Gate 不声称证明公网不可达。

### 4.5 架构 §17.4 有界技术 Spike

在编写 Ticket 01 的持久化数据路径前，必须用一次性 Node.js 流式 probe、真实 PostgreSQL 和真实 MinIO 执行以下合成负载：

| 负载 | 固定输入与判定 |
| --- | --- |
| 单资产流式接收 | 精确 50 MB（50,000,000 bytes）；不能把完整原始文件重新缓冲到内存 |
| Parsed View 查询 | 10,000 条 Source Record；ready 后首屏 100 条 P95 ≤ 3 秒 |
| 结构化筛选 | 10,000 条 Source Record；P95 ≤ 5 秒 |
| 草稿总量 | 5 个资产，原始字节合计精确 100 MB（100,000,000 bytes），源记录合计 10,000 条 |
| 候选/对象提交代表路径 | 10,000 条正式记录，规范化 `items.jsonl` 最大精确 100 MB（100,000,000 bytes）；P95 ≤ 2 分钟 |
| 取消 | 批次边界可观察取消；无可见半对象，记录取消请求到稳定结果的延迟 |

每项必须记录输入生成器版本、seed、精确字节数、记录数、SHA-256、样本数和 P95 算法，并保存单次原始结果。至少记录峰值 RSS、CPU、PostgreSQL batch 行为、MinIO 读写量、总耗时和取消延迟。

Spike 失败时停止 Gate 和 Ticket 01。只允许在既定四部署单元内调整流式处理、批次、索引、SQL 或对象写入；不得提高容量、引入 Arrow/Parquet、增加服务或放宽 P95。

## 5. 执行证据

本次执行窗口为 2026-08-18 08:12-08:25 UTC。证据根目录为 `<nonproduction-gate-workdir>/evidence/run-20260818T080825Z/`；`results/evidence-sha256.txt` 已于 Gate 确认前使用 `sha256sum --check` 全量复核通过。以下相对路径均相对于该目录。机器报告是在 Owner 最终确认前生成的不可变执行快照，因此其中如实保留当时的 `Pending`；本记录第 6 节记录之后发生的 Owner `Passed` 决定。

### 5.1 基线、服务器和网络

| 证据项 | 实际值 / 证据位置 | 当前状态 |
| --- | --- | --- |
| Baseline Git commit | Spike 执行源：`0adf9059a8732743fc5e56c46d3d79df0023f3cb`；Owner 授权文档提交后干净基线：`61f80bee633df339a832738bce115c509595c564`；`raw/19-clean-baseline-doc-commit.log` | Pass |
| 迁移后 `git status --short` | Gate 确认前输出为空；机器报告记录于 `results/gate-machine-report.md` | Pass |
| 操作系统 / kernel | Ubuntu 26.04 LTS；Linux `7.0.0-22-generic`；`raw/00-preflight.log` | Pass |
| CPU 型号 / vCPU | Intel Xeon Gold 5218R @ 2.10 GHz；16 vCPU；`raw/00-preflight.log` | Pass |
| RAM | 65,271,734,272 bytes；`raw/00-preflight.log` | Pass |
| 磁盘型号、介质、文件系统、可用空间 | VMware Virtual disk，经 LVM 挂载为 ext4；执行后可用 133,073,596,416 bytes；`raw/15-version-dependency-disk-manifest.log` | Pass |
| Project Owner 对既有 Tailscale 访问路径的确认 | 已确认；本机可经 Tailscale 访问目标服务器 | Owner-confirmed assumption |
| 实际 `WEB_PORT` / 绑定地址 | `<nonproduction-server-ip>:3000` | Pass |
| Web 服务器侧监听/绑定证据 | 仅绑定指定地址；health 200；`raw/07-edge-network-fix-health.log` | Pass |
| PostgreSQL / MinIO 无宿主机入站端口证据 | 两者 `PortBindings` 均为空；`raw/07-edge-network-fix-health.log` | Pass |

### 5.2 工具和服务版本

| 组件 | 精确版本 / tag / digest | 可用性证据 | 当前状态 |
| --- | --- | --- | --- |
| Node.js | `24.6.0`；`public.ecr.aws/docker/library/node@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff` | `raw/09-standard-commands.log` | Pass |
| npm | `11.5.1` | `raw/09-standard-commands.log` | Pass |
| Git | `2.53.0` | Gate 确认前服务器只读复核 | Pass |
| Docker Engine | `29.1.3` | `raw/00-preflight.log` | Pass |
| Docker Compose | `2.40.3` | `raw/00-preflight.log` | Pass |
| PostgreSQL | `16.14`；`public.ecr.aws/docker/library/postgres@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8` | health、SQL 与持久化校验见 `raw/06-bootstrap-isolation-health.log`、`raw/08b-persistence-restart-recreate.log` | Pass |
| MinIO | `RELEASE.2025-09-07T16-13-09Z`；`minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` | health、对象 I/O 与持久化校验见 `raw/06-bootstrap-isolation-health.log`、`raw/08b-persistence-restart-recreate.log` | Pass |

### 5.3 隔离与持久化

| 证据项 | 实际值 / 原始证据位置 | 当前状态 |
| --- | --- | --- |
| 专用工作目录与 Compose project name | `<nonproduction-gate-workdir>`；`agentbench-v2-gate-0adf905` | Pass |
| network、container、volume、database、bucket 清单 | internal/edge network、3 个专用 container、`agentbench-v2-gate-0adf905-{postgres,minio}-data`、`agentbench_v2_gate_0adf905`、`agentbench-v2-gate-0adf905`；`raw/04-compose-config.log` | Pass |
| 端口/容器/资源只读预检 | 执行前快照见 `raw/00-preflight.log`、`raw/03-before-resource-snapshot.log` | Pass |
| CPU、内存、磁盘限制 | Web 2 CPU/2 GiB；PostgreSQL、MinIO 各 2 CPU/4 GiB；执行后约 133.07 GB 可用；`raw/04-compose-config.log`、`raw/15-version-dependency-disk-manifest.log` | Pass |
| 其他项目执行前后状态不变 | container、network、volume identity diff 均为空；`raw/14-isolation-diff-before-stop.log`、`raw/18-final-isolation-repository-state.log` | Pass |
| PostgreSQL sentinel 重启/重建后校验 | 正常 restart 与强制容器重建后值一致；`raw/08b-persistence-restart-recreate.log` | Pass |
| MinIO sentinel 重启/重建后校验 | 正常 restart 与强制容器重建后对象一致；`raw/08b-persistence-restart-recreate.log` | Pass |

### 5.4 标准命令结果

| 命令 | Exit code 或 ready/stop 结果 | 输出/日志证据 | 当前状态 |
| --- | --- | --- | --- |
| `npm ci` | Exit 0 | `raw/02-npm-ci.log` | Pass |
| `npm run dev` | ready/health 200；受控停止后端口释放 | `raw/05-compose-up.log`、`raw/07-edge-network-fix-health.log`、`raw/17-controlled-stop.log` | Pass |
| `npm test` | Exit 0；1 test passed | `raw/09-standard-commands.log` | Pass |
| `npm run test:integration` | Exit 0；真实 PostgreSQL/MinIO 检查通过 | `raw/09-standard-commands.log` | Pass |
| `npm run test:e2e` | Exit 0；probe health 200 | `raw/09-standard-commands.log` | Pass |
| `npm run typecheck` | Exit 0 | `raw/09-standard-commands.log` | Pass |
| `npm run lint` | Exit 0 | `raw/09-standard-commands.log`、`raw/11-bounded-spike-retry.log` | Pass |
| `npm run build` | Exit 0 | `raw/09-standard-commands.log` | Pass |
| `npm run db:migrate` | Exit 0 | `raw/09-standard-commands.log` | Pass |
| `npm run validator -- <package.zip> [--json]` | Exit 0；`valid: true`，仅为 probe 命令入口 | `raw/09-standard-commands.log` | Pass |

### 5.5 有界 Spike 原始结果

| 场景 | 输入/生成器 | 样本与原始结果位置 | P95 / 资源峰值 | 结论 |
| --- | --- | --- | --- | --- |
| 50,000,000-byte 流式接收 | 合成确定性字节模式，seed 17；精确 50,000,000 bytes；SHA-256 `eacbeef07b2a206b619d1c15c74eacb4dc5f02e31fc75d2f780a3ddb41cbb253` | `results/spike-results.json`、`raw/11-bounded-spike-retry.log` | 959.367224 ms；峰值 RSS 126,042,112 bytes；RSS 增量 31,924,224 bytes；未完整重缓冲 | Pass |
| 10,000 条首屏预览 | 10,000 条合成 Source Record | 30 样本；`results/spike-results.json` | nearest-rank P95 2.51046 ms ≤ 3,000 ms | Pass |
| 10,000 条结构化筛选 | 10,000 条合成 Source Record；500 rows/batch，20 batches | 30 样本；`results/spike-results.json` | nearest-rank P95 1.241791 ms ≤ 5,000 ms | Pass |
| 5 资产 / 100,000,000 bytes / 10,000 条 | seeds 31-35；5 × 20,000,000 bytes | `results/spike-results.json`、`raw/12-independent-verification.log` | 精确 100,000,000 bytes、10,000 条 | Pass |
| 10,000 条 / 最大 100,000,000-byte `items.jsonl` 提交 | 10,000 条正式记录；精确 100,000,000-byte JSONL | 20 样本；`results/spike-results.json`、`raw/13-candidate-stream-validation.log` | nearest-rank P95 2,312.371229 ms ≤ 120,000 ms；峰值进程 RSS 149,192,704 bytes | Pass |
| 批次取消 | 500 rows/batch；完成 2 batch 后请求取消 | `results/spike-results.json`、`raw/10b-cancel-repro-green.log` | 0.857243 ms；事务回滚、对象不存在、领域可见状态不变 | Pass |

## 6. 最终 Gate 结果

| 项目 | 结果 |
| --- | --- |
| 最终状态 | **Passed** |
| 执行日期 | 2026-08-18（执行窗口 08:12-08:25 UTC） |
| 执行与决定角色 | Project Owner / Sole Developer |
| 结论依据 | `results/gate-machine-report.md` 与 `results/verification-summary.json`；机器可验证项全部通过，证据清单 SHA-256 复核通过；Tailscale 路径为 Owner-confirmed assumption |
| Ticket 01 后续状态 | Gate 阻断已解除；Ticket 01 已完成。后续 Ticket 不因本 Gate 自动开始 |

通过规则：第 4 节全部必需项均有可复查证据且满足阈值，才能标记 `Passed`。任一必需项失败、缺证据、影响其他项目或无法证明隔离时标记 `Failed`，Ticket 01 继续阻断。

无论 `Passed` 还是 `Failed`，本记录都不能被解释为 Production Gate、生产批准、敏感数据批准、备份能力或合规背书。
