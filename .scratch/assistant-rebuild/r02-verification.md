# REBUILD-02 实施与定向验证记录

- 日期：2026-10-27；分支：`codex/assistant-rebuild`。
- 实施/审阅基线：`013efa9`；实现提交：`21038e780b1d474318a6763ce811d385be3871e8`。
- 结论：R02-1～9 定向通过（targeted-pass），不代表完整助手或全部重建验收通过。
- 合同：[票据](issues/02-deepagents-session-and-tool-host.md)、[Spec](spec.md)、[重建架构](../../docs/architecture/assistant-rebuild.md)。

## 实现与能力边界

新增正式入口为 /api/projects/:projectId/assistant-runtime/sessions，以及会话读取和 /messages。认证用户/项目由 HTTP 服务端绑定，CSRF 和当前权限继续生效；会话私有归属不可由请求或模型更换。服务端 SessionStore 与正式工具共用严格 Zod 要求/来源合同，纯处理约束及实际来源读取复用 REBUILD-01 迁出的业务服务。没有依赖升级或前端改动。

消息提交在一个事务内保存用户消息、全局稳定提交标识/作用域载荷摘要、pending 执行引用及会话修订。已知提交重放先于忙碌/旧修订检查；不同载荷或作用域拒绝，不同标识的相同文字仍是新请求。并发受理仅一个获胜，失败方不残留已受理消息。runner token 与 runtime_version 绑定服务端执行归属；模型不能提供或读取令牌。权限撤销后禁止成功提交，但原执行可以凭同一令牌完成失败清理，避免会话卡在 running。

正式 HTTP 目前返回持久受理回执，**不会自动派发模型执行**。本票使用可信 runPending 受控执行器接真实 Deep Agents/LangGraph；后续 REBUILD-03 接唯一执行、租约/恢复、确认与预算，REBUILD-04 接页面发送和重发。未把 pending 受理描述为业务成功，也未用旧执行器兜底。

当前工具允许清单为 read_project、list_sources、read_records、update_requirements。查看权限不开放草稿目录和要求写入；每次工具访问复检权限/来源。目录有界分页，草稿及其父测试集/父版本、删除锁由共享 processingSourceRows 判定；保存目标还必须 editing，且在要求提交事务复检。已取消交付仅可保留相同历史目标，不能据此启用失效目标。

要求只有一份当前事实和服务端稳定交付 ID；支持名称、来源固定记录、数量、字段、分类、保存目标的局部修改及交付取消。未给字段保留；同要求不产生新修订。无统一 count≤10 限制，沿用现有业务上限。只规划不会建业务草稿或作业；实际处理、采用、发布仍未开放。模型自然语言标为 model_explanation / isBusinessReceipt:false，真正要求保存由事务事件回执核对。

正式路径替换验证专用参数反馈，只有一条有限纠错路径（最多两次反馈）。合法字段、来源/范围、分类及保存目标不得在纠错时变化；数字字符串仅可无损纠正，不能删除错误字段掩盖要求。无法安全修复的截断修改调用失败并保留输入；简单只读截断可安全重试。业务冲突/撤权不当成参数问题，也不擅自换新修订。任意 shell、文件系统、网络、SQL、委派工具不在允许清单。

保留框架摘要机制，每次普通模型调用补入当前权威事实。安装版本的摘要使用 request.model，采用上下文标记区分摘要与普通/纠正实际 HTTP 尝试，避免遗漏同一模型实例的摘要请求。计量钩子保存尝试 ID、关联调用、种类、状态及 usage；供应方未返回 usage 时明确 null，不虚构 token。无隐式模型 HTTP 重试。

## AC 与实际证据

| 条款 | 回归证据与结果 |
| --- | --- |
| R02-1 | 独立正式路由、无 campaign 环境；旧 executeAssistantTurn 被测试替换为抛错，实际 SDK 仍能查询/保存要求；旧规划编译不接新路径。 |
| R02-2 | 真实项目/资料读取，无前置计划；400+2 两份要求保存、修改、刷新唯一事实，同义不改修订；业务草稿/处理作业数量不变。 |
| R02-3 | 真实 SDK→本地 HTTP→解析/Schema→工具→事务覆盖中文嵌套、未知字段、类型、截断、非法对象；纠正身份关联，拒绝改变来源/数量/分类/目标、删除错误数量和口头替代。 |
| R02-4 | 两份交付增改取消保留 ID，不用数组位置或模型生成新 ID；400 条要求合法，未来动作明确未接入。 |
| R02-5 | 触发真实框架摘要，以恶意旧摘要验证当前要求仍权威；普通/纠正/摘要实际请求均留事件，无 usage 和503路径如实记录。 |
| R02-6 | 枚举工具与角色；真实 SDK 请求 read_file/write_file/task 均拒绝；输出解释不被标为业务回执。 |
| R02-7 | HTTP 同标识重放跨忙碌/旧修订，变载荷及跨项目/用户/会话拒绝；新标识同文字正常受理。 |
| R02-8 | 双标签并发、提交前故障回滚、提交后响应丢失重放、持久 pending 和唯一 claim；失败不残留消息，晚响应/旧 runner 不写成功。完整进程恢复仍归03。 |
| R02-9 | 同一真实资料固定3条后，仅修改清洗问题字段，期望输出/Metadata、来源和范围、分类/保存目标均保留；无业务作业副作用，执行补证归07。 |

## 命令与结果

使用 Node 24、仓库锁定的 SDK、真实业务 HTTP/数据库/对象存储；模型供应方为本地可控 HTTP，外部模型请求和 CU 均为0。执行封装为 r02-verification/run-directed.py，原始日志保留在该目录且不进入产品源码。每次集成运行创建唯一 formal_session_* 隔离库并清理，不迁移验收库。

| 检查 | 结果 | 原始记录（同目录 r02-verification/） |
| --- | --- | --- |
| Vitest run tests/integration/rebuild-session.test.ts tests/unit/rebuild-session-contract.test.ts | 最终36通过 / 2文件（34集成、2单元），11.45s | session-final.log、session-final.exit |
| 先前合并定向：上述新会话合同 + tests/integration/assistant-rebuild-validation.test.ts、tests/integration/rebuild-business-boundary.test.ts、tests/unit/rebuild-business-imports.test.ts | 当轮67通过 / 5文件；其中相邻既有35项（28+6+1）复用未改变证据；新会话之后已按上一行重验，不重复相加 | directed-final.log |
| 父对象可用性 red→green；-t 'shared parent availability'，之后连同 existing draft save targets、directory/record、field-only | 初次真实复现不应受理却 saved:true；修复后4通过、30按筛选跳过，7.03s | parent-red.log、parent-green.log |
| node node_modules/typescript/bin/tsc --noEmit | 最终通过 | typecheck-final3.log |
| node node_modules/eslint/bin/eslint.js（本票12个TS文件） | 最终通过 | lint-final3.log |
| 仓库 scripts/check-docs.mjs + 本次Markdown链接/锚点/表格/围栏/JSON及10票生命周期检查 | 通过 | docs-final.log、markdown-final.log |
| git diff --check / git diff --cached --check | 通过 | diff-final.log、提交前检查 |

以上不同轮次存在覆盖重叠，不将通过数相加成独立测试数量。不重跑现有验收的已完成用例；未运行完整库、真实模型普通提示或 Computer Use，因此不声称这些已通过。

### 首错、修复与干预

- 初始测试准备曾缺上传幂等键；提前失败后的可选 provider 清理又等待超时。修正夹具/清理，核实并仅移除该次唯一隔离 formal_session 库，未接触旧验收数据。这不是产品模型超时。
- 首轮19项中，SDK middleware 包装导致可信业务错误码未贯穿，摘要实际请求误归普通类。沿可信 cause 解包错误码；按安装 SDK 的真实摘要调用点修正计量。最终受控链路已覆盖。
- 负向边界首先复现：无效手选记录被受理、角色降权后能力投影陈旧、50→51 的有损参数纠正、撤权后任务未失败清理。补齐实际入口校验及身份清理，并增加删除错误数量、非法对象和越权工具测试，未降低断言。
- Spec 审阅发现已有草稿保存目标只校验 ID 形状。target-red2 复现；补本项目/编辑状态/删除锁及取消历史引用例外，再由 parent-red 复现遗漏父对象状态。最终复用共享来源可用性，目录与提交一致，合法目标和取消仍通过。target-red 的首次 operation_id 夹具错误单独保留，不当作产品复现。
- 最终静态检查发现共用 ProcessingSource 类型需显式 recordIds:[]（仅对象可用性查询，无输入范围变更）；补齐后类型与最终36项均通过。
- 以上是开发期故障注入、修复与回归，不是实际用户一次无干预成功率，也不保证模型永无参数错误。

## 审阅与关闭

- Standards：基线013efa9及冻结R02完整补丁 SHA256 4b20c6253f7b5d88250c8ac8b2554a84cd1cb71acc6dd9708fc9563644e6fe90，独立审阅无可行动问题。
- Spec：完整审阅R02-1～9，仅1项P2保存目标可用性。修复后冻结增量 SHA256 1b4ab588776a6f3e7de5bdc0001074847ce86c78346ea0aba5cf46afd013eecd，命名问题针对性复审确认已解决、无新增问题。随后仅补上述共享类型所需空 recordIds，语义不变，最终类型和集成重验通过。复审代理只读，实际命令由主执行者运行。
- 适用关闭项：认证/项目/角色、会话及调用归属、参数纠错、事务受理/回执重放、撤权与迟到响应、只规划无副作用、增量迁移重复执行、旧预算保留。未执行生产迁移或环境切换。
- **Ticket Closure Review P0/P1 cleared at 21038e780b1d474318a6763ce811d385be3871e8**。本票发现的P2也已关闭；既有旧助手失败仍按01后续记录及对应领域票保留，不改记全绿。

## 保留与后续

重复迁移回归核对合成 old-r02-sentinel 活动的已耗请求/行数、上限和 closed_at 不变；不创建真实活动，不重置任何旧预算。所有新测试只在唯一隔离库/合成数据中执行。现有4217、旧会话/成果/验收记录和预算未修改，未部署、合并或推送。

下一张为 REBUILD-03，接正式持久派发、执行授权/确认、暂停恢复、无进展与分层预算；随后04接页面。02的检查点/单次claim/计量钩子是这些功能的接线点，不冒充它们已经完成。
