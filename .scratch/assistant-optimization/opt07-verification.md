# OPT-07 开发验证

2026-10-08（Asia/Shanghai）。范围为 [OPT-07](issues/07-execution-and-recovery.md)；批次、授权和最终 checkpoint 见 [Spec](spec.md)。本记录只覆盖本张的执行及恢复，不代签最终 Owner 验收。

## 起点与交付边界

- 工作区 `/home/bistu/EvalBase/.worktrees/agent-data-processing`，分支 `codex/assistant-optimization`，起点 `2e9081e`；应用及测试提交：`9027332f3b1db8610479e14e3aad6cb64efcb5ef`。
- `reused`：现有 `/assistant/sessions/:sessionId/turns`、会话读取/status、stop/retry、proposal confirm，以及 processing-runs 提交、读取/status、refinements、retry、accept。业务工具继续调用相同权限和事务守卫；没有新增或退役公开路由、数据表、迁移、通用 DAG、第二调度器或依赖。
- 只修改当前步骤推进、实际回执恢复、成果兼容核对及现有任务卡的必要反馈；候选审核完整体验和最终综合交付留给 OPT-08。冻结原型和 frontend-v1 未修改。
- Owner Web 仍为 `evalbase-agent-checkpoint:65a5055e2226`，端口 4217；model-worker 为 `b19c0050d6f0`，worker 为 `65c10e9b6839`。本张不切环境，保留原会话、失败任务、资料和历史 200 条版本。测试项目/账号只存在于一次性隔离库，不增加长期验收项目。

## 实现与验收证据

| 编号  | 本张实际验证                                                                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R07-1 | 来源 A 的执行步骤读取 B 不推进；偏移或条件只覆盖一部分不能代表全量；正确来源/范围作对照。后台提交绑定实际 run 并等待终态，采用/发布绑定实际 proposal/领域提交回执。内部稳定步骤及参数不依赖模型 tool-call ID                           |
| R07-2 | 查询预算让出后，现有调度器自动推进已固定步骤，草稿只创建一次；固定业务读取/核对不消耗额外模型调用。无进展、停止和既有限额继续生效；普通步骤完成使用服务端实际进度摘要，不声称出现不存在的候选                                          |
| R07-3 | 真实处理/草稿事务已提交而回包丢失时先查回执；校验失败不冒充旧成功，也不覆盖旧意图。重复恢复复用原 run/草稿/候选；局部缺失仅恢复缺失批次；模型回复失败保留成功操作、用户输入和重试入口                                                  |
| R07-4 | 要求变化撤销后续执行及待确认资格；变更参数不能重放冻结成功/started 操作。旧来源成果不能按新来源采用，`allTask` 不授予来源资格；当前明确来源集合可接受其实际子集，草稿/版本仍精确匹配。旧响应、停止、撤权和来源失效继承实际提交 fencing |
| R07-5 | 公开 Worker→分类→固定选取→局部调整，以及补足/部分采用等既有组合通过；选取不重新展开来源。采用前复检当前保护字段及 Metadata 键，大小写规范化后再求交集；缺额、缺类和六独立来源超限不能以聚合文件绕过                                    |
| R07-6 | 两项 OPT-06 记录的基线恢复失败已修复，21 项任务恢复回归全部通过。旧资产页 `asset` 来源按真实身份兼容 `assets` 输入；A 可恢复，B/无来源不能冒认 A 完成，A→B 更正仍需当前核对。原成果、配方、候选及已采用身份保留                        |
| R07-7 | 正式浏览器检查生效要求、后台等待、模型回复失败、输入保留、原提交重试和桌面/420px 窄窗口。页面区分回复失败与处理失败，显示已有真实运行；混合模型文字和入队工具调用时只显示服务端阶段，不采用模型的“已完成”文字                          |

首个 red 是公开 HTTP/真实 SDK 的错误来源回执仍推进步骤；随后用相同入口验证正确来源和样例/全量边界。新增回执参数、过滤条件、当前来源与保护字段的 red/green 在同一公开入口验证；单元检查只是补充，不代替调度路径。

## 自动检查与限制

实际命令及原日志 SHA-256 见 [检查记录](opt07-checks.txt)，未修改的原始日志及审阅补丁保存在 [证据归档](opt07-evidence.tar.gz)。以下命令在上述工作区运行；Node 为服务器已有 v24.20.0，测试使用独立 PostgreSQL/MinIO 和可控模型端点，没有使用 Owner 数据库。

```sh
./node_modules/.bin/vitest run tests/integration/project-assistant.test.ts
./node_modules/.bin/vitest run tests/integration/assistant-tasks.test.ts tests/unit/processing-review.test.ts tests/unit/assistant-plan.test.ts
./node_modules/.bin/vitest run tests/integration/project-assistant.test.ts -t 'does not hide six|continues an authorized'
./node_modules/.bin/vitest run tests/integration/project-assistant.test.ts -t 'does not hide six|keeps adopted candidate|reviews two runs|reflects an exact processing-page|supplementing and adopting|classifies in the worker'
npm run typecheck
./node_modules/.bin/eslint src/assistant/agent.ts src/assistant/store.ts src/assistant/plan.ts src/assistant/fence.ts src/assistant/review.ts src/processing/review.ts tests/integration/project-assistant.test.ts tests/integration/assistant-tasks.test.ts tests/unit/processing-review.test.ts
npm --prefix frontend-v3 run typecheck
npm --prefix frontend-v3 run lint
npm run build
./node_modules/.bin/tsx .scratch/assistant-optimization/opt07-real-probe.ts
npm run docs:check
git diff --check
```

- 恢复文件 21 项、候选核对 9 项、有序计划 3 项，共 33 项通过；包括原两项基线失败。源/参数/范围/预算/兼容性修复另有定向公开回归，记录具体运行及跳过数，不将跳过项写成通过。
- 助手公开接口全文件最终一轮 102 项通过。随后补齐单批/显式候选采用的当前来源与字段守卫，首次公开反例复现旧卡仍生成；修复后仅重跑直接受影响的多批、部分采用、固定选取/补足和分类组合 8 项，全部通过、94 项未重跑。最后类型标注修正后再次通过类型/lint/服务端编译；不将修改前的全文件运行声称为修改后的全量回归。
- 早期四文件整合有 130 passed、3 failed；分别为旧预算读取缺少来源、六来源聚合缺少当前明确来源声明，以及分类组合旧游标断言。前两项补真实公开来源/回执并修复产品边界，第三项按新有效计划断言；原失败日志保留，最终结果以检查记录为准。来源反例测试中的回合状态/强制核对脚本也经调整，业务采用拒绝和真实来源容量断言均保留。
- 助手浏览器原 16 项通过；新增回复失败截图的初次 fixture 缺少 goal，补齐后相关 4 项通过。最后截图 fixture 补真实更新时间，再跑 1 项通过。截图已视觉核对：[桌面](opt07-recovery-desktop.png)、[窄窗口](opt07-recovery-narrow.png)。Playwright 使用服务器已有 `mcr.microsoft.com/playwright:v1.62.1-noble` 临时容器，限制 1 CPU/1 GiB；未改服务器系统字体。
- 根和正式前端类型、受影响 lint、正式前端与服务端构建通过；前端有 9 条原有 warning，无 error。最后后端修复再次跑类型、范围 lint、服务端编译。文档检查不生成未改变的 Mermaid/PNG。
- 未运行无关全仓库 E2E、全量性能/安全/持久化套件、5/10 人压力、两小时稳定测试或万条真实分类。所选证据覆盖共享执行/恢复正常路径及来源、参数、确认、幂等和 fencing 边界；最终通用场景矩阵、原 200 条失败任务恢复与 Owner 环境切换由 OPT-08 交付。

## 有界真实模型验证

`opt07-real-probe.ts` 使用已有模型配置，但密钥不写入源码、报告或日志；所有处理数据和账号均为一次性隔离库中的合成内容，结束后关闭服务并删除该库。

同一会话的用户输入只有两条：

1. “按附件给当前资料设计分类方案，先不执行。”
2. “执行方案。”

真实 MD 背景、六条记录经实际 Worker 分类并完成全量核对；原问题、期望输出和原 Metadata 均保留，只新增类别。最终结构核对为 6/6 complete；对费用/进度类别逐条核对语义，另对同名资料验证必要澄清且不索要内部 ID。未点击采用或发布，无正式版本。

最终运行的自动后续为 8 个模型步骤、8 次工具调用，约 23.096 秒；期间一次采用准备未通过守卫，模型在同一会话自行核对/修订后形成正确确认提案，操作者未追加技术提示。不是声称首次全部工具调用成功，也不能证明所有任务或 200 条内容已经完成。早期探针的 SQL 列名、密码确认和类别名称判定等脚本问题已修正并保留日志；不作为产品缺陷或用户成功次数。

## 审阅与交付

Standards/Spec 按固定起点分别审阅，发现的参数冻结、当前来源、完整范围、确认身份及 Metadata 键问题均修复并有定向复核。最终来源集合不由 `allTask` 扩权；后台及确定性步骤的成功文字只来自实际阶段。最终窄复审及固定提交记录见检查记录。

本张解锁 OPT-08，但不授权开始下一张。OPT-05 和整改批次最终人工 checkpoint 仍 pending；没有合并 main、推送 GitHub、打 tag 或正式部署。
