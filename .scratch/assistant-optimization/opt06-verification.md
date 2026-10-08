# OPT-06 开发验证

2026-10-08（Asia/Shanghai）。本张仅实现目标理解与生效要求管理；[Ticket](issues/06-active-requirements.md) 定义范围，[Spec](spec.md) 定义一个最终 checkpoint 的批次约定。

## 起点与交付边界

- 远端工作区 `/home/bistu/EvalBase/.worktrees/agent-data-processing`，分支 `codex/assistant-optimization`，开发起点 `c711a8f`，应用及测试提交 `08356cb4946ff5b6c601c5625296feb5d8a6ff3e`。
- 复用会话回合、读取、背景工具和处理提交/重改入口，均为 `reused`。无新增公开路由、数据表、迁移、调度器或授权方式。
- Owner 验收 Web 镜像仍为 `evalbase-agent-checkpoint:65a5055e2226`，端口 4217。本张不切环境；原资料、失败会话、历史 200 条任务和版本保留。测试使用一次性数据库、合成项目/账号、自动测试 MinIO 与小量真实模型，未创建新的长期验收项目。

## 实现与证据

| 编号 | 当前证据 |
| --- | --- |
| R06-1 | 真实模型以“按附件给当前资料设计分类方案，先不执行。”读取真实 MD 背景及当前草稿；另以“把「同名资料」的问题改写得更简短。”对两个同名草稿澄清，无处理运行或采纳提案，不索要内部 ID |
| R06-2 | 公开 HTTP/SDK 验证仅替换 Metadata 后保留期望输出规则、显式撤销、省略保留、字段权限冲突及受保护来源值不相容；处理提交前拒绝，原记录未改 |
| R06-3 | 上述计划回合无处理运行或确认提案；“执行方案。”提交真实处理运行，不增加开工确认。六条候选仅新增类别，问题、期望输出和原 Metadata 保留 |
| R06-4 | 服务端由当前结构生成摘要，刷新后与下游核对一致；新配方冻结当前摘要及规则。简单处理未声明全任务目标时，仅显示同修订运行的本次事实；撤销后旧运行及成果保留，但旧数量/说明不再回填。浏览器检查具体冲突、键盘展开、输入保留及桌面/420px 窄窗口 |
| R06-5 | 旧 `allowedLabels` 按期望输出允许值读取，不回写旧会话；旧矛盾反馈后保留原状态。新模型工具只填写 `classifications`，旧持久意图仍可兼容读取；旧运行配方保持原提示分支，背景不增加权限 |

首个 red 通过公开会话设置两字段规则、仅更正 Metadata，旧实现丢失期望输出规则；第二个 red 证明已有“仅改 Metadata”要求仍能提交问题改写。两者均在同一公开入口变为 green。后续受保护来源值、旧规则冲突和配额检查沿用同一入口；未以私有模块测试替代公开证据。

## 自动检查

以下为本次直接检查；日志摘要与原日志 SHA-256 见 [检查证据](opt06-checks.txt)，截图见 [桌面](opt06-requirements-desktop.png)、[窄窗口](opt06-requirements-narrow.png)。未声明全仓库回归通过。

已完成的直接检查：

- `npm run test`：27 个单元测试文件，159 passed、1 skipped。
- `vitest run tests/integration/project-assistant.test.ts -t 'keeps independent|rejects processing that contradicts|reads legacy|rejects a protected source'`：6 passed；另 84 项不属于该定向运行。
- 修复阶段 `vitest run tests/integration/project-assistant.test.ts`：90 passed。之后新增规范化及最终配额/覆盖投影回归；最终全文件共有 95 项，针对受影响行为运行 `-t 'normalizes inherited Metadata|keeps independent|rejects processing that contradicts|reads legacy|rejects a protected source|checks only the provable|requires structural review'`：12 passed、83 skipped。前一轮含背景/分类选取/补足的定向回归为 20 passed、75 skipped；最终修复只改运行事实的修订绑定，不改处理执行。
- `vitest run tests/integration/processing-runs.test.ts`：受影响整合运行中 11 项全部通过。
- 助手浏览器 `playwright test e2e/project-assistant.spec.ts`：16 passed；新增摘要用例核对桌面/窄窗口和刷新。
- 根与正式前端 typecheck、受影响后端 lint、正式前端 lint、前端构建通过。
- `tsx .scratch/assistant-optimization/opt06-real-probe.ts`：实际配置的 Qwen 模型、6 条合成记录、真实背景、计划/执行分离、同名澄清通过；一次性数据库已清理。该脚本仅只读取得已有连接配置，密钥不写入报告或测试日志。
- 撤销后旧说明回填的公开 HTTP red 确认复现；同一入口 green 验证撤销、旧 runId 保留和刷新一致。最终根 typecheck、受影响 lint、`git diff --check` 均通过；文档检查通过。

服务器原生 Chromium 缺少可用字体配置而无法启动；验证改用服务器已有 Playwright 镜像，限制 1 CPU/1 GiB，独立临时浏览器容器，未修改系统库。测试运行中的状态竞态由新测试等待自动完成核对消除，没有为测试更改产品的恢复逻辑。

## OPT-07 接续问题

`tests/integration/assistant-tasks.test.ts` 的下列两项恢复测试在本张整合检查失败，并在起点 `c711a8f` 的独立源代码对照中同样失败（21 项中 19 passed、2 failed）：

1. `binds automatic inspection to the current run and preserves a retry follow-up`
2. `links a processing receipt before post-commit reporting, and durably stops its queued job`

两项属于 OPT-07 的后台回执与恢复范围。保留失败及基线对照证据；本张不将其描述为已修复或全仓库回归通过。OPT-07 必须将它们纳入接续验证。

## 审阅与环境

### Standards

独立代理按固定起点 `c711a8f` 审阅；Metadata 键规范化绕过已修复，并由公开保存→提交验证。最后旧运行说明回填的问题由创建回合修订绑定关闭；复审通过，公开撤销回归 green。无本张未关闭发现。

### Spec

独立代理核对 R06-1–5；完整目标配额需考虑保留记录、同源改写的身份投影，以及新增槽位能否覆盖缺失类别，相关问题已修复并有公开正反回归。单批不能代表完整目标时保留后续核对，不提前拒绝正常中间批次；来源未知时不声称已证明内容合规。最后撤销后旧数量/说明回填问题已通过修订绑定及公开 green 关闭。无本张未关闭发现。

Owner Web 仍为 `65a5055e2226`，model-worker 为 `b19c0050d6f0`、worker 为 `65c10e9b6839`；Web/数据库/对象存储健康。临时浏览器已移除，一次性测试数据库已清理；原长期环境没有重建。真实模型验证仅覆盖有限短请求及六条分类记录，完整通用闭环、原失败会话恢复和最终人工 checkpoint 仍由 OPT-07/08 承接。

本张实施完成，OPT-07 依赖已解除但尚未开始；最终人工 checkpoint 仍为 pending，OPT-05 未完成状态不变。本张不合并 main、不推送 GitHub、不打 tag、不正式部署。
