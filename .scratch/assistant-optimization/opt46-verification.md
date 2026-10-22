# OPT-46 实施与定向验证记录

日期：2026-10-22。Implementation completed；Validation targeted-pass；Owner pending。任务与可观察标准见[OPT-46](issues/46-compact-plan-amendment-and-recovery.md)，本记录是本票验证证据的唯一汇总。

## 1. 固定范围与版本

- 开发仓库：服务器 EvalBase 的 agent-data-processing 工作树，分支 codex/assistant-optimization；本地 AgentBench_v2 仅作受限审阅镜像。
- 固定开发基线：debe663。实现提交：625c44ab47e9222d86d98965de30091062a9ef2a；组合故障回归提交：68d399b7b0f2430746fae9af2c28ae8843f9af5b。
- 未更新4217、未合并、未推送。4217仍为既有6c2cd08。本票不宣称第7项真实模型验收通过；真实普通提示CU统一由OPT-50另行授权执行。
- 全部自动回归用合成HTTP模型与唯一测试数据库；浏览器用独立4196预览及模拟业务接口。没有向真实模型发送请求，没有操作Owner数据库、旧任务或已关闭额度。

## 2. 已接入机制与兼容边界

| 接口 / 调用方 | 实际变化及保留边界 |
| --- | --- |
| plan-request.preparePlanAmendment → agent.prepareStep | 同一事实准备器输出增量Schema、基准修订、目标事实和是否需要补读；存在附件不再自动进入完整首次创建规划。已明确的局部目标排除其他交付详情；无法定位时只提供身份摘要，不猜造身份。 |
| plan_task → reviseDeliveryGoals | 真实id关联已有交付，服务端合回未改场景、分类、配额并完整验证。合法完整输入仍能接受；明确新增独立测试集时保留无id创建分支，由服务端生成身份，增加记录/场景不授权另建交付。 |
| read_background → 增量与截断请求 | 分类/依据变化可在原调用和时间限额内补读；当前目录及本轮已成功、版本匹配的读回进入紧凑事实。只改名称并保留分类时不开放多余读取。 |
| 核对事务 → requirementCheck | 仅精确可证的类别名称集合、单交付名称或数量支持本地核对；权限、当前修订、完整规则及背景有效才写真实核对回执。未知语义、矛盾要求和实际变更不冒充已满足，不伪造方案变更。 |
| planVerificationCurrent → feedback / receipt recovery / finish | 共享当前修订、要求哈希、背景版本判定。背景变化或删除后的旧核对不能继续显示为有效；提交结果不明时按原回执对账。 |
| repairRequestAvailable → recovery / 消息 / retry / frontend | 相同修改身份沿用2次额外纠正、其中1次截断；普通继续使用剩余额度。耗尽时不再请求模型，消息与按钮返回同一明确中文原因，前端保留输入。 |

移除了“有附件就重放整份规划”的宽泛入口；旧非contractVersion=1步骤合同仍保留。没有引入第二份生效计划、新修复循环、依赖库、数据表或预算加额功能。frontend-v1及现有页面布局/组件样式未变，前端只使用服务端已确认的恢复原因。

## 3. 定向验证

### 最终闭环用例（86个不同用例通过，不累计重复执行次数）

| 组别 | 数量 | 实际结果及日志 |
| --- | --- | --- |
| 新OPT-46公共入口回归 | 19 | 已满足三种事实、未知/矛盾拒绝、增量截断、普通继续、共享耗尽、回执恢复、背景变化、补读后截断、合法混合新增、禁止把增加记录/场景当新增、局部目标收缩、删除附件刷新及口头答复→截断→保存均通过。最后18项在opt43-logs/opt46-addition-green.log及opt46-final-boundary-units.log；组合链在opt46-oral-truncation-chain.log。 |
| 受影响的两个完整输入兼容案例 | 2 | document delivery amendments / context replanning，通过；opt43-logs/opt46-final-boundary-units.log。 |
| 交付领域与接口接缝单测 | 31 | 全部通过；opt46-verification/delivery-unit-closure.log。 |
| 恢复公开入口与并发/权限围栏 | 32 | 全部通过，含双重claim、修订过期、已提交/响应丢失回执、停止/背景变化后迟到修正、撤权及原额度保护；opt43-logs/opt46-recovery-closure.log。 |
| 浏览器定向回归 | 2 | OPT45失效恢复入口刷新及新增OPT46普通继续显示真实repair_limit并保留输入，通过；opt46-verification/browser-with-fonts.log。 |

各次完整输出及退出码保留在本工作树的opt43-logs/与opt46-verification/，不把外层启动脚本的退出码当Vitest结果。组合链直接观察四次实际请求、共用两次纠正、最后仅plan_task且没有坏参数重放；正常成功和自动纠正成功在各测试脚本中分开断言。

### 过程失败及修正

- 原始已满足要求继续走模型、截断修复仍要求完整交付、截断专用额度用完却提供继续、核对回执丢失不能恢复、未知语义误核对及恢复少计原纠正次数：先由公共回归复现，再分别修正，red/green日志保留。
- 扩展合同回归初次216通过/3失败。两个完整更新兼容失败已修复，13项定向复测通过；另一个未改动的assistant-execution-plan单测失败见下节。
- 双轴审阅发现补读被强制plan_task阻断、广告Schema不能新增、无关交付重放及背景核对投影不一致；均有公共回归及定向关闭。收紧新增保护时又复现“增加记录/场景误建测试集”，两项负向回归先失败后通过。
- 扩展191用例检查190通过/1失败：只改名称但“分类保持”仍开放read_background。改由事实准备器按实际变化判断后，该项及18项OPT46用例均通过。无需重跑已通过且无受影响路径的用例。
- 浏览器最初受旧目录EACCES、缺少共享库及字体配置阻挡，均未完成业务断言。使用全新输出目录及服务器既有浏览器库/字体配置后两项通过；未删除/改权限旧目录，也未安装新依赖。独立预览已按精确PID关闭。

## 4. 静态结果与已知限制

- 根TypeScript、服务端编译、frontend-v3类型检查、独立前端生产构建、变更后端/集成测试ESLint与git diff --check通过。
- 前端组件ESLint零错误，有原有useEffect setPicked依赖警告；整份旧浏览器测试文件仍有8处原有no-explicit-any错误。本票新增浏览器测试无新增该类问题，没有借此修改旧fixture。
- 较宽检查中，未修改的tests/unit/assistant-execution-plan.test.ts “keeps a waiting real run until that exact run completes”仍失败：current期望1、实际3。用git archive固定基线debe663后同一用例同样失败（6通过/1失败），见opt46-verification/baseline-execution-plan.log。未将其改为通过或静默跳过，不宣称仓库全量测试全绿。
- 本票只核验可证结构与恢复机制；任意自然语言理解、真实模型质量、真实模型延迟及整批第7/10项业务验收不在上述通过结论内。

## 5. AC与共享调用链收尾

| AC | 对应证据 / 结论 |
| --- | --- |
| R46-1 | 三种事实核对有真实回执、刷新有效、原方案不变、零生成；通过。 |
| R46-2 | 名称/数量完整兼容、单交付及多交付局部更新、合法新增广告Schema、领域完整校验；通过。 |
| R46-3 | 口头答复后截断组合链及实际Schema/工具/字节范围检查；通过。 |
| R46-4 | 连续截断耗尽、原额度内普通继续、消息/retry相同拒绝与原计数保持；通过。 |
| R46-5 | 核对响应对账、背景版本/删除及既有共享写入围栏32项；通过。核对提交使用会话锁、turnFence、权限与文档共享锁，未新增旁路写入。 |
| R46-6 | 新建、合法完整更新及旧步骤Schema兼容；历史不迁移、不复写；通过。 |

Standards与Spec最终定向复核均关闭命名发现，无剩余P0/P1；不是新增一次全量审阅。局部新增/修改仍走同一服务端验证，不依赖模型按顺序正确调用。错误/停止/撤权/重试分支沿用原围栏，结果不明先按回执对账。

## 6. 验收资源与旧预算保护

自动测试各自创建唯一assistant_intent/assistant_recovery测试数据库，结束后释放；没有克隆旧失败任务规避限额。原batch1-repair/semantic-results.json的预存未提交变动及全部旧验收目录未纳入本票提交。

开工与收尾对所选6份历史预算文件做SHA-256比较：全部一致，checkedFiles=6、changed为空。具体路径/哈希和结果保留在opt46-verification/old-budget-fingerprints-before.json、old-budget-fingerprints-after.json与protection-result.json；该结论仅针对这6份文件，不冒称已扫描全部历史资源。旧248/400条、已完成CU和旧预算均未重跑/重置。

OPT-47～50尚未实施。OPT-48可复用本票准备接口，OPT-49后续处理明确预算追加，OPT-50再统一页面与有界真实模型CU。Owner人工验收pending，OPT-31原内容质量结论保持。

## 7. 后续独立授权：更新4217与CU-7

Owner随后单独授权提前更新4217并复测CU-7。实际环境9108569、首次规划失败、5次请求/14813ms、两次自动纠正失败及一次普通继续409，未到达本票的已保存方案核对/修改真实终点，旧数据/预算保留。见[本轮唯一记录](opt46-cu7-verification.md)。以上未部署/未真实CU描述仅指最初开发交付时；受控自动回归结论不代签真实验收，CU-7未通过。
