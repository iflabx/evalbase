# OPT-20 验证记录

## 范围与固定版本

- Ticket：[OPT-20](issues/20-assistant-diagnostics-and-baseline.md)。Owner 于 2026-10-14 单独授权开发；沿用 `codex/assistant-optimization` 和 `/home/bistu/EvalBase/.worktrees/agent-data-processing`。
- 实施基线：`16c63a76d9a022acbeceb46e15ec832d64ad0ebd`；固定代码：`f56690915672a3f8b45bee6822c36498d10b6115`。
- 本张交付失败诊断、现有错误区的可行动反馈及短请求测试入口。未增加表或公开 API；诊断存入现有任务 JSON/回合 observations。
- Implementation completed；Owner 人工验收 pending。后续整改 Ticket 保持各自状态。

## 实现与安全

模型请求边界只记录 HTTP 状态、耗时和错误类别。错误对象仅瞬时用于确认来源，应用连接异常不能冒称模型错误。Agent 根据可信业务回执区分参数、领域冲突、权限/来源、内部异常与预算暂停；失败反馈包含原因、已保留成果和下一动作。

诊断关联现有回合/会话 ID、任务修订、代码/模型配置/提示和工具版本、步骤、请求尝试次数及结束原因。待用户确认的卡片不计为已完成数据操作；候选数无法确认时为 null。诊断不存异常文本、响应正文、完整提示、业务数据或凭据。读取仍由原会话/来源权限保护。

UI 沿用 frontend-v1 的现有错误文字和折叠明细，正常消息不增加诊断展示；旧无诊断回合明确显示“没有详细诊断”。对齐记录见 Ticket。

## 定向检查与审阅

- 新诊断回归先失败，实施后通过。最终诊断单测 9 项、定向公开 HTTP 15 项通过；HTTP 包含 429/503/401、网络失败、JSON/结构错误、成功写入后汇报失败、待确认未执行、应用普通异常/ECONNRESET/TimeoutError，以及原创建/发布幂等和权限路径。
- 失败响应使用敏感文本 canary 核对脱敏。应用异常没有被模型的旧 finish reason 覆盖，实际回执仍可核对。
- 1 项定向 Playwright 流程通过：简短原因/动作、折叠详情、保留数量、旧会话回退与 860px 无整页横向溢出。使用既有浏览器运行库，临时 Vite 缓存目录避开旧缓存权限问题。
- 根和 frontend-v3 typecheck、受影响后端/测试/脚本的 ESLint、`git diff --check` 通过。固定代码构建与文档检查结果在下节记录。
- Standards / Spec 独立审阅发现并修正：待确认卡片计数；应用传输异常误归模型；基线 A1/A7 成功断言不足；广义恢复计数口径不实。相关回归通过，定向复核无剩余 P0/P1。
- A3 的独立可控运行依赖旧测试中的创建与发布夹具；脚本明确带上这两项前置条件。初次夹具缺失不计为模型失败。

## 短请求基线

统一入口：[scripts/assistant-baseline.ts](../../scripts/assistant-baseline.ts)。支持 `--cases=A1,A5` 等选择和串行有限运行，无额外评测服务。

```powershell
# 已配置隔离测试 PostgreSQL / MinIO 环境后执行
$env:GIT_SHA = 'f56690915672a3f8b45bee6822c36498d10b6115'
node --import tsx scripts/assistant-baseline.ts --mode=controlled --cases=A1,A9 --output=.scratch/assistant-optimization/baseline-controlled.json
```

真实模式使用同一入口 `--mode=real`；须提供 `BASELINE_MODEL_FILE`（权限受限的加密模型连接行 JSON）、对应 `MODEL_ENCRYPTION_KEY` 和隔离测试数据库/对象存储配置。脚本自行创建 UUID 数据库、桶及合成资料，结束后仅清理本次资源。`BASELINE_SOURCE_ROOT` 可指向固定旧源码快照；不要将 Owner 数据库 URL 当作测试配置。实测服务器使用本张临时运行器从既有测试容器读取配置，模型连接只读复制到临时私有文件并删除，不修改 Owner 资料。

可控模式核对已有公开接口合同，`goalCompleted=null`；它不能代表真实模型任务完成率。真实模式核对数量、固定范围、字段保护、候选身份及真实采用/发布回执。报告只保存白名单指标与输入哈希；`automaticRepairs`、未观测的人工语义纠错为 null，`protocolRepairs` 单列已测协议纠正次数，语义审核另记 pending。

修复前样本使用基线 `16c63a7`、`qwen3.8-27b-un`、模型配置修订 1 和固定 8 条合成输入。原四案例见 [原始小样本](opt20-before-real.json)：A2 方案后执行、A4 扩写达成结构/范围目标；A5 选中两条改写未满足范围目标，回合完成不能代替业务目标完成。A1 原统计断言不足，以最终脚本的 [严格 A1 复测](opt20-before-a1-strict.json) 为准，真实来源/数量/字段均通过。两份报告保留各自案例定义哈希，不混算为总体成功率。

固定代码的 [A1–A10 可控结果](opt20-controlled-fixed.json) 为 10/10 合同通过；[真实 A1 结果](opt20-after-a1-real.json) 核对来源、8 条数量与字段通过，1 次用户提示、0 次协议纠正，记录 2 次实际模型请求。一次小样本只用于暴露问题和后续比较，不证明一般内容质量或稳定成功率；A5 的业务范围问题由后续契约整改承接。

## Checkpoint 与数据保留

固定代码 Docker 构建通过；初次命令的 `--cpus` 不被当前 build CLI 接受，改用等价 `--cpu-period/--cpu-quota` 限制 1 CPU、2 GB 后成功，应用代码未变。沿用 `evalbase-agent-owner-checkpoint`、`agent_owner`、`agent-owner-checkpoint` 和 `127.0.0.1:4217`，仅更新 Web，镜像 `evalbase-agent-checkpoint:f56690915672`。

`/health` 与 `/health/ready` 均正常并返回固定 SHA；普通 Worker / model-worker 保留 `4af93adaeda7609e3177fe2013e4091d6320acdc`，两个服务和数据库/对象存储容器身份、挂载未变化。16 张 Owner 表切换前后数量及内容指纹完全一致，切换前另保存权限 0600 的数据库备份。保留 2 个账号、18 项数据资产、17 个草稿/1548 条草稿记录、62 个处理任务、14 个助手会话/107 个回合、8 个正式版本等既有数据。

实际 1440px 浏览器读取当前处理列表和最新助手会话均为 200/可见，1 个旧失败回合的无诊断说明可展开，未发送新消息或采用成果；仅登录/登出，0 个页面异常。前端请求命中上述 4217 后端，输入保留正常。

本地 SSH 转发继续使用原访问方式；Owner 人工验收另记。

## Owner 验收

1. 在 4217 打开项目助手，查看现有失败回合：旧无诊断记录应能正常读取，展开详情不编造原因。
2. 在测试会话正常查询资料，成功消息不增加常驻技术信息；查看操作记录与真实成果仍正常。
3. 后续新失败回合核对简短原因、下一动作和展开的诊断编号；请保留编号用于定位，不将待确认卡片视为已执行。

429、网络断开等故障已用隔离假模型验证，Owner 环境不需要改坏模型配置来重复制造故障。人工验收独立记账。

## 证据索引

详细日志在本机/服务器 `.scratch/assistant-optimization/` 保留：`opt20-red.log`、`opt20-review-fixes-green.log`、`opt20-static-final.log`、`opt20-final-static.log`、`opt20-browser-final.log`、`opt20-before-a1-fixed.log`、`opt20-controlled-fixed.log`、`opt20-code-build.log`、`opt20-code-build-fixed.log`、`opt20-after-a1-real.log`、`opt20-checkpoint-switch.log`、`opt20-checkpoint-identities.log`、`opt20-checkpoint-browser.log`。固定代码和文档提交分别记录；既有验收数据与历史 Ticket 状态保持原记录。
