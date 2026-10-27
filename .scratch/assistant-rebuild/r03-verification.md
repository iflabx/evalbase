# REBUILD-03 实施与定向验证记录

- 日期：2026-10-27；分支：`codex/assistant-rebuild`。
- 实施/审阅基线：`b232532`；实现提交：`bb10a16177423ed7b0134b7b1bb4cfb206b5b8c9`。
- 结论：R03-1～8 定向通过（targeted-pass）。不是完整助手、全部领域工具或普通提示页面验收通过。
- 合同：[票据](issues/03-durable-execution-confirmations-and-budget.md)、[Spec §3.1/3.2](spec.md#message-submission)、[重建架构](../../docs/architecture/assistant-rebuild.md)。

## 实现与责任边界

正式 HTTP 受理后，由应用启动的持久派发器领取既有 assistant_runtime_turn。数据库中的原消息/提交标识、turn、操作键和账本保持关联；不新增消息队列或步骤规划器。多宿主用同一会话锁、租约和 runner token 竞争归属；受理后派发前退出、运行归属过期均沿原 turn 恢复，不再追加用户消息。回合使用 LangGraph 检查点，恢复通过原检查点的 null 或 Command/resume；新回合仅载入有界消息上下文和当前权威事实，不能把旧工具中断误当新用户要求。

停止走独立 control API，先在事务中撤销 token，记录暂停事实并保留已耗请求；本机中止在途请求，其他宿主的迟到响应/写入也受持久令牌保护。查询是只读投影，不启动模型；普通继续沿同一 turn、任务和账本，不自动加额。暂停时结束在途消耗的观察窗口，人停留时间不叠加到旧单次请求时限。实际 Worker 的固定输入/批次和重试保护继续复用，明确继续时只恢复可重试的未完成部分；已完成批次不另建作业重跑。

处理提交通过服务端 operationScope 将稳定操作、run/job 与执行关联保存。已有作业才开放无参数 wait_processing；已有固定操作才开放 wait_confirmation。二者使用框架 interrupt，正常等待不记参数失败，不用模型轮询。派发器从业务终态补查，通知丢失/重复只推进一次；暂停、要求修订变更和撤权不会错误唤醒。

固定确认包含本人/项目、动作、操作 ID、冻结输入/结果范围/目标、要求修订和有效期。确认及追加额度只在认证/CSRF 用户路由执行，不作为模型工具注册。本票接通真实 acceptProcessingResults 证明采用：processing_acceptance 与实际业务修改同事务；确认缓存或检查点丢失时核对同一操作回执。双击只返回同一待提交/已提交身份，变参数不复用旧键。确认尾部仅在旧 token 仍持有 turn 时推进调度；已提交回执可以保留，不能清除新所有者租约。采用之外的发布、删除和管理执行由领域票接线，不能用本票的确认存储声称它们已开放。

执行终态、assistant 消息、turn 终态和 session 收尾在一个事务提交，避免 completed/NULL lease 与 running turn 的不可恢复夹缝。收尾故障全部回滚。业务回执独立于可选模型总结；只读投影标记当前与历史回执，历史保存不回填为新要求成功，也不因总结失败丢掉已保存事实。

任务授权/累计消耗采用独立正式账本，不引用旧验收 campaign。初始上限复用中立共享常量，不采用本票测试的小阈值作为生产默认值。模型 HTTP 边界先受理一次尝试，再记录响应状态、usage 或未知结果；正文、纠错、真实框架摘要及实际重试均经过同一边界，未知请求不退还。Worker 实际供应方请求独立统计，继续受既有处理预算保护，并与助手共用可选外层活动封顶。输出容量、摘要阈值、图步数、单请求时间、任务限额和活动限额不混为一项；首次请求及 Worker 在途也受活动剩余时间约束。追加仅采用服务端固定有效 offer，用户确认后增量记 grant，旧累计不清零；活动关闭不能通过继续或追加任务授权绕过。

有效进展保存为真实对象/记录内容事实，而不是事件序号或工具调用 ID。资产记录以其全局限定记录身份及实际返回内容判重，忽略无关请求集合；草稿/版本保留对应来源身份。重复读取/失败不算新进展，实际分页/新记录/要求变更/业务终态才推进。连续3个无进展观察点暂停，跨分段、摘要、重启、普通继续及追加授权保留计数；真实要求修改才开新窗口。暂停后可提交新消息修改要求，账本保持；原回合恢复继承纠错快照和次数，新明确用户提交按新意图处理，不继承上一回合的参数纠错约束。

新增 API 均在 /api/projects/:projectId/assistant-runtime/sessions 下：control、budget-offer、confirmations/:confirmationId。正式启动默认派发；仅受控测试显式关闭自动派发，以在既定故障边界手动领取。没有新模型、依赖升级、前端样式或旧运行时回落。

## AC 与实际证据

| 条款 | 覆盖与结果 |
| --- | --- |
| R03-1 | 真实采用服务提交后注入响应丢失，再按同操作回执恢复；只有一份草稿/回执，变参数拒绝；执行终态提交间隙故障完整回滚。 |
| R03-2 | 真实创建处理 run/job、规则清洗 Worker、框架 wait interrupt；换宿主补查终态、重复 wake 只推进一次，等待模型请求不增加；暂停/改要求不唤醒。 |
| R03-3 | 本地真实 HTTP 请求在途停止，查询无费用，超过测试旧请求时限后恢复同任务；旧 proof 写入拒绝；成功批次及产物保持，不重新生成。 |
| R03-4 | 双击、过期/变修订卡、跨用户/项目、撤权、目标草稿修订变化及提交后未知结果；真实回执恢复；模型不开放确认/加额工具。 |
| R03-5 | 多图分段、真实摘要、参数纠错、单请求超时、200后正文超时、未知归属、任务耗尽、明确 offer 增额、外层首次及 Worker 在途封顶；账本可核对，暂停/查询不加费。 |
| R03-6 | generated/confirmation/saved 与执行状态分开投影；真实采用后503总结失败仍保留 saved/回执；历史回执不冒充当前成功；interrupt 生命周期不误记参数失败。 |
| R03-7 | SDK 重复读取至3次无进展、跨重启/摘要和继续拒绝；记录排列、额外未使用资产不能伪造进展；实际分页和真实要求修改可推进，预算保持。 |
| R03-8 | 公开消息受理后未派发恢复、双宿主与同消息重发竞争、租约过期/迟到响应、提交前失败；仅一个有效执行/消息收尾，已发未知请求仍入账。 |

## 命令与结果

使用 Node 24、锁定的 Deep Agents/LangGraph/LangChain、真实 AI SDK Worker、真实 HTTP/数据库/对象存储。供应方是本地可控服务，**外部模型请求0、真实CU0**。每个集成文件创建唯一 formal_execution/formal_session 等隔离库，测试材料为合成数据；不迁移或清空现有验收数据库/对象卷。执行封装与原始日志位于 r03-verification/，保留且不进入产品源码。

| 检查 | 结果 | 原始记录（r03-verification/） |
| --- | --- | --- |
| Vitest run tests/integration/rebuild-execution.test.ts（最终版本） | 31通过，15.79s | execution-close.log |
| Vitest run tests/integration/rebuild-execution.test.ts tests/integration/rebuild-session.test.ts tests/unit/rebuild-session-contract.test.ts（首轮审阅修复后） | 65通过 / 3文件；当时执行组29项，后续2项见上一行及下行 | final-contracts.log |
| 最后等价来源集合、暂停新意图及相邻进展/原回合纠错的命名复测 | 6通过、25按筛选跳过；不得写为31项都在该轮运行 | equivalence-feedback-final.log |
| tests/integration/rebuild-business-boundary.test.ts、assistant-rebuild-validation.test.ts、processing-runs.test.ts；tests/unit/rebuild-business-imports.test.ts | 60通过 / 4文件，47.71s | adjacent-regressions.log |
| node node_modules/typescript/bin/tsc --noEmit | 最终通过 | typecheck-close2.log |
| node node_modules/eslint/bin/eslint.js（受影响15个TS文件）及最后改动文件复核 | 通过 | lint-close.log、lint-close2.log |
| git diff --check、git diff --cached --check | 通过 | 提交前检查 |

各轮存在重叠，不相加为独立测试数量。受控窗口使用70～180ms请求阈值、60ms活动、少量请求和8图步等缩小值；这些只用于确定性边界，不更改生产默认值。执行中暂停记录在请求 started_at/ended_at 和 execution_paused 事件中，不把任务完成后点停止当作在途暂停。

### 首错与修复

- 首个优先停止回归实际404，新增控制入口后通过。最初实现还出现新增表先于 processing_run 创建的迁移错误，已将执行 DDL 放到处理表之后；重复迁移与旧预算哨兵仍通过。
- 受控链先发现跨宿主停止后迟到响应错误收尾、进展事实含 undefined、运行时处理缺少 manual-v1 背景合同；已在共享边界修复。部分准备失败是遗漏固定记录范围、猜测候选ID、错误账号列名或语法/类型遗漏，已改为读取真实服务结果，未降低业务断言。
- 首次超时测试暴露SDK包装错误与HTTP实际超时不一致；以HTTP AbortSignal事实分类并留账，不再依赖SDK包装名称。后续补200响应头后正文超时，不能吞异常记为成功。
- 审阅发现终态跨事务窗口、旧确认清新租约、外层首次/Worker时间限额遗漏、paused要求修改被拒绝和等价范围计进展；统一修复并加故障/竞争/SDK回归。后续命名复查又补实际同一记录在不同资产集合中仍等价，以及新回合不继承旧纠错约束。
- 自查修正 outcome 与 claim 的锁序反转为 execution→request；独立连接持有 execution 锁时，完成回调不会先占有 request 锁的 NOWAIT 回归通过。
- 上述为开发受控故障与技术修复，不是用户一次无干预成功率。未换真实模型、扩大真实预算或重跑旧已通过验收项，也未更改旧助手失败的历史结论。

## 审阅与关闭

- Standards：冻结完整补丁 SHA256 3dd7c919f905cb31e2ebe1b93de901924bbaca6d25f7fe7623379b98abee5bad，同次审阅发现4项（与Spec部分重叠）；原项经命名复查关闭，复查新增的旧回合纠错约束问题也已关闭。未要求按文件大小重写或加入新平台。
- Spec：同一冻结补丁核对R03-1～8发现5项；通过增量1086c7ed93503fb84657eecbd591f4e28eb29d800caac034083878017e67f5a8及最终35250924ca0d1405d9d27eacec5a490e8c69d4ec11b4b094d8d13bf0ed2d9239针对性复审，原5项均关闭，无新增发现。复审代理只读，真实命令由主执行者运行。
- 同一审阅覆盖认证/权限、停止与迟到写、确认并发、持久化、未知回执/请求、预算、锁序和增量迁移；未另设重复完整审阅。
- **Ticket Closure Review P0/P1 cleared at bb10a16177423ed7b0134b7b1bb4cfb206b5b8c9**。已发现P2也已关闭。此结论仅针对本票，不签署完整产品或Owner验收通过。

## 保留与后续

现有验收数据、旧会话/成果、旧预算及关闭时间保持；测试只在独立合成数据中运行，迁移重复执行核对 old-r03-sentinel 与R02旧预算哨兵。新正式账本不复制或重开旧活动。没有更新4217、正式部署、合并或推送。

下一张 REBUILD-04 接正式页面、流式反馈和受控动作桥，并按票取得C01/C02普通提示证据；完整领域接线及最终C07仍按后票依赖/预算。没有提前消费这些真实活动，也不把本票的31项SDK/HTTP回归写成Computer Use通过。
