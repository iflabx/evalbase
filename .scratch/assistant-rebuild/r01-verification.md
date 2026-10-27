# REBUILD-01 实施与定向验证记录

- 日期：2026-10-27；分支：`codex/assistant-rebuild`。
- 审阅/实施基线：`09b070a`；实现提交：`6f97cd9c059365ac441f3200168fec496e7bf07f`。
- 结论：本票五项 AC 的定向验证通过（targeted-pass）。扩大回归仍有 14 项基线已有失败，不能据此宣称全库或整个助手已通过验收。
- 合同：[票据](issues/01-business-contracts-and-commit-boundary.md)、[Spec](spec.md)、[架构 §3](../../docs/architecture/assistant-rebuild.md#3-必须解耦的现有调用点)。

## 实现与责任边界

共用提交保护位于 src/operations/commit.ts。人工 HTTP、旧兼容入口、新运行时工具复用身份、项目权限及事务内复检；服务端通过不可序列化的能力上下文绑定调用来源，异步调用上下文防止嵌套函数漏传证明而降为人工调用。提交仍使用已有操作键、参数摘要和回执，未新增调度器、数据库表或公开 API。

迁出实际调用者为 drafts/create、selection/store、processing/store/accept/refine、version/publish-sparse 和版本路由。纯字段/数量/Metadata 约束、背景快照及提取移到 processing/；BusinessError 移到 operations/。业务入口不再导入旧计划/任务推进模块。受控导入测试将旧计划/任务模块置为不可用后加载实际业务入口和新宿主；真实人工闭环将旧派发函数置为抛错，仍完成上传、映射、选取、规则清洗、采用、发布及下载。

旧 assistant/fence 是明确的兼容适配器，保留旧任务证明、计划背景冻结、多组结果范围与关联；旧 agent 在边界绑定它，新路径不调用它。旧 requirements/store/extract-background 保留兼容导出。仅类型引用不当作运行时执行；旧来源可用性查询及历史 session 外键仍保留，不能把历史字段删除等同于解耦。新运行时通过独立适配器绑定现有运行/操作证明、背景和回执；固定证明创建后不能被调用者修改，暂停控制能力仅能取消，不能写业务。

回收站读取改为管理员管理权限。提交时撤权/修订变化仍拒绝；统一 HTTP 错误映射保留可信业务 4xx 与错误码，不泄露内部 hint。首次发布及派生版本发布的拒绝会回滚，随后合法重试成功，父版本 CSV 和原始文件保持。

## AC 与证据

| 条款 | 实际入口与覆盖 | 结果 |
| --- | --- | --- |
| R01-1 / RB01 | 实际业务入口、新宿主导入；旧派发禁用的人工 HTTP/Worker 闭环；旧薄适配单独定位 | 通过 |
| R01-2 / RB03 | 同项目管理员/编辑/查看、跨项目；人工/新运行时/旧适配；伪造、序列化、漏传、跨会话和证明变更 | 通过 |
| R01-3 / RB03、V08 公共部分 | GET 回收站管理员 200，编辑/查看/跨项目 404；撤权/旧修订拒绝；发布提交故障回滚 | 通过 |
| R01-4 / RB06 公共部分 | 建草稿、选取、采用回执重放与变参冲突；发布确认撤销两种竞争；原件/父版本不变 | 通过；完整持久恢复归03 |
| R01-5 / RB14 公共部分 | 真正上传/映射→固定选取→规则清洗 Worker→采用→首次/派生发布→下载；旧派发不可执行 | 通过；全能力接入未宣称完成 |

## 命令与结果

测试使用安装的 Node 24、真实业务 HTTP/数据库/对象存储/Worker、真实 Deep Agents/LangGraph SDK；供应方响应由本地受控 HTTP 返回。集成测试按现有机制创建唯一隔离数据库和合成对象，不使用现有验收业务数据。执行封装为服务器工作树中的 `r01-verification/run-directed.py`；原始日志保留于同目录，不纳入产品源码。

| 检查 / 命令（Vitest run 后的参数） | 结果 | 原始记录 |
| --- | --- | --- |
| tests/integration/rebuild-business-boundary.test.ts tests/integration/assistant-rebuild-validation.test.ts tests/unit/rebuild-business-imports.test.ts | 35通过 / 3文件；真实 SDK 和新边界 | business-sdk-final.log |
| tests/integration/rebuild-business-boundary.test.ts（错误映射修复后重跑） | 6通过；含首次与派生发布提交拒绝、回滚、重试 | http-error-green.log |
| tests/integration/project-assistant.test.ts -t 'OPT-22 revokes a claimed confirmation' | 2通过，326按筛选跳过；不是328项全通过 | legacy-publication-race.log |
| 相邻11文件：选取、协作草稿、背景、处理协议/审核/去重、处理作业/轮次、旧预检 | 212通过、14失败、1跳过，另6个夹具未处理异常；见下节 | domain-regressions.log |
| 基线09b070a仅重跑上述失败的3文件，相同隔离基础设施及依赖 | 89通过、16失败；本轮14个失败名称全部基线已有，新增失败名称0 | baseline-domain.json、baseline-comparison.json |
| node node_modules/typescript/bin/tsc --noEmit | 通过 | typecheck-close.log |
| node node_modules/eslint/bin/eslint.js（本票36个TS文件） | 通过 | lint-close.log |
| git diff --check | 通过 | 提交前检查 |

11文件分别为 integration/processing-runs、assistant-processing-preflight、processing-task-rounds、v2-collaborative-draft、data-selection，以及 unit/assistant-background、processing-content-review、processing-review、processing-protocol、data-selection、processing-deduplication（均为 .test.ts）。各轮有重叠，不把通过数相加为独立覆盖数。错误映射修复只影响 HTTP 错误返回，其六项回归及静态检查已重验；其余未改变路径复用前轮证据。

### 首错、修复与技术干预

- 回收站基线复现：编辑账号可读，实际200、预期404；修复管理权限后通过。最早两次运行曾因账号 displayName 夹具不合法失败，属于测试准备错误，未记作产品缺陷。
- 新能力证明接入后，旧 SDK 测试仍手工构造裸 scope；改用真实服务端 factory。F07 还存在把 idle 当作异步要求已提交的夹具竞争，改为等待已持久化要求；没有删除业务断言。
- 审阅发现并复现发布提交错误返回500；先保留失败记录 http-error-red2.log，再补共享错误映射，http-error-green.log 通过。
- 此处均为开发中的受控故障和修复，不是用户提示后自动纠正率，也不是一次无干预真实模型成功。

### 未关闭的基线问题

14项分布：旧 assistant-processing-preflight 6项（组合字段要求、缩小范围、仅退款、排除退款、发现失败后继续、显式新文件名），processing-runs 2项（记录来源链、跨批扩充补齐），processing-task-rounds 6项（缺项改写、基础设施恢复、前轮候选、去重反馈/时限、扩充追加、当轮缺项计数）。完整名称保存在 baseline-comparison.json。

旧轮次测试的本地 Provider 夹具对 inputs 形状假设触发 undefined.map，形成额外未处理异常/超时；其余含旧发现/规划及处理结果断言失败。基线重跑复现全部14项失败；基线还多两项忙碌时序失败，不将其差异解释为稳定性提升。未在本票顺带修复旧自然语言规划或扩大成内容质量整改。此比较说明未发现新增失败，不能证明这些基线问题无业务影响，更不能把扩大回归标绿。

## Standards / Spec 审阅与关闭

- Standards：冻结基线09b070a及包含新文件的工作树补丁，审阅摘要 b439b942c572ef8d1fdd36404b4a276246979ca3f0bc44bb89077e1b0b65ea80。发现1项P2：提交撤权错误变成HTTP500；已修复并完成命名问题的针对性复审，无残留该项问题。复审代理阅读代码和测试；实际红绿验证由主执行者运行。
- Spec：独立审阅R01-1～5、范围和边界，未发现遗漏；后续完整会话/持久执行及领域工具仍归后票。错误映射补强未扩大产品范围，沿用未改变面的审查证据。
- 适用关闭矩阵覆盖共享授权、稳定错误、取消/撤权、回执重放、提交回滚、不可变历史及实际共同调用者；无迁移、永久删除或环境切换。
- **Ticket Closure Review P0/P1 cleared at 6f97cd9c059365ac441f3200168fec496e7bf07f**。仅针对本票合同；上述14项旧失败继续公开保留，本结论不代表全库验收通过。

## 保留与后续边界

外部模型请求0、真实生成0、Computer Use 0；本票不建立或重开真实活动，不改变旧预算、关闭时间和旧验收成果。测试只清理自己唯一命名的隔离数据库/合成材料。未更新4217、修改运行环境、合并或推送。

02负责正式会话/工具宿主；03负责正式检查点、确认、唯一执行及完整预算恢复；05～09负责领域能力与历史生命周期。新宿主目前仍是适配验证入口，本票不冒充正式接入完成，不提前开放尚未支持的选取/发布确认。前端、依赖锁、数据库迁移和主流程图未改。
