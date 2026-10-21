# OPT-44 实施与定向验证

## 1. 固定版本与结论

- 日期：2026-10-22（Asia/Shanghai）。范围：[OPT-44](issues/44-resume-decision-and-budget-continuity.md)，阶段 B。
- 仓库：服务器 EvalBase 隔离工作树，分支 codex/assistant-optimization。
- 开发基线：eb08e13c04d5e683a3b035154c8856b34f469b6e；实现：7502523906de49c2f409e2a20a24bf6972ea40db。
- Implementation completed；Validation targeted-pass；Owner pending。161 个不同定向用例通过，重复执行不累计。受控故障的正确停止与真实用户交付完成分开。
- 4217 Web/model-worker 仍为92492e7a7b2a；未部署、未合并/推送、未打tag。OPT-45未实施，五项Computer Use与真实模型可靠性未宣称通过。

## 2. 机制与责任落点

| 责任 | 权威实现 | 直接调用者及旧分支退出 |
| --- | --- | --- |
| 恢复动作/拒绝原因/修订/有效期 | src/assistant/recovery.ts 的 recoveryDecision | store.assistantRecovery载入当前权限、依赖、背景与轮次事实；读取readSession、普通继续、结构化执行、controlAssistantTask、claimAssistantTurn、queueContinuation、执行请求preflight/turnFence共同使用 |
| 活跃区间与累计高水位 | budget.ts 的startActiveBudget/settleActiveBudget/checkpointExecutionBudget | agent检查点、终止结算、领取和停止在现有session/token边界扣增量；不再按原startedAt到当前的墙钟时间重复扣等待 |
| 同段/新段排队 | tasks.queueRecovery | 同段保留原turnId、startedAt、deadlineAt；新段关联parent/root、原修改身份、累计消耗、故障与传输偏移，不重置旧段 |
| 实际业务回执 | 现有receipts/业务工具；savedPlanningQuestion共享澄清收尾判据 | 未知写先按operation key查原回执，实际已完成的同名不同步骤不被误判为参数重试；只执行余下步骤 |
| 无进展停止 | 单调progressFacts哈希集合、保存回执与步骤事实 | prompt裁剪不再制造进展；仅有过期时间不构成新段授权；同一旧保存回执不能反复续段 |
| 普通继续的信任边界 | store.startTurn | 公共修订校验先于早返；恢复请求key/hash与实际turn映射同事务保存，完成态重放不新增费用；最多100条，不淘汰旧幂等记录 |

服务端旧的仅凭deadline/三次尝试/continuationAllowed各自判资格的分支已由共享决策替代；底层业务权限、范围、确认和租约校验保留。canRetryTurn/canContinueExecution是同一能力的兼容投影；canResumeAssistantTurn仅保留纯兼容适配，实际服务端入口不再调用它。不新增表、公开路由、恢复服务或调度框架，前端样式未改。

新段窗口最多80000ms且不超过剩余累计活跃额度；累计130模型/156工具/26传输/1040000ms与更小冻结额度保留。异常冻结额度不回退放大。同一业务修改跨段继承OPT-43修复身份、最多2次修正及原故障尝试；无进展、超限、背景/权限/修订失效不发无效请求。最后已预留的合法请求/提交可以在上限内完成，不能以此再申请新请求。

## 3. 定向证据与计数

日志在本执行机 .scratch/assistant-optimization/opt43-logs/。名称保留早期runner目录，不表示只验证OPT-43。

| 最终有效证据 | 不同用例 | 结论 |
| --- | --- | --- |
| assistant-recovery-decision 23项；clarification-units.log | 23 | 请求预留边界、旧证据/修订/授权、无进展、活跃扣账、冻结额度、最后预留步骤、真实澄清回执正反通过 |
| execution-budget 5项；budget-final-green.log | 5 | 单调增量与累计上限通过 |
| transport 11、transport-deadline 2、continuation 12、diagnostics 16；final-units.log | 41 | 同请求传输上限、请求前复检、检查点与首次失败保留通过 |
| assistant-recovery HTTP/SDK/持久化；final-public.log | 26 | 读取→控制→领取→执行→结算→重读、双击、完成重放、未知写、迟到响应与真实Worker完成通过 |
| assistant-continuation 持久事件；final-public.log / events-second.log | 8 | 冻结事件额度、重复事件、停止/撤权/旧修订、最终确认零新段通过 |
| assistant-intent；final-public.log 57项 + clarification-fixed.log 1项 | 58 | 查询/规划/执行边界、普通短提示、连续修改、必要澄清与零RPC收尾通过 |
| 合计（不重复累计） | 161 | 定向通过 |

上表日志短名统一加opt44-前缀，例如final-public.log为opt44-final-public.log。final-public首次整组为91/92；唯一已保存澄清回执恢复失败，经共享判据修复后只复测该项，1/1且0模型请求。未以重跑整组增加通过数。

- R44-1：纯决策精确验证5000/9999/10000/10001ms；HTTP从读取到控制、领取再次跨过截止时间时，拒绝同段RPC。HTTP的时间自然流逝可能把恰好预留边界变成关联续段或拒绝，精确等号由可控时钟断言。
- R44-2/3：同段原起止时间不变；关联段保留旧预算快照，新窗口不超过80秒/冻结15秒；普通“继续规划”保存物流3＋地址2并保留时间要求，0个processing_run。已有第一份草稿回执只新建剩余第二份。
- R44-4：区间单元明确排除等待、重复快照增量为0；HTTP实际新增活跃时间小于10000ms而非旧30秒等待，重复读取预算逐字相同；修复/故障/传输偏移与自动事件消耗保留。真实Worker完成不重置原执行预算。
- R44-5：并发两次恢复只有一次成功排队，turn数量只增加1；同段/跨段完成后原key重放200、同turnId，异内容409、0新增模型请求与预算；未知写返回已创建草稿原回执。
- R44-6：停止、新修订、撤权、背景hash变更均拒绝；挂起的纠错响应返回后不能保存旧要求；背景失效时readSession.canContinueExecution=false，execute_plan/resume均409且无新增轮次/请求。
- R44-7：关联段携带parent/root、原修改、首次失败和逐尝试观察；单元区分实际模型Timeout与请求未发出的预算拒绝；缺关键预算旧状态拒绝，已知旧lastTurn消耗/可验证别名背景hash兼容读取，不写回或猜造。
- R44-8：现有HTTP、SDK、Worker与持久事件直接调用共享决策；未另写模拟编排器。真实Worker固定清洗1条，不发真实模型请求，处理后只自动核对一次；最终确认完成不被事件上限改回未完成。

## 4. 失败、修复与审阅

保留所有过程失败日志，不把自动纠正/补修后成功称为首次成功。

- red.log：新共享模块尚未实现时单元失败。
- public-first/plan-second/public-second：先暴露旧保存回执过早收尾、别名/真实背景hash不一致、同名不同步骤误当重试；分别修复后定向转绿。
- compat-intent.log：初次56/58，修复新物质要求被旧pending状态拦截；旧“继续”耗尽应在入口409，调整该拒绝预期而非放宽预算。
- review-red/revision-red：两轴审阅发现的背景失效仍可执行、裁剪造成虚假进展、普通继续跳过修订校验均先红；完成态幂等映射同批补齐。最终新HTTP26项全绿。
- events-red/final-events：补齐旧测试缺失的真实授权/窗口/检查点；移除旧重复分支后，又暴露重复拒绝覆盖原限额原因、最终确认被改成waiting_input；修复后events-second 8/8。
- worker-current：新增真实Worker夹具首次advancePlan调用传错修订参数；纠正夹具后worker-second 1/1，再纳入final-public 26/26。
- cap-red与final-budget：上限内已预留提交边界先红，补修后测试还需正确携带lastTurn高水位；budget-final-green 27/27，最终新23项再次通过。
- static-first/second/final/static-complete保留类型及lint失败；最终static-green EXIT:0。包含类型检查、tsconfig.server编译、受影响文件eslint与git diff --check；receipts新增文件另跑eslint通过。Prettier对变更文件通过。

文档校验：npm run docs:check通过38条生命周期/提交/Gate状态检查；7份变更Markdown新增7个相对链接均可解析，表格/围栏检查通过，JSON/Mermaid块未变更，无需重绘流程图。

一次Standards/Spec并行审阅（opt44_standards_review、opt44_spec_review）确认3个不同P1（两轴均发现执行资格残留；另有虚假进展、修订/幂等早返）。全部修复并由原审阅者定向复核关闭。最后savedPlanningQuestion共享判据亦经Spec定向复核，无新增发现；不重复整票审阅。

旧测试限制：旧assistant-tasks文件抽取9项时8失败，保留worker-compat.log；固定eb08e13隔离副本运行首项同样失败，见worker-baseline.log。该旧模型夹具在首轮直接submit_processing，未遵循现有control入口；后续项又共享前项runId等状态。因此这组旧失败不计入通过数，也不把全部8项未经逐一隔离归因地标成已修复。本票直接受影响的Worker/事件合同由新增真实处理完成用例及8项持久事件覆盖；旧测试文件未整批迁移。

## 5. 数据、预算与后续边界

所有DB测试只使用evalbase-agent-test-postgres-1上随机新建测试数据库，结束DROP自身数据库；对象存储只用evalbase-agent-test-minio-1的测试桶evalbase-opt43-tests。模型服务为本地合成HTTP，不使用真实端点/key。未连接Owner数据库执行SQL，未重启/更新Owner容器；运行镜像只读核对仍为92492e7a7b2a。未运行旧248/400条、未重置其预算或重复已完成部分。

本票没有验证任意自然语言稳定性、内容质量或页面全流程；OPT-31原质量未通过与历史失败保持。下一阶段OPT-45接入新的恢复动作与失败刷新，并按独立上限做五项Computer Use；不自动复用/重置旧验证额度。
